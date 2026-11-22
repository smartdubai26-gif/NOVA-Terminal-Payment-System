import type { SupabaseClient } from '@supabase/supabase-js';
import type { TronWeb } from 'tronweb';
import { classifyAmlDbError } from './guards';
import { sanitizeErrorMessage } from './redact';

export interface AmlScreeningResult {
  allowed: boolean;
  reason?: string;
  riskLevel?: 'high' | 'sanctioned' | 'blocked' | 'invalid' | 'unavailable';
  source?: string;
  /**
   * W-03: `true` when the decision resulted from an AML registry lookup outage or
   * missing table rather than a confirmed blocklist hit. Callers hold the request
   * in `review` without treating it as a permanent sanction block.
   */
  degraded?: boolean;
}

// Well-known TRON burn / zero blackhole addresses that should never receive customer payouts
const BUILTIN_RESTRICTED_TRON_ADDRESSES = new Set<string>([
  'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', // TRON zero/burn address
]);

function parseEnvBlockedSet(): Set<string> {
  const raw = process.env.AML_BLOCKED_ADDRESSES ?? '';
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  );
}

/**
 * W-03: Explicit operator opt-in (`AML_ALLOW_DEGRADED_MODE=true`) allowing startup before
 * migration 004 creates `public.aml_blocked_addresses`. Defaults strictly to `false`.
 */
function allowDegradedMode(): boolean {
  return String(process.env.AML_ALLOW_DEGRADED_MODE ?? '').toLowerCase() === 'true';
}

/**
 * Pre-broadcast AML and destination sanity screening (W-03 fail-closed).
 * Combines TRON Base58Check address validation, built-in burn blackholes,
 * env-configured `AML_BLOCKED_ADDRESSES`, and `public.aml_blocked_addresses`.
 * Any database failure blocks broadcast (`allowed: false`, `degraded: true`),
 * except missing-table schema error when `AML_ALLOW_DEGRADED_MODE=true` explicitly.
 */
export async function screenWithdrawalDestination(
  supabase: SupabaseClient,
  tronWeb: TronWeb,
  address: string,
  network: string
): Promise<AmlScreeningResult> {
  const cleanAddress = address.trim();

  if (!tronWeb.isAddress(cleanAddress)) {
    return {
      allowed: false,
      reason: `Destination address "${cleanAddress}" failed TRON Base58Check validation.`,
      riskLevel: 'invalid',
      source: 'address_validator',
    };
  }

  if (BUILTIN_RESTRICTED_TRON_ADDRESSES.has(cleanAddress)) {
    return {
      allowed: false,
      reason: `Destination address ${cleanAddress} is a restricted TRON burn/blackhole address.`,
      riskLevel: 'blocked',
      source: 'builtin_policy',
    };
  }

  const envBlocked = parseEnvBlockedSet();
  if (envBlocked.has(cleanAddress)) {
    return {
      allowed: false,
      reason: `Destination address ${cleanAddress} matched AML_BLOCKED_ADDRESSES policy list.`,
      riskLevel: 'blocked',
      source: 'env_aml_list',
    };
  }

  let dbMatch: Record<string, unknown> | null = null;
  let dbError: unknown = null;

  try {
    const res = await supabase
      .from('aml_blocked_addresses')
      .select('address, reason, risk_level, source')
      .eq('address', cleanAddress)
      .eq('network', network)
      .eq('active', true)
      .maybeSingle();

    dbMatch = (res.data as Record<string, unknown> | null) ?? null;
    dbError = res.error ?? null;
  } catch (thrown) {
    dbError = thrown;
  }

  if (dbError) {
    const errorClass = classifyAmlDbError(dbError);
    const rawDetail =
      dbError && typeof dbError === 'object' && 'message' in dbError
        ? String((dbError as { message?: unknown }).message ?? '')
        : dbError;
    const detail = sanitizeErrorMessage(rawDetail);

    if (errorClass === 'table_missing' && allowDegradedMode()) {
      console.warn(
        `[AML DEGRADED] aml_blocked_addresses is missing and AML_ALLOW_DEGRADED_MODE=true; ` +
          `screening ${cleanAddress} with built-in + env lists only. Apply migration 004 to close this gap.`
      );
      return {
        allowed: true,
        degraded: true,
        source: 'degraded_no_registry',
        reason: 'AML registry table missing; degraded mode explicitly enabled.',
      };
    }

    console.error(
      `[AML UNAVAILABLE] Could not read aml_blocked_addresses (class=${errorClass}): ${detail}`
    );

    return {
      allowed: false,
      degraded: true,
      riskLevel: 'unavailable',
      source: 'aml_registry_unavailable',
      reason:
        errorClass === 'table_missing'
          ? 'AML registry table is missing (migration 004 not applied) and degraded mode is not enabled.'
          : `AML registry lookup failed (${errorClass}); refusing to broadcast without screening.`,
    };
  }

  if (dbMatch) {
    return {
      allowed: false,
      reason: `Destination ${cleanAddress} blocked by AML registry: ${String(dbMatch.reason)}`,
      riskLevel: (dbMatch.risk_level as AmlScreeningResult['riskLevel']) ?? 'blocked',
      source: String(dbMatch.source ?? 'aml_blocked_addresses'),
    };
  }

  return { allowed: true, source: 'aml_registry_clear' };
}
