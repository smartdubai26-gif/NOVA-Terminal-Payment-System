import { createClient } from '@supabase/supabase-js';
import { TronWeb } from 'tronweb';
import * as dotenv from 'dotenv';
import { resolveHotWalletPrivateKey } from './cryptoKey';
import { recordWorkerAuditLog, sanitizeErrorMessage } from './auditLog';
import { sendWorkerAlert } from './alerts';
import { screenWithdrawalDestination } from './aml';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TRON_FULL_HOST = process.env.TRON_FULL_HOST || 'https://api.trongrid.io';
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || '';
const USDT_CONTRACT =
  process.env.USDT_CONTRACT_ADDRESS || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const MAX_BROADCAST_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = Math.max(250, Number(process.env.WITHDRAWAL_RETRY_BASE_MS) || 2000);
const POLL_FAILURE_ALERT_THRESHOLD = Math.max(
  1,
  Number(process.env.POLL_FAILURE_ALERT_THRESHOLD) || 3
);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured.');
}

// 1. Initialize Supabase client with Server Service Role privileges
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// 2. Decrypt/load TRON hot wallet private key securely (never logged)
const hotWalletResolution = resolveHotWalletPrivateKey(process.env);
const tronWeb = new TronWeb({
  fullHost: TRON_FULL_HOST,
  headers: TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : undefined,
  privateKey: hotWalletResolution.privateKey,
});

interface TronGridTrc20Tx {
  transaction_id: string;
  value: string;
  block_timestamp?: number;
}

interface TronGridResponse {
  data?: TronGridTrc20Tx[];
  success?: boolean;
  error?: string;
}

interface DepositAddressRow {
  id: string;
  address: string;
  wallet_id: string;
  last_polled_timestamp_ms?: number | null;
  wallets: { terminal_id?: string } | { terminal_id?: string }[] | null;
}

// Fallback cursor map used only if migration 004 (`last_polled_timestamp_ms`) is not yet applied
const memoryCursorFallback = new Map<string, number>();
let depositSchemaSupportsCursor = true;
let withdrawalSchemaSupportsRetryCols = true;
let consecutivePollFailures = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffDelayMs(attempt: number): number {
  const exp = RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return exp + jitter;
}

async function updateDepositPollingCheckpoint(
  cursorMs: number,
  failures: number,
  lastError: string | null
): Promise<void> {
  try {
    await supabase.from('worker_checkpoints').upsert(
      {
        worker_key: 'tron_deposit_watcher',
        cursor_ms: cursorMs,
        consecutive_failures: failures,
        last_error: lastError,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'worker_key' }
    );
  } catch {
    // Checkpoint table may not exist prior to migration 004; ignore gracefully
  }
}

/**
 * Monitor incoming USDT (TRC-20) deposits to registered customer addresses
 * using persisted `min_timestamp` cursors so restarts never miss transactions.
 */
