import type { SupabaseClient } from '@supabase/supabase-js';
import type { TronWeb } from 'tronweb';

export interface AmlScreeningResult {
  allowed: boolean;
  reason?: string;
  riskLevel?: 'high' | 'sanctioned' | 'blocked' | 'invalid';
  source?: string;
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
 * Lightweight pre-broadcast AML and destination sanity screening.
 * Combines TRON Base58Check address validation, built-in burn blackholes,
 * env-configured `AML_BLOCKED_ADDRESSES`, and `public.aml_blocked_addresses`.
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

  const { data: dbMatch, error } = await supabase
    .from('aml_blocked_addresses')
    .select('address, reason, risk_level, source')
    .eq('address', cleanAddress)
    .eq('network', network)
    .eq('active', true)
    .maybeSingle();

  // Gracefully degrade to env + built-in checks if migration 004 has not been applied yet
  if (!error && dbMatch) {
    return {
      allowed: false,
      reason: `Destination ${cleanAddress} blocked by AML registry: ${String(dbMatch.reason)}`,
      riskLevel: (dbMatch.risk_level as AmlScreeningResult['riskLevel']) ?? 'blocked',
      source: String(dbMatch.source ?? 'aml_blocked_addresses'),
    };
  }

  return { allowed: true };
}
