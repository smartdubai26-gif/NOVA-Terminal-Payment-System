import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendWorkerAlert } from './alerts';
import { collectSensitiveSecrets, sanitizeErrorMessage } from './redact';

export { collectSensitiveSecrets, sanitizeErrorMessage };

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
let auditRpcMissingWarned = false;
let consecutiveAuditFailures = 0;

function getAuditFailureAlertThreshold(): number {
  const parsed = Number(process.env.AUDIT_FAILURE_ALERT_THRESHOLD);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 3;
}

export function getAuditFallbackFilePath(): string {
  const configured = process.env.AUDIT_FALLBACK_FILE?.trim();
  return configured || path.join(os.tmpdir(), 'ntps-worker-audit-fallback.jsonl');
}

export function getConsecutiveAuditFailures(): number {
  return consecutiveAuditFailures;
}

export function resetAuditFailureStateForTests(): void {
  consecutiveAuditFailures = 0;
  auditRpcMissingWarned = false;
}

function appendAuditFallbackLine(
  entry: WorkerAuditLogInput,
  failureReason: string
): void {
  try {
    const fallbackPath = getAuditFallbackFilePath();
    fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
      actor: WORKER_ACTOR,
      eventType: entry.eventType,
      terminalId: entry.terminalId ?? null,
      severity: entry.severity,
      details: sanitizeErrorMessage(entry.details),
      auditWriteError: sanitizeErrorMessage(failureReason),
    };
    fs.appendFileSync(fallbackPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (fsErr) {
    console.error('[AUDIT FALLBACK WRITE ERROR]', sanitizeErrorMessage(fsErr));
  }
}

async function handleAuditWriteFailure(
  entry: WorkerAuditLogInput,
  rawError: unknown
): Promise<void> {
  consecutiveAuditFailures += 1;
  const safeErr = sanitizeErrorMessage(rawError);
  console.error(
    `[AUDIT LOG FAILURE #${consecutiveAuditFailures}] (${entry.eventType}):`,
    safeErr
  );
  appendAuditFallbackLine(entry, safeErr);

  const threshold = getAuditFailureAlertThreshold();
  if (consecutiveAuditFailures >= threshold) {
    await sendWorkerAlert(
      {
        severity: 'critical',
        eventType: 'WORKER_AUDIT_LOG_FAILURE',
        title: 'Worker Audit Log Persistence Failure',
        message: `recordWorkerAuditLog failed ${consecutiveAuditFailures} consecutive times (latest event=${entry.eventType}): ${safeErr}. Entry buffered locally.`,
        metadata: {
          consecutiveAuditFailures,
          eventType: entry.eventType,
          terminalId: entry.terminalId ?? null,
          fallbackFile: getAuditFallbackFilePath(),
        },
      },
      { dedupeKey: 'worker_audit_log_failure' }
    );
  }
}

/**
 * Computes a deterministic `0x` SHA-256 chain row hash linking to `prevHash`.
 */
export function computeAuditRowHash(
  prevHash: string,
  entry: WorkerAuditLogInput,
  timestampIso: string
): string {
  const digestInput = [
    prevHash,
    entry.eventType,
    WORKER_ACTOR,
    entry.terminalId ?? '',
    entry.details,
    timestampIso,
  ].join('|');

  return '0x' + crypto.createHash('sha256').update(digestInput).digest('hex');
}

/**
 * Appends a hash-chained row into `public.audit_logs`.
 * Uses `append_worker_audit_log` (serialized via `pg_advisory_xact_lock` in migration 007)
 * with graceful fallback if migration 007 has not yet been applied.
 * Tracks consecutive failures, writes an append-only local JSONL fallback, and alerts ops.
 */
export async function recordWorkerAuditLog(
  supabase: SupabaseClient,
  entry: WorkerAuditLogInput
): Promise<boolean> {
  const safeDetails = sanitizeErrorMessage(entry.details);
  const safeEntry: WorkerAuditLogInput = {
    ...entry,
    details: safeDetails,
  };

  try {
    const rpcRes = await supabase.rpc('append_worker_audit_log', {
      p_event_type: safeEntry.eventType,
      p_actor: WORKER_ACTOR,
      p_terminal_id: safeEntry.terminalId ?? null,
      p_details: safeEntry.details,
      p_severity: safeEntry.severity,
    });

    if (!rpcRes.error) {
      consecutiveAuditFailures = 0;
      return true;
    }

    const errMsg = rpcRes.error.message ?? '';
    const errCode = (rpcRes.error as { code?: string }).code ?? '';
    const rpcMissing =
      errCode === 'PGRST202' ||
      errCode === '42883' ||
      errMsg.includes('append_worker_audit_log');

    if (!rpcMissing) {
      await handleAuditWriteFailure(safeEntry, errMsg);
      return false;
    }

    if (!auditRpcMissingWarned) {
      auditRpcMissingWarned = true;
      console.warn(
        '[AUDIT LOG] RPC append_worker_audit_log not found; using direct insert fallback until migration 007 is applied.'
      );
    }

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
    const rowHash = computeAuditRowHash(prevHash, safeEntry, timestampIso);

    const { error } = await supabase.from('audit_logs').insert({
      event_type: safeEntry.eventType,
      actor: WORKER_ACTOR,
      terminal_id: safeEntry.terminalId ?? null,
      details: safeEntry.details,
      severity: safeEntry.severity,
      prev_hash: prevHash,
      row_hash: rowHash,
    });

    if (error) {
      await handleAuditWriteFailure(safeEntry, error.message);
      return false;
    }

    consecutiveAuditFailures = 0;
    return true;
  } catch (err) {
    await handleAuditWriteFailure(safeEntry, err);
    return false;
  }
}