async function watchDeposits(): Promise<void> {
  try {
    let addresses: DepositAddressRow[] | null = null;

    if (depositSchemaSupportsCursor) {
      const res = await supabase
        .from('deposit_addresses')
        .select('id, address, wallet_id, last_polled_timestamp_ms, wallets(terminal_id)')
        .eq('network', 'TRC20');

      if (res.error) {
        if (res.error.message.includes('last_polled_timestamp_ms')) {
          depositSchemaSupportsCursor = false;
          console.warn(
            '[WATCHER] Column deposit_addresses.last_polled_timestamp_ms not found; using in-memory cursor fallback until migration 004 is applied.'
          );
        } else {
          throw new Error(`Supabase deposit_addresses query failed: ${res.error.message}`);
        }
      } else {
        addresses = res.data as DepositAddressRow[];
      }
    }

    if (!depositSchemaSupportsCursor) {
      const res = await supabase
        .from('deposit_addresses')
        .select('id, address, wallet_id, wallets(terminal_id)')
        .eq('network', 'TRC20');
      if (res.error) {
        throw new Error(`Supabase deposit_addresses query failed: ${res.error.message}`);
      }
      addresses = res.data as DepositAddressRow[];
    }

    if (!addresses || addresses.length === 0) {
      consecutivePollFailures = 0;
      return;
    }

    let highestGlobalCursorMs = 0;

    for (const item of addresses) {
      const lastPolledMs = depositSchemaSupportsCursor
        ? Number(item.last_polled_timestamp_ms ?? 0)
        : memoryCursorFallback.get(item.id) ?? 0;

      const minTsQuery = lastPolledMs > 0 ? `&min_timestamp=${lastPolledMs}` : '';
      const url = `${TRON_FULL_HOST}/v1/accounts/${item.address}/transactions/trc20?only_confirmed=true&only_to=true&contract_address=${USDT_CONTRACT}&limit=50&order_by=block_timestamp,asc${minTsQuery}`;

      const response = await fetch(url, {
        headers: TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {},
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(`TronGrid HTTP ${response.status} polling ${item.address}`);
      }

      const result = (await response.json()) as TronGridResponse;
      if (result.error) {
        throw new Error(`TronGrid API error for ${item.address}: ${result.error}`);
      }

      if (!result.data || !Array.isArray(result.data) || result.data.length === 0) {
        if (lastPolledMs > highestGlobalCursorMs) highestGlobalCursorMs = lastPolledMs;
        continue;
      }

      // Sort ascending by block_timestamp so cursor only advances monotonically past completed items
      const orderedTxs = [...result.data].sort(
        (a, b) => Number(a.block_timestamp ?? 0) - Number(b.block_timestamp ?? 0)
      );

      let nextCursorMs = lastPolledMs;
      let addressHadCreditError = false;

      for (const tx of orderedTxs) {
        const txHash = tx.transaction_id;
        const txTimestampMs = Number(tx.block_timestamp ?? 0);
        const amount = Number(tx.value) / 1_000_000;

        if (!Number.isFinite(amount) || amount <= 0) {
          if (!addressHadCreditError && txTimestampMs > nextCursorMs) {
            nextCursorMs = txTimestampMs;
          }
          continue;
        }

        // Idempotency check: skip if transaction hash already recorded
        const { data: existingTx } = await supabase
          .from('transactions')
          .select('id')
          .eq('tx_hash', txHash)
          .maybeSingle();

        if (existingTx) {
          if (!addressHadCreditError && txTimestampMs > nextCursorMs) {
            nextCursorMs = txTimestampMs;
          }
          continue;
        }

        const walletsRel = item.wallets;
        const terminalId = Array.isArray(walletsRel)
          ? walletsRel[0]?.terminal_id
          : walletsRel?.terminal_id;
        if (!terminalId) continue;

        console.log(
          `[DEPOSIT DETECTED] ${amount} USDT -> Terminal: ${terminalId} | TX: ${txHash}`
        );

        const { error: rpcError } = await supabase.rpc('credit_crypto_deposit', {
          p_terminal_id: terminalId,
          p_wallet_id: item.wallet_id,
          p_asset: 'USDT',
          p_network: 'TRC20',
          p_amount: amount,
          p_tx_hash: txHash,
        });

        if (rpcError) {
          addressHadCreditError = true;
          console.error(`[DEPOSIT ERROR] TX ${txHash}:`, rpcError.message);
          await sendWorkerAlert(
            {
              severity: 'critical',
              eventType: 'DEPOSIT_CREDIT_FAILED',
              title: 'Deposit RPC Credit Failure',
              message: `Failed to credit ${amount} USDT deposit (${txHash}) to terminal ${terminalId}: ${rpcError.message}`,
              metadata: { txHash, terminalId, walletId: item.wallet_id, amount },
            },
            { dedupeKey: `dep_rpc_${txHash}` }
          );
          break; // Stop advancing cursor for this address until this tx succeeds
        }

        if (txTimestampMs > nextCursorMs) {
          nextCursorMs = txTimestampMs;
        }
      }

      if (nextCursorMs > lastPolledMs) {
        if (depositSchemaSupportsCursor) {
          await supabase
            .from('deposit_addresses')
            .update({ last_polled_timestamp_ms: nextCursorMs })
            .eq('id', item.id);
        } else {
          memoryCursorFallback.set(item.id, nextCursorMs);
        }
      }

      if (nextCursorMs > highestGlobalCursorMs) {
        highestGlobalCursorMs = nextCursorMs;
      }
    }

    consecutivePollFailures = 0;
    if (highestGlobalCursorMs > 0) {
      await updateDepositPollingCheckpoint(highestGlobalCursorMs, 0, null);
    }
  } catch (err) {
    const safeMsg = sanitizeErrorMessage(err, hotWalletResolution.privateKey);
    consecutivePollFailures += 1;
    console.error(`[WATCHER EXCEPTION #${consecutivePollFailures}]:`, safeMsg);
    await updateDepositPollingCheckpoint(0, consecutivePollFailures, safeMsg);

    if (consecutivePollFailures >= POLL_FAILURE_ALERT_THRESHOLD) {
      await sendWorkerAlert(
        {
          severity: 'critical',
          eventType: 'DEPOSIT_WATCHER_OUTAGE',
          title: 'TRON Deposit Polling Outage',
          message: `watchDeposits() failed ${consecutivePollFailures} consecutive times. Latest error: ${safeMsg}`,
          metadata: { consecutivePollFailures },
        },
        { dedupeKey: 'deposit_watcher_outage' }
      );
    }
  }
}

async function finalizeConfirmedWithdrawal(
  reqId: string,
  transactionId: string,
  terminalId: string,
  netAmount: number,
  destAddress: string,
  txHash: string
): Promise<void> {
  // Persist tx_hash_candidate first as an immediate duplicate-payout marker
  if (withdrawalSchemaSupportsRetryCols) {
    await supabase
      .from('withdrawal_requests')
      .update({ tx_hash_candidate: txHash, last_error: null })
      .eq('id', reqId);
  }

  const { error: txErr } = await supabase
    .from('transactions')
    .update({ status: 'completed', tx_hash: txHash })
    .eq('id', transactionId);

  if (txErr) {
    throw new Error(`Post-broadcast transaction update failed: ${txErr.message}`);
  }

  const { error: reqErr } = await supabase
    .from('withdrawal_requests')
    .update({ state: 'confirmed' })
    .eq('id', reqId);

  if (reqErr) {
    throw new Error(`Post-broadcast request confirmation update failed: ${reqErr.message}`);
  }

  await recordWorkerAuditLog(supabase, {
    eventType: 'WITHDRAWAL_BROADCAST_CONFIRMED',
    terminalId,
    severity: 'info',
    details: `Broadcast confirmed for request ${reqId} (tx ${transactionId}): ${netAmount} USDT (TRC20) -> ${destAddress} | tx_hash=${txHash}.`,
  });

  console.log(`[WITHDRAWAL CONFIRMED] TX Hash: ${txHash}`);
}

/**
 * Execute admin-approved outbound withdrawal requests on the TRON network
 * with duplicate-payout guards, AML screening, and 3-attempt exponential backoff.
 */
async function processApprovedWithdrawals(): Promise<void> {
  try {
    const selectCols = withdrawalSchemaSupportsRetryCols
      ? `
          id,
          transaction_id,
          state,
          attempt_count,
          tx_hash_candidate,
          whitelist_addresses(address, network),
          transactions(terminal_id, asset, amount, fee, status, tx_hash)
        `
      : `
          id,
          transaction_id,
          state,
          whitelist_addresses(address, network),
          transactions(terminal_id, asset, amount, fee, status, tx_hash)
        `;

    const queryRes = await supabase
      .from('withdrawal_requests')
      .select(selectCols)
      .eq('state', 'approved')
      .limit(5);

    if (queryRes.error && withdrawalSchemaSupportsRetryCols) {
      if (
        queryRes.error.message.includes('attempt_count') ||
        queryRes.error.message.includes('tx_hash_candidate')
      ) {
        withdrawalSchemaSupportsRetryCols = false;
        console.warn(
          '[WITHDRAWAL] Retry guard columns not found; apply migration 004 for persistent attempt tracking.'
        );
        return processApprovedWithdrawals();
      }
      throw new Error(`Failed to fetch approved withdrawals: ${queryRes.error.message}`);
    }

    const requests = (queryRes.data ?? []) as unknown as Array<{
      id: string;
      transaction_id: string;
      state: string;
      attempt_count?: number;
      tx_hash_candidate?: string | null;
      whitelist_addresses:
        | { address: string; network: string }
        | { address: string; network: string }[]
        | null;
      transactions:
        | {
            terminal_id: string;
            asset: string;
            amount: number;
            fee: number;
            status: string;
            tx_hash: string | null;
          }
        | {
            terminal_id: string;
            asset: string;
            amount: number;
            fee: number;
            status: string;
            tx_hash: string | null;
          }[]
        | null;
    }>;

    if (requests.length === 0) return;

    const contract = await tronWeb.contract().at(USDT_CONTRACT);

    for (const req of requests) {
      const txData = Array.isArray(req.transactions) ? req.transactions[0] : req.transactions;
      const destData = Array.isArray(req.whitelist_addresses)
        ? req.whitelist_addresses[0]
        : req.whitelist_addresses;

      if (!txData || !destData) continue;
      if (txData.asset !== 'USDT' || destData.network !== 'TRC20') continue;

      const netAmount = Number(txData.amount);
      const amountInUnits = Math.floor(netAmount * 1_000_000);
      if (!Number.isFinite(netAmount) || amountInUnits <= 0) continue;

      // 1. DUPLICATE-PAYOUT GUARD: Never re-broadcast if tx_hash or tx_hash_candidate already exists
      const existingHash = txData.tx_hash || req.tx_hash_candidate;
      if (existingHash || txData.status === 'completed') {
        console.warn(
          `[DUPLICATE GUARD] Request ${req.id} already has tx_hash=${existingHash ?? 'completed'}; reconciling without rebroadcast.`
        );
        if (existingHash) {
          await finalizeConfirmedWithdrawal(
            req.id,
            req.transaction_id,
            txData.terminal_id,
            netAmount,
            destData.address,
            existingHash
          ).catch(() => undefined);
        } else {
          await supabase
            .from('withdrawal_requests')
            .update({ state: 'confirmed' })
            .eq('id', req.id);
        }
        await recordWorkerAuditLog(supabase, {
          eventType: 'WITHDRAWAL_DUPLICATE_PAYOUT_PREVENTED',
          terminalId: txData.terminal_id,
          severity: 'warn',
          details: `Skipped rebroadcast for request ${req.id} (tx ${req.transaction_id}); existing tx_hash=${existingHash ?? 'none'}.`,
        });
        continue;
      }

      // 2. ATOMIC LOCK: Claim only rows still in 'approved' state
      const { data: claimedRows, error: claimError } = await supabase
        .from('withdrawal_requests')
        .update({ state: 'broadcast', broadcast_at: new Date().toISOString() })
        .eq('id', req.id)
        .eq('state', 'approved')
        .select('id');

      if (claimError || !claimedRows || claimedRows.length === 0) continue;

      // 3. LIGHTWEIGHT AML DESTINATION SCREENING
      const amlResult = await screenWithdrawalDestination(
        supabase,
        tronWeb,
        destData.address,
        destData.network
      );

      if (!amlResult.allowed) {
        const blockReason = amlResult.reason ?? 'Destination flagged by AML screening.';
        console.error(`[AML BLOCKED] Request ${req.id}: ${blockReason}`);

        const reviewPatch: Record<string, unknown> = { state: 'review' };
        if (withdrawalSchemaSupportsRetryCols) {
          reviewPatch.last_error = `AML_BLOCKED: ${blockReason}`.slice(0, 500);
          reviewPatch.last_attempt_at = new Date().toISOString();
        }

        await supabase.from('withdrawal_requests').update(reviewPatch).eq('id', req.id);

        await recordWorkerAuditLog(supabase, {
          eventType: 'WITHDRAWAL_AML_BLOCKED',
          terminalId: txData.terminal_id,
          severity: 'critical',
          details: `Blocked payout for request ${req.id} (tx ${req.transaction_id}, ${netAmount} USDT -> ${destData.address}): ${blockReason} [source=${amlResult.source ?? 'aml'}].`,
        });

        await sendWorkerAlert({
          severity: 'critical',
          eventType: 'WITHDRAWAL_AML_BLOCKED',
          title: 'AML Destination Screening Blocked Payout',
          message: blockReason,
          metadata: {
            requestId: req.id,
            transactionId: req.transaction_id,
            terminalId: txData.terminal_id,
            address: destData.address,
            amountUsdt: netAmount,
          },
        });
        continue;
      }

      console.log(`[WITHDRAWAL BROADCASTING] ${netAmount} USDT -> ${destData.address}`);

      await recordWorkerAuditLog(supabase, {
        eventType: 'WITHDRAWAL_BROADCAST_STARTED',
        terminalId: txData.terminal_id,
        severity: 'info',
        details: `Broadcast initiated for request ${req.id} (tx ${req.transaction_id}): ${netAmount} USDT (TRC20) -> ${destData.address} [keySource=${hotWalletResolution.source}].`,
      });

      // 4. RETRY WITH EXPONENTIAL BACKOFF (MAX 3 ATTEMPTS) & POST-SEND HASH CACHE
      let obtainedTxHash: string | null = null;
      let finalErrorMsg = '';
      let succeeded = false;

      for (let attempt = 1; attempt <= MAX_BROADCAST_ATTEMPTS; attempt += 1) {
        if (withdrawalSchemaSupportsRetryCols) {
          await supabase
            .from('withdrawal_requests')
            .update({
              attempt_count: (req.attempt_count ?? 0) + attempt,
              last_attempt_at: new Date().toISOString(),
            })
            .eq('id', req.id);
        }

        try {
          // Re-check DB right before sending in case another process populated tx_hash
          if (!obtainedTxHash) {
            const { data: freshTx } = await supabase
              .from('transactions')
              .select('tx_hash, status')
              .eq('id', req.transaction_id)
              .maybeSingle();

            if (freshTx?.tx_hash || freshTx?.status === 'completed') {
              obtainedTxHash = freshTx.tx_hash ?? null;
              if (!obtainedTxHash) {
                succeeded = true;
                break;
              }
            }
          }

          // Only invoke on-chain transfer if we have NOT already obtained a txHash
          if (!obtainedTxHash) {
            obtainedTxHash = (await contract.transfer(destData.address, amountInUnits).send({
              feeLimit: 30_000_000, // Max 30 TRX energy/bandwidth fee cap
            })) as string;
          }

          await finalizeConfirmedWithdrawal(
            req.id,
            req.transaction_id,
            txData.terminal_id,
            netAmount,
            destData.address,
            obtainedTxHash
          );
          succeeded = true;
          break;
        } catch (sendErr: unknown) {
          finalErrorMsg = sanitizeErrorMessage(sendErr, hotWalletResolution.privateKey);
          console.error(
            `[WITHDRAWAL ATTEMPT ${attempt}/${MAX_BROADCAST_ATTEMPTS} FAILED] Request ${req.id}:`,
            finalErrorMsg
          );

          if (withdrawalSchemaSupportsRetryCols) {
            await supabase
              .from('withdrawal_requests')
              .update({
                last_error: finalErrorMsg,
                tx_hash_candidate: obtainedTxHash,
              })
              .eq('id', req.id);
          }

          await recordWorkerAuditLog(supabase, {
            eventType: 'WITHDRAWAL_BROADCAST_RETRY',
            terminalId: txData.terminal_id,
            severity: 'warn',
            details: `Attempt ${attempt}/${MAX_BROADCAST_ATTEMPTS} failed for request ${req.id} (tx ${req.transaction_id}): ${finalErrorMsg}${obtainedTxHash ? ` [tx_hash=${obtainedTxHash} cached, will not rebroadcast]` : ''}.`,
          });

          if (attempt < MAX_BROADCAST_ATTEMPTS) {
            await sleep(computeBackoffDelayMs(attempt));
          }
        }
      }

      if (!succeeded) {
        const exhaustedPatch: Record<string, unknown> = { state: 'review' };
        if (withdrawalSchemaSupportsRetryCols) {
          exhaustedPatch.last_error = finalErrorMsg;
          exhaustedPatch.tx_hash_candidate = obtainedTxHash;
        }

        await supabase.from('withdrawal_requests').update(exhaustedPatch).eq('id', req.id);

        await recordWorkerAuditLog(supabase, {
          eventType: 'WITHDRAWAL_BROADCAST_FAILED',
          terminalId: txData.terminal_id,
          severity: 'critical',
          details: `Broadcast exhausted ${MAX_BROADCAST_ATTEMPTS} attempts for request ${req.id} (tx ${req.transaction_id}): ${netAmount} USDT (TRC20) -> ${destData.address}. Returned to manual review. Error: ${finalErrorMsg}`,
        });

        await sendWorkerAlert({
          severity: 'critical',
          eventType: 'WITHDRAWAL_BROADCAST_EXHAUSTED',
          title: 'TRON Withdrawal Broadcast Exhausted Retries',
          message: `Withdrawal request ${req.id} (${netAmount} USDT -> ${destData.address}) failed after ${MAX_BROADCAST_ATTEMPTS} attempts and returned to manual review. Error: ${finalErrorMsg}`,
          metadata: {
            requestId: req.id,
            transactionId: req.transaction_id,
            terminalId: txData.terminal_id,
            address: destData.address,
            amountUsdt: netAmount,
            cachedTxHash: obtainedTxHash,
          },
        });
      }
    }
  } catch (err) {
    const safeMsg = sanitizeErrorMessage(err, hotWalletResolution.privateKey);
    console.error('[WITHDRAWAL WORKER EXCEPTION]:', safeMsg);
    await sendWorkerAlert(
      {
        severity: 'critical',
        eventType: 'WITHDRAWAL_WORKER_EXCEPTION',
        title: 'TRON Withdrawal Worker Exception',
        message: safeMsg,
      },
      { dedupeKey: 'withdrawal_worker_exception' }
    );
  }
}

// Start continuous 15-second worker loop with concurrency guard
const INTERVAL = Number(process.env.POLL_INTERVAL_MS) || 15000;
let isRunning = false;

console.log(
  `NTPS TRON Worker started (keySource=${hotWalletResolution.source}). Polling every ${INTERVAL / 1000}s...`
);

setInterval(async () => {
  if (isRunning) return;
  isRunning = true;
  try {
    await watchDeposits();
    await processApprovedWithdrawals();
  } finally {
    isRunning = false;
  }
}, INTERVAL);
