import crypto from 'node:crypto';

export interface WithdrawalQueueTxInfo {
  terminal_id: string;
  asset: string;
  amount: number;
  fee: number;
  status: string;
  tx_hash: string | null;
}

export interface WithdrawalQueueDestInfo {
  address: string;
  network: string;
}

export type WithdrawalClassification =
  | {
      kind: 'executable';
      txData: WithdrawalQueueTxInfo;
      destData: WithdrawalQueueDestInfo;
      netAmount: number;
      amountInUnits: number;
    }
  | {
      kind: 'requeue_review';
      code:
        | 'MISSING_RELATION'
        | 'UNSUPPORTED_NETWORK_FOR_WORKER'
        | 'INVALID_WITHDRAWAL_AMOUNT';
      reason: string;
      terminalId: string | null;
      asset: string | null;
      network: string | null;
    };

/**
 * Classifies queued `approved` withdrawal items deterministically so unsupported
 * assets/networks or malformed rows move back to `review` instead of starving TRC-20 items.
 */
export function classifyApprovedWithdrawal(
  txData: WithdrawalQueueTxInfo | null | undefined,
  destData: WithdrawalQueueDestInfo | null | undefined
): WithdrawalClassification {
  if (!txData || !destData) {
    return {
      kind: 'requeue_review',
      code: 'MISSING_RELATION',
      reason:
        'UNSUPPORTED_NETWORK_FOR_WORKER: Missing linked transaction or whitelist destination row; moved back to manual review.',
      terminalId: txData?.terminal_id ?? null,
      asset: txData?.asset ?? null,
      network: destData?.network ?? null,
    };
  }

  if (txData.asset !== 'USDT' || destData.network !== 'TRC20') {
    return {
      kind: 'requeue_review',
      code: 'UNSUPPORTED_NETWORK_FOR_WORKER',
      reason: `UNSUPPORTED_NETWORK_FOR_WORKER: Worker only broadcasts USDT (TRC20); got ${txData.asset} (${destData.network}).`,
      terminalId: txData.terminal_id,
      asset: txData.asset,
      network: destData.network,
    };
  }

  const netAmount = Number(txData.amount);
  const amountInUnits = Math.floor(netAmount * 1_000_000);
  if (!Number.isFinite(netAmount) || amountInUnits <= 0) {
    return {
      kind: 'requeue_review',
      code: 'INVALID_WITHDRAWAL_AMOUNT',
      reason: `INVALID_WITHDRAWAL_AMOUNT: Computed amount (${txData.amount}) is non-positive or invalid.`,
      terminalId: txData.terminal_id,
      asset: txData.asset,
      network: destData.network,
    };
  }

  return {
    kind: 'executable',
    txData,
    destData,
    netAmount,
    amountInUnits,
  };
}

/**
 * Advances a per-address deposit timestamp cursor monotonically unless a credit failure occurred.
 */
export function advanceDepositCursor(
  currentCursorMs: number,
  txTimestampMs: number,
  addressHadCreditError: boolean
): number {
  if (
    !addressHadCreditError &&
    Number.isFinite(txTimestampMs) &&
    txTimestampMs > currentCursorMs
  ) {
    return txTimestampMs;
  }
  return currentCursorMs;
}

/**
 * Ensures polling error checkpoints never overwrite a previously persisted non-zero cursor with `0`.
 */
export function preserveGlobalCursorOnError(
  lastKnownCursorMs: number,
  currentBatchCursorMs = 0
): number {
  const safeKnown =
    Number.isFinite(lastKnownCursorMs) && lastKnownCursorMs > 0 ? lastKnownCursorMs : 0;
  const safeBatch =
    Number.isFinite(currentBatchCursorMs) && currentBatchCursorMs > 0
      ? currentBatchCursorMs
      : 0;
  return Math.max(safeKnown, safeBatch);
}

export type StaleBroadcastDisposition =
  | { action: 'finalize_with_hash'; txHash: string }
  | { action: 'requeue_review'; reason: string };

/**
 * Determines how a withdrawal stuck in `state = 'broadcast'` past the stale threshold
 * should be reconciled: finalize if an on-chain hash was recorded, else return to `review`.
 */
