/**
 * Pure worker guard functions isolated from DB and TRON network I/O for deterministic unit testing.
 */

export const USDT_DECIMALS = 6;

/**
 * Converts a token amount to integer atomic units without silent truncation.
 * Returns `0` when the input is non-positive, non-finite, or carries fractional
 * precision smaller than 1 unit (`1e-6` for USDT).
 */
export function toTokenUnits(amount: number, decimals: number = USDT_DECIMALS): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const factor = 10 ** decimals;
  const scaled = amount * factor;
  const rounded = Math.round(scaled);

  if (Math.abs(scaled - rounded) > 1e-6) return 0;
  if (!Number.isSafeInteger(rounded) || rounded <= 0) return 0;

  return rounded;
}

/**
 * Extracts a 64-character hex txid from a TronWeb error payload BEFORE calling
 * secret redaction (which masks 64-char hex strings).
 */
export function extractTxIdFromError(err: unknown): string | null {
  if (err && typeof err === 'object') {
    const anyErr = err as Record<string, unknown>;
    const nested = anyErr.transaction as Record<string, unknown> | undefined;
    const response = anyErr.response as Record<string, unknown> | undefined;
    const data = anyErr.data as Record<string, unknown> | undefined;

    const candidates = [
      anyErr.txid,
      anyErr.txId,
      nested?.txID,
      response?.txid,
      data?.txid,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && /^[0-9a-fA-F]{64}$/.test(candidate)) {
        return candidate;
      }
    }
  }

  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/\b[0-9a-fA-F]{64}\b/);
  return match ? match[0] : null;
}

/**
 * W-03: Classifies PostgREST/Supabase errors returned while reading `aml_blocked_addresses`.
 *   - `table_missing`: schema lacks `aml_blocked_addresses` (migration 004 pending)
 *   - `transient`: transport / network / timeout error (fail closed)
 *   - `unknown`: any other error including PGRST116 (fail closed)
 */
export type AmlDbErrorClass = 'table_missing' | 'transient' | 'unknown';

export function classifyAmlDbError(err: unknown): AmlDbErrorClass {
  if (!err || typeof err !== 'object') return 'unknown';
  const e = err as Record<string, unknown>;
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : String(err);

  if (code === '42P01' || code === 'PGRST205') return 'table_missing';
  if (/relation .* does not exist/i.test(message)) return 'table_missing';
  if (/could not find the table|schema cache/i.test(message)) return 'table_missing';

  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'PGRST301' ||
    /fetch failed|network|timeout|timed out|socket hang up|ECONNRESET/i.test(message)
  ) {
    return 'transient';
  }

  return 'unknown';
}

export interface DestinationLike {
  address: string;
  network: string;
  verified?: boolean | null;
}

export interface TrustVerdict {
  trusted: boolean;
  reason?: string;
}

/**
 * W-01: Pure destination trust assessment enforcing:
 *   1. Non-empty destination address
 *   2. Explicit `verified === true`
 *   3. Valid TRON Base58Check address via injected `isAddress` validator
 *   4. No post-approval TOCTOU mutation against `destination_snapshot`
 */
export function assessDestinationTrust(
  dest: DestinationLike,
  snapshot: string | null | undefined,
  isAddress: (addr: string) => boolean
): TrustVerdict {
  const address = String(dest.address ?? '').trim();
  if (!address) {
    return { trusted: false, reason: 'destination address is empty' };
  }

  if (dest.verified !== true) {
    return {
      trusted: false,
      reason: `whitelist row is not explicitly verified (verified=${String(dest.verified)})`,
    };
  }

  if (!isAddress(address)) {
    return { trusted: false, reason: 'destination failed TRON Base58Check validation' };
  }

  if (snapshot && snapshot.trim().length > 0 && snapshot.trim() !== address) {
    return {
      trusted: false,
      reason: `destination changed after approval (approved=${snapshot.trim()}, current=${address})`,
    };
  }

  return { trusted: true };
}
