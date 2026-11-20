export type WorkerAlertSeverity = 'warn' | 'critical';

export interface WorkerAlertPayload {
  severity: WorkerAlertSeverity;
  eventType: string;
  title: string;
  message: string;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

const ALERT_TIMEOUT_MS = 5000;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes for deduplicated alerts
const lastAlertSentAt = new Map<string, number>();

/**
 * Dispatches operational failure & compliance alerts to configured webhook
 * (`ALERT_WEBHOOK_URL`) and/or Supabase Edge Function (`ALERT_EDGE_FUNCTION_URL`).
 * Never throws so worker loops remain resilient.
 */
export async function sendWorkerAlert(
  payload: WorkerAlertPayload,
  options?: { dedupeKey?: string }
): Promise<void> {
  if (options?.dedupeKey) {
    const prev = lastAlertSentAt.get(options.dedupeKey) ?? 0;
    if (Date.now() - prev < COOLDOWN_MS) {
      return;
    }
    lastAlertSentAt.set(options.dedupeKey, Date.now());
  }

  const webhookUrl = process.env.ALERT_WEBHOOK_URL?.trim();
  const edgeFnUrl = process.env.ALERT_EDGE_FUNCTION_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  const body = {
    source: 'ntps-tron-worker',
    timestamp: new Date().toISOString(),
    severity: payload.severity,
    eventType: payload.eventType,
    title: payload.title,
    message: payload.message,
    metadata: payload.metadata ?? {},
    // Slack / Discord compatible summary field
    text: `[NTPS WORKER · ${payload.severity.toUpperCase()}] ${payload.title}: ${payload.message}`,
  };

  if (!webhookUrl && !edgeFnUrl) {
    console.warn(`[ALERT · LOG ONLY] ${body.text}`);
    return;
  }

  const dispatchers: Promise<void>[] = [];

  if (webhookUrl) {
    dispatchers.push(
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      })
        .then((res) => {
          if (!res.ok) {
            console.error(`[ALERT WEBHOOK HTTP ${res.status}]`);
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[ALERT WEBHOOK ERROR]', msg);
        })
    );
  }

  if (edgeFnUrl && serviceRoleKey) {
    dispatchers.push(
      fetch(edgeFnUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      })
        .then((res) => {
          if (!res.ok) {
            console.error(`[ALERT EDGE FUNCTION HTTP ${res.status}]`);
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[ALERT EDGE FUNCTION ERROR]', msg);
        })
    );
  }

  await Promise.allSettled(dispatchers);
}
