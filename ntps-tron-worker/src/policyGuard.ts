import type { WorkerAlertPayload } from './alerts';

export type AssetSymbol = 'USDT' | 'BTC' | 'ETH';

export interface TerminalPolicyRecord {
  id: string;
  terminal_id: string;
  status: string;
  per_tx_limit_usd: number;
  daily_limit_usd: number;
  allowed_assets: string[];
}

export interface PolicyEvaluationInput {
  terminal: TerminalPolicyRecord | null;
  asset: string;
  amount: number;
  usdRate: number;
  prior24hOutflowUsd: number;
}

export interface PolicyEvaluationResult {
  allowed: boolean;
  reason?: string;
  txUsd?: number;
  projectedDailyUsd?: number;
}

export interface OutflowTransactionRow {
  id: string;
  asset: string;
  amount: number | string;
  status: string;
  created_at: string;
}

export const FALLBACK_ASSET_USD_RATES: Record<AssetSymbol, number> = {
  USDT: 1.0,
  BTC: 91420.0,
  ETH: 3285.0,
};

export function resolveUsdRate(
  asset: string,
  ratesMap?: Partial<Record<string, number>>
): number {
  const dynamicRate = ratesMap?.[asset];
  if (typeof dynamicRate === 'number' && Number.isFinite(dynamicRate) && dynamicRate > 0) {
    return dynamicRate;
  }
  const fallback = FALLBACK_ASSET_USD_RATES[asset as AssetSymbol];
  return typeof fallback === 'number' && fallback > 0 ? fallback : 0;
}

/**
 * Computes prior 24-hour rolling withdrawal outflows in USD for a terminal,
 * excluding reversed/failed rows and excluding the current transaction ID
 * (since `request_crypto_withdrawal` inserts the pending transaction upfront).
 */
export function computePrior24hOutflowUsd(
  rows: OutflowTransactionRow[],
  excludeTransactionId: string,
  ratesMap?: Partial<Record<string, number>>,
  nowMs: number = Date.now()
): number {
  const cutoffMs = nowMs - 24 * 3600_000;
  let totalUsd = 0;

  for (const row of rows) {
    if (!row || row.id === excludeTransactionId) continue;
    if (row.status === 'reversed' || row.status === 'failed') continue;

    const createdMs = new Date(row.created_at).getTime();
    if (!Number.isFinite(createdMs) || createdMs < cutoffMs) continue;

    const amt = Number(row.amount);
    const rate = resolveUsdRate(row.asset, ratesMap);
    if (Number.isFinite(amt) && amt > 0 && rate > 0) {
      totalUsd += amt * rate;
    }
  }

  return totalUsd;
}

/**
 * Evaluates terminal status, allowed asset policy, per-tx USD cap, and rolling
 * 24-hour daily USD cap before allowing a withdrawal broadcast claim.
 */
export function evaluateBroadcastPolicy(
  input: PolicyEvaluationInput
): PolicyEvaluationResult {
  const { terminal, asset, amount, usdRate, prior24hOutflowUsd } = input;

  if (!terminal) {
    return {
      allowed: false,
      reason: 'Source terminal record not found.',
    };
  }

  if (terminal.status !== 'active') {
    return {
      allowed: false,
      reason: `Terminal ${terminal.terminal_id} status is '${terminal.status}' (must be 'active' for broadcast).`,
    };
  }

  if (!Array.isArray(terminal.allowed_assets) || !terminal.allowed_assets.includes(asset)) {
    return {
      allowed: false,
      reason: `Asset ${asset} is not permitted by terminal ${terminal.terminal_id} policy.`,
    };
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      allowed: false,
      reason: `Invalid withdrawal amount (${amount}).`,
    };
  }

  if (!Number.isFinite(usdRate) || usdRate <= 0) {
    return {
      allowed: false,
      reason: `Missing valid USD valuation rate for ${asset}.`,
    };
  }

  const perTxLimit = Number(terminal.per_tx_limit_usd);
  const dailyLimit = Number(terminal.daily_limit_usd);
  if (!Number.isFinite(perTxLimit) || perTxLimit <= 0 || !Number.isFinite(dailyLimit) || dailyLimit <= 0) {
    return {
      allowed: false,
      reason: `Terminal ${terminal.terminal_id} has invalid limit configuration.`,
    };
  }

  const txUsd = amount * usdRate;
  if (txUsd > perTxLimit) {
    return {
      allowed: false,
      txUsd,
      reason: `Withdrawal value ($${txUsd.toFixed(2)}) exceeds terminal ${terminal.terminal_id} per-tx limit ($${perTxLimit.toFixed(2)}).`,
    };
  }

  const safePrior = Number.isFinite(prior24hOutflowUsd) && prior24hOutflowUsd >= 0 ? prior24hOutflowUsd : 0;
  const projectedDailyUsd = safePrior + txUsd;
  if (projectedDailyUsd > dailyLimit) {
    return {
      allowed: false,
      txUsd,
      projectedDailyUsd,
      reason: `Withdrawal ($${txUsd.toFixed(2)}) exceeds terminal ${terminal.terminal_id} 24h daily limit (used $${safePrior.toFixed(2)} / cap $${dailyLimit.toFixed(2)}).`,
    };
  }

  return {
    allowed: true,
    txUsd,
    projectedDailyUsd,
  };
}

export function buildPolicyBlockedAlert(
  requestId: string,
  transactionId: string,
  terminalId: string,
  address: string,
  amountUsdt: number,
  reason: string
): WorkerAlertPayload {
  return {
    severity: 'critical',
    eventType: 'WITHDRAWAL_POLICY_BLOCKED',
    title: 'Terminal Policy Blocked Withdrawal Broadcast',
    message: reason,
    metadata: {
      requestId,
      transactionId,
      terminalId,
      address,
      amountUsdt,
    },
  };
}