export function resolveStaleBroadcastAction(params: {
  txHash: string | null | undefined;
  txHashCandidate: string | null | undefined;
  broadcastAtIso: string | null | undefined;
}): StaleBroadcastDisposition {
  const resolvedHash =
    (typeof params.txHash === 'string' && params.txHash.trim()) ||
    (typeof params.txHashCandidate === 'string' && params.txHashCandidate.trim()) ||
    '';

  if (resolvedHash) {
    return { action: 'finalize_with_hash', txHash: resolvedHash };
  }

  return {
    action: 'requeue_review',
    reason: `STALE_BROADCAST_RECONCILED: Withdrawal exceeded broadcast timeout (started ${params.broadcastAtIso ?? 'unknown'}) without a recorded on-chain tx_hash; verify on-chain before re-approving.`,
  };
}

export const DEFAULT_ALLOWED_TRON_HOSTS = [
  'https://api.trongrid.io',
  'https://api.shasta.trongrid.io',
  'https://nile.trongrid.io',
] as const;

/**
 * W-19: Enforces an explicit origin allowlist for `TRON_FULL_HOST` so private keys /
 * API credentials or RPC calls cannot be redirected to untrusted hosts.
 */
export function resolveTrustedTronHost(
  rawHost?: string,
  extraAllowedHostsEnv?: string
): string {
  const candidate = (rawHost ?? '').trim() || 'https://api.trongrid.io';

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid TRON_FULL_HOST URL "${candidate}".`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('TRON_FULL_HOST must not embed URL credentials.');
  }

  const allowedOrigins = new Set<string>(DEFAULT_ALLOWED_TRON_HOSTS);
  if (extraAllowedHostsEnv) {
    for (const item of extraAllowedHostsEnv.split(',')) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      let extraUrl: URL;
      try {
        extraUrl = new URL(trimmed);
      } catch {
        throw new Error(`Invalid TRON_ALLOWED_HOSTS entry "${trimmed}".`);
      }
      const isLoopbackHttp =
        extraUrl.protocol === 'http:' &&
        (extraUrl.hostname === 'localhost' || extraUrl.hostname === '127.0.0.1');
      if (extraUrl.protocol !== 'https:' && !isLoopbackHttp) {
        throw new Error(
          `TRON_ALLOWED_HOSTS entry "${trimmed}" must use https:// (or localhost http:// for testing).`
        );
      }
      allowedOrigins.add(extraUrl.origin);
    }
  }

  const isLoopbackHttp =
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');

  if (parsed.protocol !== 'https:' && !(isLoopbackHttp && allowedOrigins.has(parsed.origin))) {
    throw new Error(
      `Untrusted TRON_FULL_HOST protocol "${parsed.protocol}"; https:// is required.`
    );
  }

  if (!allowedOrigins.has(parsed.origin)) {
    throw new Error(
      `Untrusted TRON_FULL_HOST origin "${parsed.origin}". Permitted origins: ${Array.from(allowedOrigins).join(', ')}.`
    );
  }

  return parsed.origin;
}

export interface TronGridDepositPayload {
  transaction_id?: string;
  value?: string | number;
  block_timestamp?: number;
  to?: string;
  from?: string;
  token_info?: {
    address?: string;
    decimals?: number;
    symbol?: string;
  };
}

export type ParsedTronGridDeposit =
  | {
      valid: true;
      txHash: string;
      amount: number;
      timestampMs: number;
      decimals: number;
      recipient: string;
      contractAddress: string;
    }
  | {
      valid: false;
      suspicious: boolean;
      reason: string;
      txHash: string;
      timestampMs: number;
    };

/**
 * W-18: Validates TronGrid TRC-20 transfer payloads in worker code instead of blindly
 * trusting query parameters (`token_info.address`, `token_info.decimals`, `to`, `value`).
 */
