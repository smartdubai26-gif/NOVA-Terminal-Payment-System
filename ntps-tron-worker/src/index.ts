import { createClient } from '@supabase/supabase-js';
import { TronWeb } from 'tronweb';
import * as dotenv from 'dotenv';
import { resolveHotWalletPrivateKey } from './cryptoKey';
import { recordWorkerAuditLog, sanitizeErrorMessage } from './auditLog';
import { sendWorkerAlert } from './alerts';
import { screenWithdrawalDestination } from './aml';
import {
  USDT_DECIMALS,
  toTokenUnits,
  extractTxIdFromError,
  assessDestinationTrust,
} from './guards';

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

// W-02: النافذة الزمنية اللي بنرجع نبحث فيها على الشبكة عند حالة بث غير مؤكدة.
// أي تحويل خرج من محفظتنا لنفس العنوان بنفس المبلغ خلال النافذة دي يُعتبر
// "التحويل اللي إحنا بندور عليه" — وده اللي بيمنع الدفع المزدوج.
const BROADCAST_UNCERTAINTY_WINDOW_MS = Math.max(
  60_000,
  Number(process.env.BROADCAST_UNCERTAINTY_WINDOW_MS) || 15 * 60 * 1000
);

// W-02b: الطلبات اللي عالقة في حالة 'broadcast' أطول من المدة دي بتتسوّى
// تلقائيًا (إما تتأكد من الشبكة أو ترجع للمراجعة اليدوية).
const STALE_BROADCAST_MINUTES = Math.max(
  5,
  Number(process.env.STALE_BROADCAST_MINUTES) || 20
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
  from?: string;
  to?: string;
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

interface WhitelistRel {
  address: string;
  network: string;
  verified?: boolean | null;
}

interface WithdrawalTxRel {
  terminal_id: string;
  asset: string;
  amount: number;
  fee: number;
  status: string;
  tx_hash: string | null;
}

interface WithdrawalRow {
  id: string;
  transaction_id: string;
  state: string;
  attempt_count?: number;
  tx_hash_candidate?: string | null;
  destination_snapshot?: string | null;
  whitelist_addresses: WhitelistRel | WhitelistRel[] | null;
  transactions: WithdrawalTxRel | WithdrawalTxRel[] | null;
}

interface StaleBroadcastRow {
  id: string;
  transaction_id: string;
  broadcast_at: string | null;
  tx_hash_candidate: string | null;
  whitelist_addresses: WhitelistRel | WhitelistRel[] | null;
  transactions: WithdrawalTxRel | WithdrawalTxRel[] | null;
}

// Fallback cursor map used only if migration 004 (`last_polled_timestamp_ms`) is not yet applied
const memoryCursorFallback = new Map<string, number>();
let depositSchemaSupportsCursor = true;
let withdrawalSchemaSupportsRetryCols = true;
// W-01: عمود `verified` موجود في الـ schema الأساسي، لكن بنحتفظ بعلم مستقل
// عشان لو قاعدة قديمة مش فيه، البوابة تفشل "مغلقة" بدل ما تفشل "مفتوحة".
let withdrawalSchemaSupportsVerified = true;
// W-01: عمود `destination_snapshot` بييجي من migration 007 (حماية TOCTOU).
let withdrawalSchemaSupportsSnapshot = true;
let consecutivePollFailures = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffDelayMs(attempt: number): number {
  const exp = RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return exp + jitter;
}

let cachedHotWalletAddress: string | null = null;

function getHotWalletAddress(): string | null {
  if (cachedHotWalletAddress) return cachedHotWalletAddress;
  const addr = tronWeb.defaultAddress?.base58;
  if (typeof addr === 'string' && addr.length > 0) {
    cachedHotWalletAddress = addr;
    return addr;
  }
  return null;
}

type OnChainTxState = 'confirmed' | 'failed' | 'not_found' | 'unknown';

/**
 * W-02: تحديد حالة معاملة على شبكة TRON.
 * - confirmed: موجودة ونجحت
 * - failed: موجودة لكنها reverted (آمن نعيد المحاولة)
 * - not_found: مش موجودة خالص (آمن نعيد المحاولة)
 * - unknown: الشبكة مش رادة / الحالة مش واضحة (مش آمن نعيد المحاولة)
 */
async function confirmOnChain(txHash: string): Promise<OnChainTxState> {
  try {
    const info = await tronWeb.trx.getTransactionInfo(txHash);
    if (info && typeof info === 'object' && (info as { id?: string }).id) {
      const receipt = (info as { receipt?: { result?: string } }).receipt;
      if (receipt?.result === 'SUCCESS') return 'confirmed';
      if (receipt?.result) return 'failed';
      return 'unknown';
    }

    const tx = await tronWeb.trx.getTransaction(txHash);
    if (tx && typeof tx === 'object' && (tx as { txID?: string }).txID) {
      // موجودة في الشبكة/الذاكرة لكن لسه مش متأكدة — تُعتبر مبعوتة
      return 'confirmed';
    }
    return 'not_found';
  } catch {
    return 'unknown';
  }
}

interface OutboundLookup {
  status: 'found' | 'not_found' | 'unknown';
  txHash?: string;
  detail?: string;
}

/**
 * W-02: البحث على الشبكة عن تحويل TRC-20 خارج من محفظتنا الساخنة
 * لنفس العنوان المستهدف وبنفس المبلغ بالظبط، خلال نافذة زمنية.
 * ده هو "المصدر الوحيد للحقيقة" قبل أي إعادة بث.
 */
async function findRecentOutboundTransfer(
  destAddress: string,
  amountUnits: number,
  sinceMs: number
): Promise<OutboundLookup> {
  const hotAddress = getHotWalletAddress();
  if (!hotAddress) {
    return { status: 'unknown', detail: 'hot wallet address unavailable' };
  }

  const url =
    `${TRON_FULL_HOST}/v1/accounts/${hotAddress}/transactions/trc20` +
    `?only_confirmed=false&only_from=true&contract_address=${USDT_CONTRACT}` +
    `&limit=200&order_by=block_timestamp,desc&min_timestamp=${Math.max(0, sinceMs)}`;

  let payload: TronGridResponse;
  try {
    const response = await fetch(url, {
      headers: TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { status: 'unknown', detail: `TronGrid HTTP ${response.status}` };
    }
    payload = (await response.json()) as TronGridResponse;
  } catch (err) {
    return {
      status: 'unknown',
      detail: sanitizeErrorMessage(err, hotWalletResolution.privateKey),
    };
  }

  if (payload?.error) {
    return { status: 'unknown', detail: String(payload.error) };
  }

  const rows = Array.isArray(payload?.data) ? payload.data : [];
  for (const row of rows) {
    const to = String(row?.to ?? '');
    const value = Number(row?.value ?? 0);
    if (to === destAddress && Number.isFinite(value) && value === amountUnits) {
      return { status: 'found', txHash: String(row.transaction_id) };
    }
  }

  return { status: 'not_found' };
}

interface BroadcastResolution {
  outcome: 'confirmed' | 'not_found' | 'unknown';
  txHash?: string;
  detail?: string;
}

/**
 * W-02: تسوية نتيجة بث غير مؤكدة.
 * القاعدة الذهبية: لا نعيد البث إلا لو أثبتنا إن التحويل **لم يحدث**.
 */
async function resolveUncertainBroadcast(
  candidateHash: string | null,
  destAddress: string,
  amountUnits: number,
  sinceMs: number
): Promise<BroadcastResolution> {
  if (candidateHash) {
    const state = await confirmOnChain(candidateHash);
    if (state === 'confirmed') {
      return { outcome: 'confirmed', txHash: candidateHash };
    }
    if (state === 'unknown') {
      return {
        outcome: 'unknown',
        detail: `state of tx ${candidateHash} could not be determined`,
      };
    }
    if (state === 'failed') {
      // المعاملة موجودة لكنها reverted → الفلوس ما اتحولتش، آمن نعيد
      return { outcome: 'not_found', detail: `tx ${candidateHash} reverted on chain` };
    }
    // 'not_found' → الهاش ما وصلش الشبكة، بس لسه بنعمل بحث احتياطي
  }

  const lookup = await findRecentOutboundTransfer(destAddress, amountUnits, sinceMs);
  if (lookup.status === 'found' && lookup.txHash) {
    return { outcome: 'confirmed', txHash: lookup.txHash };
  }
  if (lookup.status === 'unknown') {
    return { outcome: 'unknown', detail: lookup.detail ?? 'TronGrid lookup failed' };
  }
  return { outcome: 'not_found' };
}

interface DestinationTrust {
  trusted: boolean;
  reason?: string;
}

/**
 * W-01: بوابة الثقة في العنوان المستهدف.
 * بتتنفّذ **قبل** أي claim أو بث، وبترفض:
 *  1. أي صف مش موثّق صريحًا (`verified !== true`) — مش بنعتمد على default
 *  2. أي عنوان مش صالح كـ TRON Base58Check
 *  3. أي عنوان اتغيّر بعد الموافقة (TOCTOU) بمقارنته بالـ snapshot
 */
async function evaluateDestinationTrust(
  dest: WhitelistRel,
  snapshot: string | null | undefined
): Promise<DestinationTrust> {
  // المنطق النقي في guards.ts (قابل للاختبار)، والتحقق من صيغة العنوان
  // بيتحقن من TronWeb عشان يفضل مصدر واحد للحقيقة.
  return assessDestinationTrust(dest, snapshot, (addr) => tronWeb.isAddress(addr));
}

/**
 * إرجاع طلب سحب للمراجعة اليدوية مع تسجيل السبب.
 */
async function parkWithdrawalForReview(
  reqId: string,
  reason: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const patch: Record<string, unknown> = { state: 'review', ...extra };

  if (withdrawalSchemaSupportsRetryCols) {
    patch.last_error = reason.slice(0, 500);
    patch.last_attempt_at = new Date().toISOString();
  } else {
    delete patch.tx_hash_candidate;
  }

  const { error } = await supabase
    .from('withdrawal_requests')
    .update(patch)
    .eq('id', reqId);

  if (error) {
    console.error(`[WITHDRAWAL] Failed to park request ${reqId} for review:`, error.message);
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
 * بناء قائمة الأعمدة المطلوبة ديناميكيًا حسب ما هو متاح فعليًا في القاعدة،
 * عشان الـ worker يفضل شغّال حتى لو بعض الـ migrations لسه ما اتطبّقتش.
 */
function buildWithdrawalSelectCols(): string {
  const reqCols = ['id', 'transaction_id', 'state'];
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

async function fetchApprovedWithdrawals(): Promise<WithdrawalRow[]> {
  for (let guard = 0; guard < 4; guard += 1) {
    const res = await supabase
      .from('withdrawal_requests')
      .select(buildWithdrawalSelectCols())
      .eq('state', 'approved')
      .limit(5);

    if (!res.error) {
      return (res.data ?? []) as unknown as WithdrawalRow[];
    }

    const msg = res.error.message;
    let flipped = false;

    if (msg.includes('destination_snapshot') && withdrawalSchemaSupportsSnapshot) {
      withdrawalSchemaSupportsSnapshot = false;
      flipped = true;
      console.warn(
        '[WITHDRAWAL] destination_snapshot column missing; apply migration 007 for TOCTOU protection.'
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
 * with destination trust gating (W-01), duplicate-payout guards,
 * AML screening, and uncertainty-aware retry (W-02).
 */
async function processApprovedWithdrawals(): Promise<void> {
  try {
    const requests = await fetchApprovedWithdrawals();
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
      const amountUnits = toTokenUnits(netAmount);

      if (!Number.isFinite(netAmount) || amountUnits <= 0) {
        await recordWorkerAuditLog(supabase, {
          eventType: 'WITHDRAWAL_AMOUNT_INVALID',
          terminalId: txData.terminal_id,
          severity: 'critical',
          details: `Request ${req.id} has an amount that is not representable at ${USDT_DECIMALS} decimals (${String(txData.amount)}); refusing to broadcast.`,
        });
        continue;
      }

      // ------------------------------------------------------------------
      // W-01: DESTINATION TRUST GATE
      // بيتنفّذ قبل أي claim أو بث. لو العنوان مش موثّق صريحًا، أو اتغيّر
      // بعد الموافقة، الطلب بيرجع للمراجعة اليدوية فورًا.
      // ------------------------------------------------------------------
      const trust = await evaluateDestinationTrust(destData, req.destination_snapshot);

      if (!trust.trusted) {
        const reason = trust.reason ?? 'destination failed trust checks';
        console.error(`[DESTINATION UNTRUSTED] Request ${req.id}: ${reason}`);

        await parkWithdrawalForReview(req.id, `DESTINATION_UNTRUSTED: ${reason}`);

        await recordWorkerAuditLog(supabase, {
          eventType: 'WITHDRAWAL_DESTINATION_UNTRUSTED',
          terminalId: txData.terminal_id,
          severity: 'critical',
          details: `Blocked payout for request ${req.id} (tx ${req.transaction_id}, ${netAmount} USDT -> ${destData.address}): ${reason}.`,
        });

        await sendWorkerAlert({
          severity: 'critical',
          eventType: 'WITHDRAWAL_DESTINATION_UNTRUSTED',
          title: 'Withdrawal Blocked: Untrusted Destination',
          message: `Request ${req.id} (${netAmount} USDT -> ${destData.address}) blocked: ${reason}`,
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

        // ------------------------------------------------------------------
        // W-03: نفرّق بين "العنوان محظور فعلاً" و"مش قادرين نفحص".
        //
        // الاتنين بيمنعوا البث (fail-closed)، لكن دلالتهم مختلفة تمامًا:
        //   - محظور: قرار امتثال نهائي. الطلب يفضل في المراجعة لحد ما الامتثال
        //     يقرر، ومينفعش يتبعت تاني من غير تدخل بشري.
        //   - غير متاح: عطل تقني (قاعدة بيانات/شبكة/جدول ناقص). الطلب يترجع
        //     للمراجعة كإجراء مؤقت، والـ worker هيحاول تاني في الدورة الجاية
        //     بعد ما العطل يتصلّح — من غير ما حد يفتحه يدويًا.
        // ------------------------------------------------------------------
        const isUnavailable = amlResult.degraded === true;

        if (isUnavailable) {
          console.error(`[AML UNAVAILABLE] Request ${req.id} held (not blocked): ${blockReason}`);

          await parkWithdrawalForReview(req.id, `AML_UNAVAILABLE: ${blockReason}`);

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

        await parkWithdrawalForReview(req.id, `AML_BLOCKED: ${blockReason}`);

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

      // ------------------------------------------------------------------
      // W-02: BROADCAST WITH UNCERTAINTY RECONCILIATION
      // القاعدة: ممنوع إعادة البث إلا بعد إثبات إن التحويل لم يحدث على الشبكة.
      // ------------------------------------------------------------------
      const broadcastWindowStart = Date.now() - BROADCAST_UNCERTAINTY_WINDOW_MS;

      let obtainedTxHash: string | null = null;
      let finalErrorMsg = '';
      let succeeded = false;
      let parkedUncertain = false;

      // W-02(a): تسوية قبل البث — لو نسخة سابقة من الـ worker بثّت الطلب
      // ووقعت قبل ما تحفظ الهاش، بنكتشف ده من الشبكة بدل ما نبعت تاني.
      const preCheck = await findRecentOutboundTransfer(
        destData.address,
        amountUnits,
        broadcastWindowStart
      );

      if (preCheck.status === 'unknown') {
        // W-02: مش قادرين نتحقق من الشبكة قبل البث. البث من غير فحص قبلي
        // هو بالظبط السيناريو اللي بيسبب الدفع المزدوج، فبنفشل مغلق:
        // الطلب بيرجع للمراجعة اليدوية بدل ما نبعت على أمل إنه ما اتبعتش.
        const reason = `PREBROADCAST_CHECK_UNAVAILABLE: ${
          preCheck.detail ?? 'could not query chain before broadcast'
        }`;

        console.error(`[PRE-BROADCAST CHECK FAILED] Request ${req.id}: ${reason}`);

        await parkWithdrawalForReview(req.id, reason);

        await recordWorkerAuditLog(supabase, {
          eventType: 'WITHDRAWAL_PREBROADCAST_CHECK_FAILED',
          terminalId: txData.terminal_id,
          severity: 'critical',
          details: `Refused to broadcast request ${req.id} (${netAmount} USDT -> ${destData.address}) because the pre-broadcast chain check failed: ${reason}`,
        });

        await sendWorkerAlert({
          severity: 'critical',
          eventType: 'WITHDRAWAL_PREBROADCAST_CHECK_FAILED',
          title: 'Withdrawal Held: Pre-Broadcast Chain Check Failed',
          message: `Request ${req.id} (${netAmount} USDT -> ${destData.address}) was NOT broadcast. Reason: ${reason}`,
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

      if (preCheck.status === 'found' && preCheck.txHash) {
        obtainedTxHash = preCheck.txHash;
        console.warn(
          `[PRE-BROADCAST RECONCILE] Request ${req.id} already has on-chain transfer ${obtainedTxHash}; finalizing without rebroadcast.`
        );

        await recordWorkerAuditLog(supabase, {
          eventType: 'WITHDRAWAL_PREBROADCAST_RECONCILED',
          terminalId: txData.terminal_id,
          severity: 'warn',
          details: `Found existing on-chain transfer ${obtainedTxHash} for request ${req.id} before broadcasting; no new transfer was sent.`,
        });

        try {
          await finalizeConfirmedWithdrawal(
            req.id,
            req.transaction_id,
            txData.terminal_id,
            netAmount,
            destData.address,
            obtainedTxHash
          );
          succeeded = true;
        } catch (finalizeErr) {
          finalErrorMsg = sanitizeErrorMessage(finalizeErr, hotWalletResolution.privateKey);
        }
      }

      for (let attempt = 1; !succeeded && attempt <= MAX_BROADCAST_ATTEMPTS; attempt += 1) {
        if (withdrawalSchemaSupportsRetryCols) {
          await supabase
            .from('withdrawal_requests')
            .update({
              // إصلاح مصاحب: كان بيجمع (base + attempt) فيتضاعف العدّاد
              attempt_count: (req.attempt_count ?? 0) + 1,
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
            obtainedTxHash = (await contract.transfer(destData.address, amountUnits).send({
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
          // W-02(b): لو الخطأ نفسه شايل txid، يبقى البث ممكن يكون نجح.
          // بنلتقطه قبل التنقيح لأنه 64-hex وsanitize بتحجبه.
          const errTxId = extractTxIdFromError(sendErr);
          if (errTxId && !obtainedTxHash) {
            obtainedTxHash = errTxId;
            console.warn(
              `[WITHDRAWAL] Error carried txid ${errTxId}; treating as possibly broadcast.`
            );
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
            details: `Attempt ${attempt}/${MAX_BROADCAST_ATTEMPTS} failed for request ${req.id} (tx ${req.transaction_id}): ${finalErrorMsg}${obtainedTxHash ? ` [tx_hash=${obtainedTxHash} cached]` : ''}.`,
          });

          // W-02(c): تسوية النتيجة قبل أي إعادة بث
          const resolution = await resolveUncertainBroadcast(
            obtainedTxHash,
            destData.address,
            amountUnits,
            broadcastWindowStart
          );

          if (resolution.outcome === 'confirmed' && resolution.txHash) {
            try {
              await finalizeConfirmedWithdrawal(
                req.id,
                req.transaction_id,
                txData.terminal_id,
                netAmount,
                destData.address,
                resolution.txHash
              );
              succeeded = true;
            } catch (finalizeErr) {
              finalErrorMsg = sanitizeErrorMessage(finalizeErr, hotWalletResolution.privateKey);
              parkedUncertain = true;
            }
            break;
          }

          if (resolution.outcome === 'unknown') {
            // مش قادرين نثبت إن التحويل حصل ولا لأ → ممنوع إعادة البث
            parkedUncertain = true;
            finalErrorMsg = `BROADCAST_UNCERTAIN: ${
              resolution.detail ?? 'chain state could not be verified'
            }`;
            break;
          }

          // outcome === 'not_found' → التحويل لم يحدث، إعادة المحاولة آمنة
          if (attempt < MAX_BROADCAST_ATTEMPTS) {
            await sleep(computeBackoffDelayMs(attempt));
          }
        }
      }

      if (!succeeded) {
        const reason = finalErrorMsg || 'broadcast failed';

        await parkWithdrawalForReview(req.id, reason, {
          tx_hash_candidate: obtainedTxHash,
        });

        await recordWorkerAuditLog(supabase, {
          eventType: parkedUncertain
            ? 'WITHDRAWAL_BROADCAST_UNCERTAIN'
            : 'WITHDRAWAL_BROADCAST_FAILED',
          terminalId: txData.terminal_id,
          severity: 'critical',
          details: `Broadcast did not complete for request ${req.id} (tx ${req.transaction_id}): ${netAmount} USDT (TRC20) -> ${destData.address}. Returned to manual review. Reason: ${reason}`,
        });

        await sendWorkerAlert({
          severity: 'critical',
          eventType: parkedUncertain
            ? 'WITHDRAWAL_BROADCAST_UNCERTAIN'
            : 'WITHDRAWAL_BROADCAST_EXHAUSTED',
          title: parkedUncertain
            ? 'TRON Withdrawal Broadcast Outcome Uncertain'
            : 'TRON Withdrawal Broadcast Exhausted Retries',
          message: `Withdrawal request ${req.id} (${netAmount} USDT -> ${destData.address}) returned to manual review. Reason: ${reason}`,
          metadata: {
            requestId: req.id,
            transactionId: req.transaction_id,
            terminalId: txData.terminal_id,
            address: destData.address,
            amountUsdt: netAmount,
            cachedTxHash: obtainedTxHash,
            uncertain: parkedUncertain,
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

/**
 * W-02b: تسوية الطلبات العالقة في حالة 'broadcast'.
 * لو الـ worker وقع بعد الـ claim وقبل حفظ الهاش، الصف بيفضل 'broadcast'
 * للأبد — وأي إعادة موافقة يدوية عليه بتبقى دفع مزدوج. الدالة دي بتقفل
 * الثغرة: بتدور على الشبكة، ولو مفيش تحويل بترجّع الطلب للمراجعة.
 */
async function reconcileStaleBroadcasts(): Promise<void> {
  if (!withdrawalSchemaSupportsRetryCols) return;

  try {
    const cutoffIso = new Date(Date.now() - STALE_BROADCAST_MINUTES * 60_000).toISOString();

    const { data, error } = await supabase
      .from('withdrawal_requests')
      .select(
        `id, transaction_id, broadcast_at, tx_hash_candidate, whitelist_addresses(address, network), transactions(terminal_id, asset, amount, status, tx_hash)`
      )
      .eq('state', 'broadcast')
      .lt('broadcast_at', cutoffIso)
      .limit(10);

    if (error) {
      console.error('[STALE BROADCAST] query failed:', error.message);
      return;
    }

    const rows = (data ?? []) as unknown as StaleBroadcastRow[];
    if (rows.length === 0) return;

    for (const row of rows) {
      const txData = Array.isArray(row.transactions) ? row.transactions[0] : row.transactions;
      const destData = Array.isArray(row.whitelist_addresses)
        ? row.whitelist_addresses[0]
        : row.whitelist_addresses;

      if (!txData || !destData) continue;
      if (txData.asset !== 'USDT' || destData.network !== 'TRC20') continue;

      const netAmount = Number(txData.amount);
      const amountUnits = toTokenUnits(netAmount);
      if (amountUnits <= 0) continue;

      const sinceMs = row.broadcast_at
        ? new Date(row.broadcast_at).getTime() - 60_000
        : Date.now() - BROADCAST_UNCERTAINTY_WINDOW_MS;

      const resolution = await resolveUncertainBroadcast(
        row.tx_hash_candidate ?? null,
        destData.address,
        amountUnits,
        sinceMs
      );

      if (resolution.outcome === 'confirmed' && resolution.txHash) {
        try {
          await finalizeConfirmedWithdrawal(
            row.id,
            row.transaction_id,
            txData.terminal_id,
            netAmount,
            destData.address,
            resolution.txHash
          );
          await recordWorkerAuditLog(supabase, {
            eventType: 'WITHDRAWAL_STALE_BROADCAST_RECONCILED',
            terminalId: txData.terminal_id,
            severity: 'warn',
            details: `Stale 'broadcast' request ${row.id} reconciled to confirmed via on-chain tx ${resolution.txHash}.`,
          });
        } catch (err) {
          console.error(
            '[STALE BROADCAST] finalize failed:',
            sanitizeErrorMessage(err, hotWalletResolution.privateKey)
          );
        }
        continue;
      }

      if (resolution.outcome === 'not_found') {
        await parkWithdrawalForReview(
          row.id,
          `STALE_BROADCAST_NO_ONCHAIN_TX: no matching transfer found after ${STALE_BROADCAST_MINUTES}m; returned to review for manual decision.`
        );

        await recordWorkerAuditLog(supabase, {
          eventType: 'WITHDRAWAL_STALE_BROADCAST_RETURNED',
          terminalId: txData.terminal_id,
          severity: 'critical',
          details: `Stale 'broadcast' request ${row.id} has no matching on-chain transfer; returned to review. Verify manually before re-approving.`,
        });

        await sendWorkerAlert(
          {
            severity: 'critical',
            eventType: 'WITHDRAWAL_STALE_BROADCAST',
            title: 'Stale Broadcast Returned to Review',
            message: `Request ${row.id} (${netAmount} USDT -> ${destData.address}) was stuck in 'broadcast' with no on-chain transfer. Returned to review.`,
            metadata: {
              requestId: row.id,
              transactionId: row.transaction_id,
              address: destData.address,
              amountUsdt: netAmount,
            },
          },
          { dedupeKey: `stale_broadcast_${row.id}` }
        );
      }
      // 'unknown' → نسيبه في 'broadcast' ونحاول تاني في الدورة الجاية
    }
  } catch (err) {
    console.error(
      '[STALE BROADCAST EXCEPTION]:',
      sanitizeErrorMessage(err, hotWalletResolution.privateKey)
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
    await reconcileStaleBroadcasts();
  } finally {
    isRunning = false;
  }
}, INTERVAL);
