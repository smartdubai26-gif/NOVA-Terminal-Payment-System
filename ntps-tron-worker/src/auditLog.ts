import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export type AuditSeverity = 'info' | 'warn' | 'critical';

export interface WorkerAuditLogInput {
  eventType: string;
  terminalId?: string | null;
  details: string;
  severity: AuditSeverity;
}

const GENESIS_HASH =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
const WORKER_ACTOR = 'ntps-tron-worker';

/**
 * Redacts accidental 64-char hex strings or key-like fields from error messages
 * before writing them to logs or `audit_logs`.
 */
export function sanitizeErrorMessage(err: unknown, knownPrivateKey?: string): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (knownPrivateKey) {
    msg = msg.split(knownPrivateKey).join('[REDACTED_KEY]');
  }
  msg = msg.replace(/\b(0x)?[0-9a-fA-F]{64}\b/g, '[REDACTED_HEX64]');
  return msg.slice(0, 500);
}

/**
 * Appends a hash-chained row into `public.audit_logs` matching the schema's
 * `0x` SHA-256 chain convention. Never throws so worker state transitions stay safe.
 */
export async function recordWorkerAuditLog(
  supabase: SupabaseClient,
  entry: WorkerAuditLogInput
): Promise<void> {
  try {
    const { data: latestRow } = await supabase
      .from('audit_logs')
      .select('row_hash')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevHash =
      typeof latestRow?.row_hash === 'string' && latestRow.row_hash.length > 0
        ? latestRow.row_hash
        : GENESIS_HASH;

    const timestampIso = new Date().toISOString();
    const digestInput = [
      prevHash,
      entry.eventType,
      WORKER_ACTOR,
      entry.terminalId ?? '',
      entry.details,
      timestampIso,
    ].join('|');

    const rowHash =
      '0x' + crypto.createHash('sha256').update(digestInput).digest('hex');

    const { error } = await supabase.from('audit_logs').insert({
      event_type: entry.eventType,
      actor: WORKER_ACTOR,
      terminal_id: entry.terminalId ?? null,
      details: entry.details,
      severity: entry.severity,
      prev_hash: prevHash,
      row_hash: rowHash,
    });

    if (error) {
      console.error('[AUDIT LOG INSERT ERROR]', error.message);
    }
  } catch (err) {
    console.error('[AUDIT LOG EXCEPTION]', sanitizeErrorMessage(err));
  }
}
