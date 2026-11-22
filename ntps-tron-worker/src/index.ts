import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { TronWeb } from 'tronweb';
import * as dotenv from 'dotenv';
import { resolveHotWalletPrivateKey } from './cryptoKey';
import { recordWorkerAuditLog, sanitizeErrorMessage } from './auditLog';
import { sendWorkerAlert } from './alerts';
import { screenWithdrawalDestination } from './aml';
import { assessDestinationTrust, extractTxIdFromError } from './guards';
import {
  buildPolicyBlockedAlert,
  computePrior24hOutflowUsd,
  evaluateBroadcastPolicy,
  resolveUsdRate,
  type OutflowTransactionRow,
  type TerminalPolicyRecord,
} from './policyGuard';
import {
  advanceDepositCursor,
  classifyApprovedWithdrawal,
  evaluateHotWalletTrxBalance,
  generateWorkerInstanceId,
  preserveGlobalCursorOnError,
  resolveStaleBroadcastAction,
  resolveTrustedTronHost,
  validateAndParseTronGridDeposit,
  type TronGridDepositPayload,
  type WithdrawalQueueDestInfo,
  type WithdrawalQueueTxInfo,
} from './workerHelpers';

// W-24: Load `.env` only outside production so runtime secrets come from process/secrets manager
if ((process.env.NODE_ENV ?? '').trim().toLowerCase() !== 'production') {
  dotenv.config();
}

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
// W-19: Validate TRON_FULL_HOST against permitted TronGrid / configured origins
const TRON_FULL_HOST = resolveTrustedTronHost(
  process.env.TRON_FULL_HOST,
  process.env.TRON_ALLOWED_HOSTS
);
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || '';
const USDT_CONTRACT =
  process.env.USDT_CONTRACT_ADDRESS || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const MAX_BROADCAST_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = Math.max(250, Number(process.env.WITHDRAWAL_RETRY_BASE_MS) || 2000);
