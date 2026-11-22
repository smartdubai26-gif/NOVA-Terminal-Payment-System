const SENSITIVE_ENV_VARS = [
  'HOT_WALLET_PRIVATE_KEY',
  'HOT_WALLET_DECRYPTION_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TRONGRID_API_KEY',
  'ALERT_EDGE_FUNCTION_TOKEN',
  'RATE_REFRESH_SECRET',
  'ALERT_WEBHOOK_URL',
] as const;

/**
 * Collects configured sensitive runtime secrets from environment variables (>= 8 chars)
 * so log/audit sanitizers redact exact secret values even when non-hex.
 */
export function collectSensitiveSecrets(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const secrets = new Set<string>();
  for (const key of SENSITIVE_ENV_VARS) {
    const val = env[key]?.trim();
    if (val && val.length >= 8) {
      secrets.add(val);
    }
  }
  return Array.from(secrets);
}

/**
 * Redacts private keys, 64-char hex keys, JWTs, Bearer tokens, URL credentials,
 * key=value secret fields, and configured runtime secrets before logging or
 * persisting messages to `audit_logs` / fallback logs.
 */
export function sanitizeErrorMessage(
  err: unknown,
  knownPrivateKey?: string | string[],
  env: NodeJS.ProcessEnv = process.env
): string {
  let msg = err instanceof Error ? err.message : String(err);

  const explicitSecrets: string[] = [];
  if (typeof knownPrivateKey === 'string' && knownPrivateKey.trim().length > 0) {
    explicitSecrets.push(knownPrivateKey.trim());
  } else if (Array.isArray(knownPrivateKey)) {
    for (const item of knownPrivateKey) {
      if (typeof item === 'string' && item.trim().length > 0) {
        explicitSecrets.push(item.trim());
      }
    }
  }

  for (const envSecret of collectSensitiveSecrets(env)) {
    explicitSecrets.push(envSecret);
  }

  // Redact longest secrets first to prevent partial prefix matches
  explicitSecrets.sort((a, b) => b.length - a.length);
  for (const secret of explicitSecrets) {
    if (msg.includes(secret)) {
      msg = msg.split(secret).join('[REDACTED_SECRET]');
    }
  }

  // Redact URL userinfo credentials (e.g., https://user:pass@host)
  msg = msg.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/g,
    '$1[REDACTED_CREDENTIALS]@'
  );

  // Redact JWT tokens (header.payload.signature)
  msg = msg.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
    '[REDACTED_JWT]'
  );

  // Redact Authorization: Bearer <token> or Bearer <token>
  msg = msg.replace(
    /(\bAuthorization\s*[:=]\s*Bearer\s+|\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    '$1[REDACTED_TOKEN]'
  );

  // Redact common credential key/value or JSON assignments
  msg = msg.replace(
    /(["']?(?:private_?key|api_?key|service_?role_?key|decryption_?key|passphrase|password|secret|token|TRON-PRO-API-KEY)["']?\s*[:=]\s*["']?)([^\s"',}\]]+)/gi,
    '$1[REDACTED_SECRET]'
  );

  // Redact raw 64-hex key/hash strings (when flagged/generic 64-hex secrets)
  msg = msg.replace(/\b(0x)?[0-9a-fA-F]{64}\b/g, '[REDACTED_HEX64]');

  return msg.slice(0, 500);
}