export function validateAndParseTronGridDeposit(
  tx: TronGridDepositPayload,
  expectedRecipientAddress: string,
  expectedContractAddress: string
): ParsedTronGridDeposit {
  const txHash = typeof tx.transaction_id === 'string' ? tx.transaction_id.trim() : '';
  const timestampMs = Number(tx.block_timestamp ?? 0);
  const expectedRecipient = expectedRecipientAddress.trim();
  const expectedContract = expectedContractAddress.trim();

  if (!txHash) {
    return {
      valid: false,
      suspicious: false,
      reason: 'Missing transaction_id in TronGrid TRC-20 payload.',
      txHash: '',
      timestampMs,
    };
  }

  const actualContract =
    typeof tx.token_info?.address === 'string' ? tx.token_info.address.trim() : '';
  if (!actualContract || actualContract !== expectedContract) {
    return {
      valid: false,
      suspicious: true,
      reason: `Contract address mismatch for TX ${txHash}: expected ${expectedContract}, got "${actualContract || 'missing'}".`,
      txHash,
      timestampMs,
    };
  }

  const actualRecipient = typeof tx.to === 'string' ? tx.to.trim() : '';
  if (!actualRecipient || actualRecipient !== expectedRecipient) {
    return {
      valid: false,
      suspicious: true,
      reason: `Recipient address mismatch for TX ${txHash}: expected ${expectedRecipient}, got "${actualRecipient || 'missing'}".`,
      txHash,
      timestampMs,
    };
  }

  const rawDecimals = tx.token_info?.decimals;
  const decimals = rawDecimals === undefined ? 6 : Number(rawDecimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return {
      valid: false,
      suspicious: true,
      reason: `Invalid token_info.decimals (${String(rawDecimals)}) for TX ${txHash}.`,
      txHash,
      timestampMs,
    };
  }

  const rawValueStr =
    typeof tx.value === 'number'
      ? String(Math.trunc(tx.value))
      : typeof tx.value === 'string'
        ? tx.value.trim()
        : '';

  if (!/^\d+$/.test(rawValueStr)) {
    return {
      valid: false,
      suspicious: false,
      reason: `Non-integer TRC-20 raw value "${rawValueStr}" for TX ${txHash}.`,
      txHash,
      timestampMs,
    };
  }

  const amount = Number(rawValueStr) / Math.pow(10, decimals);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      valid: false,
      suspicious: false,
      reason: `Zero or invalid deposit amount for TX ${txHash}.`,
      txHash,
      timestampMs,
    };
  }

  return {
    valid: true,
    txHash,
    amount,
    timestampMs,
    decimals,
    recipient: actualRecipient,
    contractAddress: actualContract,
  };
}

export interface HotWalletTrxCheckResult {
  ok: boolean;
  balanceSun: number;
  balanceTrx: number;
  minReserveSun: number;
  minReserveTrx: number;
  reason?: string;
}

/**
 * W-20: Evaluates whether hot wallet native TRX fee reserve meets the minimum safe
 * threshold before starting a withdrawal broadcast cycle.
 */
export function evaluateHotWalletTrxBalance(
  balanceSun: number,
  minReserveSun: number
): HotWalletTrxCheckResult {
  const safeMinSun =
    Number.isFinite(minReserveSun) && minReserveSun > 0 ? minReserveSun : 50_000_000;
  const minReserveTrx = safeMinSun / 1_000_000;

  if (!Number.isFinite(balanceSun) || balanceSun < 0) {
    return {
      ok: false,
      balanceSun: 0,
      balanceTrx: 0,
      minReserveSun: safeMinSun,
      minReserveTrx,
      reason: `Invalid hot wallet TRX balance (${String(balanceSun)} SUN); pausing withdrawal broadcasts.`,
    };
  }

  const balanceTrx = balanceSun / 1_000_000;
  if (balanceSun < safeMinSun) {
    return {
      ok: false,
      balanceSun,
      balanceTrx,
      minReserveSun: safeMinSun,
      minReserveTrx,
      reason: `Hot wallet TRX reserve too low (${balanceTrx.toFixed(6)} TRX < minimum ${minReserveTrx.toFixed(2)} TRX); pausing new withdrawal broadcasts until refilled.`,
    };
  }

  return {
    ok: true,
    balanceSun,
    balanceTrx,
    minReserveSun: safeMinSun,
    minReserveTrx,
  };
}

/**
 * W-21: Generates a unique worker instance ID for atomic DB cycle leasing.
 */
export function generateWorkerInstanceId(): string {
  return `ntps-worker-${crypto.randomUUID()}`;
}
