import { sanitizeErrorMessage } from './redact';

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

export interface AlertEdgeFunctionResolution {
  allowed: boolean;
  url?: string;
  bearerToken?: string;
  reason?: string;
}

function isAllowedAlertProtocol(parsed: URL): boolean {
  if (parsed.protocol === 'https:') return true;
  if (
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  ) {
    return true;
  }
  return false;
}

/**
 * Validates that `ALERT_EDGE_FUNCTION_URL` shares the exact same origin as
 * `SUPABASE_URL` before attaching any credential, preventing exfiltration of
 * `SUPABASE_SERVICE_ROLE_KEY` to untrusted external URLs.
 */
export function resolveAlertEdgeFunctionDispatch(params: {
  edgeFnUrl?: string;
  supabaseUrl?: string;
  dedicatedToken?: string;
  serviceRoleKey?: string;
}): AlertEdgeFunctionResolution {
  const cleanEdgeUrl = params.edgeFnUrl?.trim() ?? '';
  if (!cleanEdgeUrl) {
    return { allowed: false, reason: 'ALERT_EDGE_FUNCTION_URL is not configured.' };
  }

  let parsedEdge: URL;
  try {
    parsedEdge = new URL(cleanEdgeUrl);
  } catch {
    return {
      allowed: false,
      reason: 'ALERT_EDGE_FUNCTION_URL is not a valid URL; refusing to dispatch alert.',
    };
  }

  if (!isAllowedAlertProtocol(parsedEdge)) {
    return {
      allowed: false,
      reason: `ALERT_EDGE_FUNCTION_URL must use https:// (got ${parsedEdge.protocol}); refusing to dispatch alert.`,
    };
  }

  const cleanSupabaseUrl = params.supabaseUrl?.trim() ?? '';
  if (!cleanSupabaseUrl) {
    return {
      allowed: false,
      reason: 'SUPABASE_URL is missing; cannot verify ALERT_EDGE_FUNCTION_URL origin.',
    };
  }

  let parsedSupabase: URL;
  try {
    parsedSupabase = new URL(cleanSupabaseUrl);
  } catch {
    return {
      allowed: false,
      reason: 'SUPABASE_URL is invalid; cannot verify ALERT_EDGE_FUNCTION_URL origin.',
    };
  }

  if (parsedEdge.origin !== parsedSupabase.origin) {
    return {
      allowed: false,
      reason: `Refusing to send alert credentials to ALERT_EDGE_FUNCTION_URL: origin "${parsedEdge.origin}" does not match SUPABASE_URL origin "${parsedSupabase.origin}".`,
    };
  }

  const dedicatedToken = params.dedicatedToken?.trim() ?? '';
  const serviceRoleKey = params.serviceRoleKey?.trim() ?? '';
  const bearerToken = dedicatedToken || serviceRoleKey;

  if (!bearerToken) {
    return {
      allowed: false,
      reason: 'Neither ALERT_EDGE_FUNCTION_TOKEN nor SUPABASE_SERVICE_ROLE_KEY is set for Edge Function dispatch.',
    };
  }

  return {
    allowed: true,
    url: parsedEdge.toString(),
    bearerToken,
  };
}

/**
 * Dispatches operational failure & compliance alerts to configured webhook
 * (`ALERT_WEBHOOK_URL`) and/or same-origin Supabase Edge Function (`ALERT_EDGE_FUNCTION_URL`).
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
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const dedicatedEdgeToken = process.env.ALERT_EDGE_FUNCTION_TOKEN?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  const safeMessage = sanitizeErrorMessage(payload.message);
  const body = {
    source: 'ntps-tron-worker',
    timestamp: new Date().toISOString(),
    severity: payload.severity,
    eventType: payload.eventType,
    title: payload.title,
    message: safeMessage,
    metadata: payload.metadata ?? {},
    // Slack / Discord compatible summary field
    text: `[NTPS WORKER · ${payload.severity.toUpperCase()}] ${payload.title}: ${safeMessage}`,
  };

  if (!webhookUrl && !edgeFnUrl) {
    console.warn(`[ALERT · LOG ONLY] ${body.text}`);
    return;
  }

  const dispatchers: Promise<void>[] = [];

  if (webhookUrl) {
    let parsedWebhook: URL | null = null;
    try {
      parsedWebhook = new URL(webhookUrl);
    } catch {
      console.error('[ALERT WEBHOOK CONFIG ERROR] ALERT_WEBHOOK_URL is not a valid URL.');
    }

    if (parsedWebhook && !isAllowedAlertProtocol(parsedWebhook)) {
      console.error('[ALERT WEBHOOK CONFIG ERROR] ALERT_WEBHOOK_URL must use https://.');
    } else if (parsedWebhook) {
      dispatchers.push(
        fetch(parsedWebhook.toString(), {
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
            console.error('[ALERT WEBHOOK ERROR]', sanitizeErrorMessage(err));
          })
      );
    }
  }

  if (edgeFnUrl) {
    const edgeResolution = resolveAlertEdgeFunctionDispatch({
      edgeFnUrl,
      supabaseUrl,
      dedicatedToken: dedicatedEdgeToken,
      serviceRoleKey,
    });

    if (!edgeResolution.allowed || !edgeResolution.url || !edgeResolution.bearerToken) {
      console.error('[ALERT EDGE FUNCTION BLOCKED]', edgeResolution.reason);
    } else {
      dispatchers.push(
        fetch(edgeResolution.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${edgeResolution.bearerToken}`,
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
            console.error('[ALERT EDGE FUNCTION ERROR]', sanitizeErrorMessage(err));
          })
      );
    }
  }

  await Promise.allSettled(dispatchers);
}