const POLL_FAILURE_ALERT_THRESHOLD = Math.max(
  1,
  Number(process.env.POLL_FAILURE_ALERT_THRESHOLD) || 3
);
const STALE_BROADCAST_THRESHOLD_MS = Math.max(
  60_000,
  Number(process.env.STALE_BROADCAST_THRESHOLD_MS) || 10 * 60 * 1000
);
const MIN_HOT_WALLET_TRX_SUN = Math.max(
  1_000_000,
  Math.round((Number(process.env.MIN_HOT_WALLET_TRX) || 50) * 1_000_000)
);
const WORKER_INSTANCE_ID = generateWorkerInstanceId();
const WORKER_LEASE_KEY = 'ntps_tron_worker_primary';
const WORKER_LEASE_TTL_SECONDS = Math.max(
  20,
  Math.min(300, Number(process.env.WORKER_LEASE_TTL_SECONDS) || 45)
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

interface TronGridResponse {
  data?: TronGridDepositPayload[];
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

// Fallback flags used only if corresponding migrations have not yet been applied
const memoryCursorFallback = new Map<string, number>();
let depositSchemaSupportsCursor = true;
let withdrawalSchemaSupportsRetryCols = true;
let withdrawalSchemaSupportsSnapshot = true;
let withdrawalSchemaSupportsVerified = true;
let workerLeaseRpcSupported = true;
let leaseRpcMissingWarned = false;
let consecutivePollFailures = 0;
let lastKnownGlobalCursorMs = 0;
let checkpointHydrated = false;
let isShuttingDown = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffDelayMs(attempt: number): number {
  const exp = RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = crypto.randomInt(0, 250);
  return exp + jitter;
}

async function hydrateInitialGlobalCursor(): Promise<void> {
  if (checkpointHydrated) return;
  checkpointHydrated = true;
  try {
    const { data } = await supabase
      .from('worker_checkpoints')
      .select('cursor_ms')
      .eq('worker_key', 'tron_deposit_watcher')
      .maybeSingle();

    const persisted = Number(data?.cursor_ms ?? 0);
    if (Number.isFinite(persisted) && persisted > lastKnownGlobalCursorMs) {
      lastKnownGlobalCursorMs = persisted;
    }
  } catch {
    // Checkpoint table may not exist prior to migration 004; ignore gracefully
  }
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
  let highestBatchCursorMs = 0;
  try {
    await hydrateInitialGlobalCursor();
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

    for (const item of addresses) {
      if (isShuttingDown) break;

      const lastPolledMs = depositSchemaSupportsCursor
        ? Number(item.last_polled_timestamp_ms ?? 0)
        : memoryCursorFallback.get(item.id) ?? 0;

      if (lastPolledMs > highestBatchCursorMs) {
        highestBatchCursorMs = lastPolledMs;
        lastKnownGlobalCursorMs = Math.max(lastKnownGlobalCursorMs, lastPolledMs);
      }

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
        continue;
      }

      // Sort ascending by block_timestamp so cursor only advances monotonically past completed items
      const orderedTxs = [...result.data].sort(
        (a, b) => Number(a.block_timestamp ?? 0) - Number(b.block_timestamp ?? 0)
      );

      let nextCursorMs = lastPolledMs;
      let addressHadCreditError = false;

      for (const tx of orderedTxs) {
        if (isShuttingDown) break;

        // W-18: Verify contract address, recipient `to`, decimals, and integer value locally
        const parsedTx = validateAndParseTronGridDeposit(tx, item.address, USDT_CONTRACT);
        if (!parsedTx.valid) {
          if (parsedTx.suspicious) {
            const safeReason = sanitizeErrorMessage(parsedTx.reason, hotWalletResolution.privateKey);
            console.warn(`[WATCHER REJECTED PAYLOAD] ${safeReason}`);
            await recordWorkerAuditLog(supabase, {
              eventType: 'DEPOSIT_PAYLOAD_REJECTED',
              terminalId: null,
              severity: 'warn',
              details: `Rejected TRC-20 polling event for address ${item.address}: ${safeReason}`,
            });
          }
          nextCursorMs = advanceDepositCursor(
            nextCursorMs,
            parsedTx.timestampMs,
            addressHadCreditError
          );
          continue;
        }

        const { txHash, amount, timestampMs: txTimestampMs } = parsedTx;

        // Idempotency check: skip if transaction hash already recorded
        const { data: existingTx } = await supabase
          .from('transactions')
          .select('id')
          .eq('tx_hash', txHash)
          .maybeSingle();

        if (existingTx) {
          nextCursorMs = advanceDepositCursor(nextCursorMs, txTimestampMs, addressHadCreditError);
          continue;
        }

        const walletsRel = item.wallets;
        const terminalId = Array.isArray(walletsRel)
          ? walletsRel[0]?.terminal_id
          : walletsRel?.terminal_id;

        if (!terminalId) {
          console.error(
            `[DEPOSIT WALLET UNLINKED] Deposit address ${item.address} (wallet ${item.wallet_id}) has no linked terminal for TX ${txHash} (${amount} USDT).`
          );
          await recordWorkerAuditLog(supabase, {
            eventType: 'DEPOSIT_WALLET_UNLINKED',
            terminalId: null,
            severity: 'critical',
            details: `Received ${amount} USDT deposit (${txHash}) on address ${item.address} (wallet ${item.wallet_id}), but no linked terminal exists.`,
          });
          await sendWorkerAlert(
            {
              severity: 'critical',
              eventType: 'DEPOSIT_WALLET_UNLINKED',
              title: 'Unlinked Deposit Wallet Detected',
              message: `Inbound deposit ${txHash} (${amount} USDT) arrived at ${item.address} (wallet ${item.wallet_id}) with no linked terminal.`,
              metadata: {
                txHash,
                address: item.address,
                walletId: item.wallet_id,
                amount,
              },
            },
            { dedupeKey: `unlinked_wallet_${item.wallet_id}` }
          );
          nextCursorMs = advanceDepositCursor(nextCursorMs, txTimestampMs, addressHadCreditError);
          continue;
        }

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
          const safeRpcMsg = sanitizeErrorMessage(
            rpcError.message,
            hotWalletResolution.privateKey
          );
          console.error(`[DEPOSIT ERROR] TX ${txHash}:`, safeRpcMsg);
          await sendWorkerAlert(
            {
              severity: 'critical',
              eventType: 'DEPOSIT_CREDIT_FAILED',
              title: 'Deposit RPC Credit Failure',
              message: `Failed to credit ${amount} USDT deposit (${txHash}) to terminal ${terminalId}: ${safeRpcMsg}`,
              metadata: { txHash, terminalId, walletId: item.wallet_id, amount },
            },
            { dedupeKey: `dep_rpc_${txHash}` }
          );
          break; // Stop advancing cursor for this address until this tx succeeds
        }

        nextCursorMs = advanceDepositCursor(nextCursorMs, txTimestampMs, addressHadCreditError);
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

      if (nextCursorMs > highestBatchCursorMs) {
        highestBatchCursorMs = nextCursorMs;
      }
      if (nextCursorMs > lastKnownGlobalCursorMs) {
        lastKnownGlobalCursorMs = nextCursorMs;
      }
    }

    consecutivePollFailures = 0;
    if (lastKnownGlobalCursorMs > 0) {
      await updateDepositPollingCheckpoint(lastKnownGlobalCursorMs, 0, null);
    }
  } catch (err) {
    const safeMsg = sanitizeErrorMessage(err, hotWalletResolution.privateKey);
    consecutivePollFailures += 1;
    const preservedCursorMs = preserveGlobalCursorOnError(
      lastKnownGlobalCursorMs,
      highestBatchCursorMs
    );
    lastKnownGlobalCursorMs = preservedCursorMs;
    console.error(`[WATCHER EXCEPTION #${consecutivePollFailures}]:`, safeMsg);
    await updateDepositPollingCheckpoint(preservedCursorMs, consecutivePollFailures, safeMsg);

    if (consecutivePollFailures >= POLL_FAILURE_ALERT_THRESHOLD) {
      await sendWorkerAlert(
        {
          severity: 'critical',
          eventType: 'DEPOSIT_WATCHER_OUTAGE',
          title: 'TRON Deposit Polling Outage',
          message: `watchDeposits() failed ${consecutivePollFailures} consecutive times. Latest error: ${safeMsg}`,
          metadata: { consecutivePollFailures, preservedCursorMs },
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
 * Reconciles withdrawals stranded in `state = 'broadcast'` past `STALE_BROADCAST_THRESHOLD_MS`
 * (e.g., due to process crash or network timeout before confirmation persistence).
 */
async function reconcileStaleBroadcastWithdrawals(): Promise<void> {
  try {
    const staleCutoffIso = new Date(Date.now() - STALE_BROADCAST_THRESHOLD_MS).toISOString();
    const selectCols = withdrawalSchemaSupportsRetryCols
      ? `
          id,
          transaction_id,
          state,
          broadcast_at,
          tx_hash_candidate,
          whitelist_addresses(address, network),
          transactions(terminal_id, asset, amount, fee, status, tx_hash)
        `
      : `
          id,
          transaction_id,
          state,
          broadcast_at,
          whitelist_addresses(address, network),
          transactions(terminal_id, asset, amount, fee, status, tx_hash)
        `;

    const queryRes = await supabase
      .from('withdrawal_requests')
      .select(selectCols)
      .eq('state', 'broadcast')
      .lt('broadcast_at', staleCutoffIso)
      .order('broadcast_at', { ascending: true })
      .limit(20);

    if (queryRes.error && withdrawalSchemaSupportsRetryCols) {
      if (queryRes.error.message.includes('tx_hash_candidate')) {
        withdrawalSchemaSupportsRetryCols = false;
        return reconcileStaleBroadcastWithdrawals();
      }
      throw new Error(`Stale broadcast query failed: ${queryRes.error.message}`);
    }

    const staleRows = (queryRes.data ?? []) as unknown as Array<{
      id: string;
      transaction_id: string;
      state: string;
      broadcast_at: string | null;
      tx_hash_candidate?: string | null;
      whitelist_addresses: WithdrawalQueueDestInfo | WithdrawalQueueDestInfo[] | null;
      transactions: WithdrawalQueueTxInfo | WithdrawalQueueTxInfo[] | null;
    }>;

    for (const row of staleRows) {
      if (isShuttingDown) break;

      const txData = Array.isArray(row.transactions) ? row.transactions[0] : row.transactions;
      const destData = Array.isArray(row.whitelist_addresses)
        ? row.whitelist_addresses[0]
        : row.whitelist_addresses;

      const disposition = resolveStaleBroadcastAction({
        txHash: txData?.tx_hash,
        txHashCandidate: row.tx_hash_candidate,
        broadcastAtIso: row.broadcast_at,
      });

      if (disposition.action === 'finalize_with_hash') {
        await finalizeConfirmedWithdrawal(
          row.id,
          row.transaction_id,
          txData?.terminal_id ?? '',
          Number(txData?.amount ?? 0),
          destData?.address ?? '',
          disposition.txHash
        );
        await recordWorkerAuditLog(supabase, {
          eventType: 'WITHDRAWAL_STALE_BROADCAST_RECONCILED',
          terminalId: txData?.terminal_id ?? null,
          severity: 'info',
          details: `Finalized stale broadcast request ${row.id} (tx ${row.transaction_id}) using existing tx_hash=${disposition.txHash}.`,
        });
      } else {
        const reviewPatch: Record<string, unknown> = { state: 'review' };
        if (withdrawalSchemaSupportsRetryCols) {
          reviewPatch.last_error = disposition.reason.slice(0, 500);
          reviewPatch.last_attempt_at = new Date().toISOString();
        }
        await supabase
          .from('withdrawal_requests')
          .update(reviewPatch)
          .eq('id', row.id)
          .eq('state', 'broadcast');

        await recordWorkerAuditLog(supabase, {
          eventType: 'WITHDRAWAL_STALE_BROADCAST_RECONCILED',
          terminalId: txData?.terminal_id ?? null,
          severity: 'critical',
          details: `Returned stale broadcast request ${row.id} (tx ${row.transaction_id}) to review: ${disposition.reason}`,
        });

        await sendWorkerAlert(
          {
            severity: 'critical',
            eventType: 'WITHDRAWAL_STALE_BROADCAST_RECONCILED',
            title: 'Stale Broadcast Withdrawal Returned to Review',
            message: `Withdrawal request ${row.id} remained in 'broadcast' past timeout without a confirmed tx_hash and was moved back to manual review.`,
            metadata: {
              requestId: row.id,
              transactionId: row.transaction_id,
              terminalId: txData?.terminal_id ?? null,
              broadcastAt: row.broadcast_at,
            },
          },
          { dedupeKey: `stale_broadcast_${row.id}` }
        );
      }
    }
  } catch (err) {
    const safeMsg = sanitizeErrorMessage(err, hotWalletResolution.privateKey);
    console.error('[STALE BROADCAST RECONCILER ERROR]:', safeMsg);
  }
}

interface ApprovedWithdrawalRow {
  id: string;
  transaction_id: string;
  state: string;
  created_at?: string;
  attempt_count?: number;
  tx_hash_candidate?: string | null;
  destination_snapshot?: string | null;
  whitelist_addresses: WithdrawalQueueDestInfo | WithdrawalQueueDestInfo[] | null;
  transactions: WithdrawalQueueTxInfo | WithdrawalQueueTxInfo[] | null;
}

function buildWithdrawalSelectCols(): string {
  const reqCols = ['id', 'transaction_id', 'state', 'created_at'];
  if (withdrawalSchemaSupportsRetryCols) {
    reqCols.push('attempt_count', 'tx_hash_candidate');
  }
  if (withdrawalSchemaSupportsSnapshot) {
    reqCols.push('destination_snapshot');
  }

  const wlCols = withdrawalSchemaSupportsVerified
    ? 'address, network, verified'
    : 'address, network';

  return `${reqCols.join(', ')}, whitelist_addresses(${wlCols}), transactions(terminal_id, asset, amount, fee, status, tx_hash)`;
}

async function fetchApprovedWithdrawals(): Promise<ApprovedWithdrawalRow[]> {
  for (let guard = 0; guard < 4; guard += 1) {
    const queryRes = await supabase
      .from('withdrawal_requests')
      .select(buildWithdrawalSelectCols())
      .eq('state', 'approved')
      .order('created_at', { ascending: true })
      .limit(25);

    if (!queryRes.error) {
      return (queryRes.data ?? []) as unknown as ApprovedWithdrawalRow[];
    }

    const msg = queryRes.error.message;
    let flipped = false;

    if (msg.includes('destination_snapshot') && withdrawalSchemaSupportsSnapshot) {
      withdrawalSchemaSupportsSnapshot = false;
      flipped = true;
      console.warn(
        '[WITHDRAWAL] destination_snapshot column missing; apply migration 009 for TOCTOU protection.'
      );
    }

    if (
      (msg.includes('attempt_count') || msg.includes('tx_hash_candidate')) &&
      withdrawalSchemaSupportsRetryCols
    ) {
      withdrawalSchemaSupportsRetryCols = false;
      flipped = true;
      console.warn(
        '[WITHDRAWAL] Retry guard columns not found; apply migration 004 for persistent attempt tracking.'
      );
    }

    if (msg.includes('verified') && withdrawalSchemaSupportsVerified) {
      withdrawalSchemaSupportsVerified = false;
      flipped = true;
      console.warn(
        '[WITHDRAWAL] whitelist_addresses.verified column missing; destination trust gate will fail closed.'
      );
    }

    if (!flipped) {
      throw new Error(`Failed to fetch approved withdrawals: ${msg}`);
    }
  }

  throw new Error('Failed to fetch approved withdrawals: schema capability detection exhausted.');
}

/**
 * Execute admin-approved outbound withdrawal requests on the TRON network
 * with FIFO ordering, unsupported-network handoff, destination trust gating (W-01),
 * duplicate-payout guards, terminal policy checks (W-04), fail-closed AML screening (W-03),
 * and 3-attempt exponential backoff.
 */
async function processApprovedWithdrawals(): Promise<void> {
  try {
    const requests = await fetchApprovedWithdrawals();
    if (requests.length === 0) return;

    // W-20: Verify hot wallet TRX fee reserve before initiating outbound withdrawal broadcasts
    const hotWalletAddress =
      tronWeb.address.fromPrivateKey(hotWalletResolution.privateKey) ||
      (typeof tronWeb.defaultAddress?.base58 === 'string' ? tronWeb.defaultAddress.base58 : '');

    if (hotWalletAddress) {
      let balanceSun = NaN;
      try {
        balanceSun = Number(await tronWeb.trx.getBalance(hotWalletAddress));
      } catch (trxErr) {
        const safeTrxErr = sanitizeErrorMessage(trxErr, hotWalletResolution.privateKey);
        console.warn(`[HOT WALLET TRX CHECK ERROR] Unable to query balance for ${hotWalletAddress}: ${safeTrxErr}`);
        balanceSun = NaN;
      }

      if (Number.isFinite(balanceSun)) {
        const trxCheck = evaluateHotWalletTrxBalance(balanceSun, MIN_HOT_WALLET_TRX_SUN);
        if (!trxCheck.ok) {
          const reason = trxCheck.reason ?? 'Hot wallet TRX fee reserve below safe minimum.';
          console.error(`[LOW TRX FEE RESERVE] ${reason}`);
          await recordWorkerAuditLog(supabase, {
            eventType: 'HOT_WALLET_LOW_TRX',
            terminalId: null,
            severity: 'critical',
            details: `${reason} (hotWallet=${hotWalletAddress})`,
          });
          await sendWorkerAlert(
            {
              severity: 'critical',
              eventType: 'HOT_WALLET_LOW_TRX',
              title: 'TRON Hot Wallet Low TRX Fee Reserve',
              message: reason,
              metadata: {
                hotWalletAddress,
                balanceTrx: trxCheck.balanceTrx,
                minReserveTrx: trxCheck.minReserveTrx,
              },
            },
            { dedupeKey: 'hot_wallet_low_trx' }
          );
          return;
        }
      }
    }

    // Load server-side asset USD rates once per batch (graceful fallback if asset_rates absent)
    const ratesMap: Partial<Record<string, number>> = {};
    const { data: rateRows } = await supabase
      .from('asset_rates')
      .select('asset, usd_rate');
    if (Array.isArray(rateRows)) {
      for (const r of rateRows) {
        const num = Number(r.usd_rate);
        if (typeof r.asset === 'string' && Number.isFinite(num) && num > 0) {
          ratesMap[r.asset] = num;
        }
      }
    }

    let cachedUsdtContract: Awaited<ReturnType<ReturnType<typeof tronWeb.contract>['at']>> | null = null;
    const getUsdtContract = async () => {
      if (!cachedUsdtContract) {
        cachedUsdtContract = await tronWeb.contract().at(USDT_CONTRACT);
      }
      return cachedUsdtContract;
    };

    const rejectPolicyBlocked = async (
      reqItem: { id: string; transaction_id: string },
      terminalUuid: string,
      amountUsdt: number,
      destAddress: string,
      reason: string
    ) => {
      console.error(`[POLICY BLOCKED] Request ${reqItem.id}: ${reason}`);
      const reviewPatch: Record<string, unknown> = { state: 'review' };
      if (withdrawalSchemaSupportsRetryCols) {
        reviewPatch.last_error = `POLICY_BLOCKED: ${reason}`.slice(0, 500);
        reviewPatch.last_attempt_at = new Date().toISOString();
      }
      await supabase
        .from('withdrawal_requests')
        .update(reviewPatch)
        .eq('id', reqItem.id)
        .in('state', ['approved', 'broadcast']);

      await recordWorkerAuditLog(supabase, {
        eventType: 'WITHDRAWAL_POLICY_BLOCKED',
        terminalId: terminalUuid,
        severity: 'critical',
        details: `Blocked payout for request ${reqItem.id} (tx ${reqItem.transaction_id}, ${amountUsdt} USDT -> ${destAddress}): ${reason}`,
      });

      await sendWorkerAlert(
        buildPolicyBlockedAlert(
          reqItem.id,
          reqItem.transaction_id,
          terminalUuid,
          destAddress,
          amountUsdt,
          reason
        )
      );
    };

    for (const req of requests) {
      if (isShuttingDown) break;

      const rawTxData = Array.isArray(req.transactions) ? req.transactions[0] : req.transactions;
      const rawDestData = Array.isArray(req.whitelist_addresses)
        ? req.whitelist_addresses[0]
        : req.whitelist_addresses;

      const classification = classifyApprovedWithdrawal(rawTxData, rawDestData);
      if (classification.kind === 'requeue_review') {
        console.warn(`[QUEUE GUARD] Request ${req.id}: ${classification.reason}`);
        const unsupportedPatch: Record<string, unknown> = { state: 'review' };
        if (withdrawalSchemaSupportsRetryCols) {
          unsupportedPatch.last_error = classification.reason.slice(0, 500);
          unsupportedPatch.last_attempt_at = new Date().toISOString();
        }
        await supabase
          .from('withdrawal_requests')
          .update(unsupportedPatch)
          .eq('id', req.id)
          .eq('state', 'approved');

        await recordWorkerAuditLog(supabase, {
          eventType: 'WITHDRAWAL_UNSUPPORTED_NETWORK',
          terminalId: classification.terminalId,
          severity: 'warn',
          details: `Moved approved request ${req.id} (tx ${req.transaction_id}) back to review: ${classification.reason}`,
        });

        await sendWorkerAlert(
          {
            severity: 'warn',
            eventType: 'WITHDRAWAL_UNSUPPORTED_NETWORK',
            title: 'Unsupported Withdrawal Returned to Review',
            message: classification.reason,
            metadata: {
              requestId: req.id,
              transactionId: req.transaction_id,
              terminalId: classification.terminalId,
              asset: classification.asset,
              network: classification.network,
              code: classification.code,
            },
          },
          { dedupeKey: `unsupported_net_${req.id}` }
        );
        continue;
      }

      const { txData, destData, netAmount, amountInUnits } = classification;
      const contract = await getUsdtContract();

      // 1. DUPLICATE-PAYOUT GUARD: Never re-broadcast if tx_hash or tx_hash_candidate already exists
      const existingHash = txData.tx_hash || req.tx_hash_candidate;
      if (existingHash || txData.status === 'completed') {
        console.warn(
          `[DUPLICATE GUARD] Request ${req.id} already has tx_hash=${existingHash ?? 'completed'}; reconciling without rebroadcast.`
        );
        if (existingHash) {
          try {
            await finalizeConfirmedWithdrawal(
              req.id,
              req.transaction_id,
              txData.terminal_id,
              netAmount,
              destData.address,
              existingHash
            );
          } catch (reconcileErr) {
            // W-23: Surface reconciliation failures via audit log & ops alert instead of swallowing
            const safeReconcileErr = sanitizeErrorMessage(
              reconcileErr,
              hotWalletResolution.privateKey
            );
            console.error(
              `[DUPLICATE GUARD RECONCILE FAILED] Request ${req.id}:`,
              safeReconcileErr
            );
            await recordWorkerAuditLog(supabase, {
              eventType: 'WITHDRAWAL_RECONCILE_FAILED',
              terminalId: txData.terminal_id,
              severity: 'critical',
              details: `Failed to reconcile existing withdrawal ${req.id} (tx ${req.transaction_id}, tx_hash=${existingHash}): ${safeReconcileErr}`,
            });
            await sendWorkerAlert(
              {
                severity: 'critical',
                eventType: 'WITHDRAWAL_RECONCILE_FAILED',
                title: 'Duplicate-Guard Withdrawal Reconciliation Failed',
                message: `Withdrawal request ${req.id} already has tx_hash=${existingHash}, but confirmation reconciliation failed: ${safeReconcileErr}`,
                metadata: {
                  requestId: req.id,
                  transactionId: req.transaction_id,
                  terminalId: txData.terminal_id,
                  txHash: existingHash,
                },
              },
              { dedupeKey: `reconcile_fail_${req.id}` }
            );
            continue;
          }
        } else {
          const { error: confirmErr } = await supabase
            .from('withdrawal_requests')
            .update({ state: 'confirmed' })
            .eq('id', req.id);
          if (confirmErr) {
            const safeConfirmErr = sanitizeErrorMessage(
              confirmErr.message,
              hotWalletResolution.privateKey
            );
            console.error(
              `[DUPLICATE GUARD STATE UPDATE FAILED] Request ${req.id}:`,
              safeConfirmErr
            );
            await sendWorkerAlert(
              {
                severity: 'critical',
                eventType: 'WITHDRAWAL_RECONCILE_FAILED',
                title: 'Duplicate-Guard State Confirmation Failed',
                message: `Withdrawal request ${req.id} transaction is completed, but confirmation update failed: ${safeConfirmErr}`,
                metadata: { requestId: req.id, transactionId: req.transaction_id },
              },
              { dedupeKey: `reconcile_fail_${req.id}` }
            );
            continue;
          }
        }
        await recordWorkerAuditLog(supabase, {
          eventType: 'WITHDRAWAL_DUPLICATE_PAYOUT_PREVENTED',
          terminalId: txData.terminal_id,
          severity: 'warn',
          details: `Skipped rebroadcast for request ${req.id} (tx ${req.transaction_id}); existing tx_hash=${existingHash ?? 'none'}.`,
        });
        continue;
      }

      // 1b. W-01 DESTINATION TRUST & TOCTOU GATE (runs strictly before policy/AML/claim)
      const trust = assessDestinationTrust(destData, req.destination_snapshot, (addr) =>
        tronWeb.isAddress(addr)
      );
      if (!trust.trusted) {
        const trustReason = trust.reason ?? 'Destination failed whitelist trust checks.';
        console.error(`[DESTINATION UNTRUSTED] Request ${req.id}: ${trustReason}`);

        const untrustedPatch: Record<string, unknown> = { state: 'review' };
        if (withdrawalSchemaSupportsRetryCols) {
          untrustedPatch.last_error = `DESTINATION_UNTRUSTED: ${trustReason}`.slice(0, 500);
          untrustedPatch.last_attempt_at = new Date().toISOString();
        }
        await supabase
          .from('withdrawal_requests')
          .update(untrustedPatch)
          .eq('id', req.id)
          .eq('state', 'approved');

        await recordWorkerAuditLog(supabase, {
          eventType: 'WITHDRAWAL_DESTINATION_UNTRUSTED',
          terminalId: txData.terminal_id,
          severity: 'critical',
          details: `Blocked payout for request ${req.id} (tx ${req.transaction_id}, ${netAmount} USDT -> ${destData.address}): ${trustReason}.`,
        });

        await sendWorkerAlert({
          severity: 'critical',
          eventType: 'WITHDRAWAL_DESTINATION_UNTRUSTED',
          title: 'Withdrawal Blocked: Untrusted Destination',
          message: `Request ${req.id} (${netAmount} USDT -> ${destData.address}) blocked: ${trustReason}`,
          metadata: {
            requestId: req.id,
            transactionId: req.transaction_id,
            terminalId: txData.terminal_id,
            address: destData.address,
            amountUsdt: netAmount,
            verifiedFlag: String(destData.verified),
          },
        });
        continue;
      }

      // 2. PRE-BROADCAST TERMINAL STATUS & POLICY/LIMIT GUARD (W-04)
      const { data: terminalRow, error: terminalErr } = await supabase
        .from('terminals')
        .select('id, terminal_id, status, per_tx_limit_usd, daily_limit_usd, allowed_assets')
        .eq('id', txData.terminal_id)
        .maybeSingle();

      if (terminalErr) {
        console.error(
          `[POLICY QUERY ERROR] Request ${req.id}:`,
          sanitizeErrorMessage(terminalErr.message, hotWalletResolution.privateKey)
        );
        continue;
      }

      const cutoffIso = new Date(Date.now() - 24 * 3600_000).toISOString();
      const { data: outflowRows, error: outflowErr } = await supabase
        .from('transactions')
        .select('id, asset, amount, status, created_at')
        .eq('terminal_id', txData.terminal_id)
        .eq('type', 'withdrawal')
        .neq('id', req.transaction_id)
        .gte('created_at', cutoffIso);

      if (outflowErr) {
        console.error(
          `[OUTFLOW QUERY ERROR] Request ${req.id}:`,
          sanitizeErrorMessage(outflowErr.message, hotWalletResolution.privateKey)
        );
        continue;
      }

      const prior24hOutflowUsd = computePrior24hOutflowUsd(
        (outflowRows ?? []) as OutflowTransactionRow[],
        req.transaction_id,
        ratesMap
      );

      const policyCheck = evaluateBroadcastPolicy({
        terminal: (terminalRow as TerminalPolicyRecord | null) ?? null,
        asset: txData.asset,
        amount: netAmount,
        usdRate: resolveUsdRate(txData.asset, ratesMap),
        prior24hOutflowUsd,
      });

      if (!policyCheck.allowed) {
        await rejectPolicyBlocked(
          req,
          txData.terminal_id,
          netAmount,
          destData.address,
          policyCheck.reason ?? 'Blocked by terminal policy guard.'
        );
        continue;
      }

      // 3. W-22: PRE-CLAIM AML DESTINATION SCREENING (keeps broadcast_at NULL if blocked)
      const amlResult = await screenWithdrawalDestination(
        supabase,
        tronWeb,
        destData.address,
        destData.network
      );

      if (!amlResult.allowed) {
        const blockReason = amlResult.reason ?? 'Destination flagged by AML screening.';
        const isUnavailable = amlResult.degraded === true;

        if (isUnavailable) {
          console.error(`[AML UNAVAILABLE] Request ${req.id} held (not blocked): ${blockReason}`);

          const unavailablePatch: Record<string, unknown> = { state: 'review' };
          if (withdrawalSchemaSupportsRetryCols) {
            unavailablePatch.last_error = `AML_UNAVAILABLE: ${blockReason}`.slice(0, 500);
            unavailablePatch.last_attempt_at = new Date().toISOString();
          }

          await supabase
            .from('withdrawal_requests')
            .update(unavailablePatch)
            .eq('id', req.id)
            .eq('state', 'approved');

          await recordWorkerAuditLog(supabase, {
            eventType: 'WITHDRAWAL_AML_UNAVAILABLE',
            terminalId: txData.terminal_id,
            severity: 'critical',
            details: `Held payout for request ${req.id} (tx ${req.transaction_id}, ${netAmount} USDT -> ${destData.address}) because AML screening could not run: ${blockReason} [source=${amlResult.source ?? 'aml'}]. No funds were broadcast.`,
          });

          await sendWorkerAlert({
            severity: 'critical',
            eventType: 'WITHDRAWAL_AML_UNAVAILABLE',
            title: 'Withdrawal Held: AML Screening Unavailable',
            message: `Request ${req.id} (${netAmount} USDT -> ${destData.address}) was NOT broadcast. ${blockReason}`,
            metadata: {
              requestId: req.id,
              transactionId: req.transaction_id,
              terminalId: txData.terminal_id,
              address: destData.address,
              amountUsdt: netAmount,
              amlSource: amlResult.source ?? 'aml',
            },
          });
          continue;
        }

        console.error(`[AML BLOCKED] Request ${req.id}: ${blockReason}`);

        const reviewPatch: Record<string, unknown> = { state: 'review' };
        if (withdrawalSchemaSupportsRetryCols) {
          reviewPatch.last_error = `AML_BLOCKED: ${blockReason}`.slice(0, 500);
          reviewPatch.last_attempt_at = new Date().toISOString();
        }

        await supabase
          .from('withdrawal_requests')
          .update(reviewPatch)
          .eq('id', req.id)
          .eq('state', 'approved');

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

      // 4. ATOMIC LOCK & POLICY-ENFORCED CLAIM: prefer migration 006 RPC; fallback cleanly if pending
      const rpcClaim = await supabase.rpc('claim_approved_withdrawal_for_broadcast', {
        p_request_id: req.id,
      });

      let claimed = false;
      if (!rpcClaim.error) {
        claimed = Boolean(rpcClaim.data);
        if (!claimed) continue;
      } else {
        const errMsg = rpcClaim.error.message ?? '';
        const errCode = (rpcClaim.error as { code?: string }).code ?? '';
        const rpcMissing =
          errCode === 'PGRST202' ||
          errCode === '42883' ||
          errMsg.includes('claim_approved_withdrawal_for_broadcast');

        if (!rpcMissing) {
          await rejectPolicyBlocked(
            req,
            txData.terminal_id,
            netAmount,
            destData.address,
            errMsg || 'Atomic broadcast claim denied by database policy.'
          );
          continue;
        }

        const { data: claimedRows, error: claimError } = await supabase
          .from('withdrawal_requests')
          .update({ state: 'broadcast', broadcast_at: new Date().toISOString() })
          .eq('id', req.id)
          .eq('state', 'approved')
          .select('id');

        if (claimError || !claimedRows || claimedRows.length === 0) continue;
        claimed = true;
      }

      if (!claimed) continue;

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
          if (!obtainedTxHash) {
            obtainedTxHash = extractTxIdFromError(sendErr);
          }
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

async function acquireWorkerCycleLease(): Promise<boolean> {
  if (!workerLeaseRpcSupported) return true;
  try {
    const res = await supabase.rpc('acquire_worker_lease', {
      p_worker_key: WORKER_LEASE_KEY,
      p_instance_id: WORKER_INSTANCE_ID,
      p_ttl_seconds: WORKER_LEASE_TTL_SECONDS,
    });
    if (!res.error) {
      return Boolean(res.data);
    }
    const errMsg = res.error.message ?? '';
    const errCode = (res.error as { code?: string }).code ?? '';
    if (
      errCode === 'PGRST202' ||
      errCode === '42883' ||
      errMsg.includes('acquire_worker_lease')
    ) {
      workerLeaseRpcSupported = false;
      if (!leaseRpcMissingWarned) {
        leaseRpcMissingWarned = true;
        console.warn(
          '[WORKER LEASE] RPC acquire_worker_lease not found; apply migration 008 for multi-replica lease enforcement. Run single replica only.'
        );
      }
      return true;
    }
    console.warn(
      '[WORKER LEASE ERROR]',
      sanitizeErrorMessage(errMsg, hotWalletResolution.privateKey)
    );
    return false;
  } catch (err) {
    console.warn(
      '[WORKER LEASE EXCEPTION]',
      sanitizeErrorMessage(err, hotWalletResolution.privateKey)
    );
    return false;
  }
}

async function releaseWorkerCycleLease(): Promise<void> {
  if (!workerLeaseRpcSupported) return;
  try {
    await supabase.rpc('release_worker_lease', {
      p_worker_key: WORKER_LEASE_KEY,
      p_instance_id: WORKER_INSTANCE_ID,
    });
  } catch {
    // TTL expiration will release lease automatically if transient error occurs
  }
}

// Start continuous worker loop with concurrency guard, DB lease lock & graceful shutdown draining
const INTERVAL = Number(process.env.POLL_INTERVAL_MS) || 15000;
let isRunning = false;
let activeCyclePromise: Promise<void> | null = null;

console.log(
  `NTPS TRON Worker started (instance=${WORKER_INSTANCE_ID}, tronHost=${TRON_FULL_HOST}, keySource=${hotWalletResolution.source}${hotWalletResolution.envelopeVersion ? `:${hotWalletResolution.envelopeVersion}` : ''}). Polling every ${INTERVAL / 1000}s...`
);

async function runPollCycle(): Promise<void> {
  if (isRunning || isShuttingDown) return;
  isRunning = true;
  const cycle = (async () => {
    let leaseHeld = false;
    try {
      leaseHeld = await acquireWorkerCycleLease();
      if (!leaseHeld) {
        console.warn(
          `[WORKER LEASE BUSY] Another worker instance holds "${WORKER_LEASE_KEY}"; skipping cycle.`
        );
        return;
      }
      await reconcileStaleBroadcastWithdrawals();
      if (isShuttingDown) return;
      await watchDeposits();
      if (isShuttingDown) return;
      await processApprovedWithdrawals();
    } finally {
      if (leaseHeld) {
        await releaseWorkerCycleLease();
      }
      isRunning = false;
      activeCyclePromise = null;
    }
  })();

  activeCyclePromise = cycle;
  await cycle;
}

const pollTimer = setInterval(() => {
  void runPollCycle();
}, INTERVAL);

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearInterval(pollTimer);
  console.log(`[SHUTDOWN] Received ${signal}. Waiting for active poll cycle to finish...`);

  if (activeCyclePromise) {
    const drainTimeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.warn('[SHUTDOWN] Drain timeout reached; exiting.');
        resolve();
      }, 25_000);
      timer.unref();
    });
    await Promise.race([activeCyclePromise, drainTimeout]);
  }

  console.log('[SHUTDOWN] Clean exit.');
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

void runPollCycle();

