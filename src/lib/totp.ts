import { generateSecret, generateURI } from 'otplib';
import QRCode from 'qrcode';
import { supabase } from './supabase';

export const TOTP_MAX_ATTEMPTS = 5;
export const TOTP_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
export const DEMO_2FA_LOCKOUT_STORAGE_KEY = 'ntps_demo_2fa_guard_v1';

export interface TotpStatus {
  enrolled: boolean;
  failedAttempts: number;
  lockedUntil: string | null;
  lockedRemainingSeconds: number;
  lastVerifiedAt: string | null;
}

export interface TotpVerifyResponse {
  ok: boolean;
  errorCode: 'NOT_ENROLLED' | 'LOCKED_OUT' | 'INVALID_CODE' | null;
  remainingAttempts: number;
  lockedUntil: string | null;
  lockedRemainingSeconds: number;
  message: string;
}

export interface TotpEnrollmentMaterial {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}

/**
 * Generates a fresh 160-bit Base32 TOTP secret and scannable QR data URL
 * using `otplib` + `qrcode`. Used exclusively during initial enrollment;
 * the secret is immediately discarded from memory once verified & encrypted on-server.
 */
export async function createTotpEnrollmentMaterial(
  accountLabel: string
): Promise<TotpEnrollmentMaterial> {
  const secret = generateSecret({ length: 20 });
  const otpauthUri = generateURI({
    strategy: 'totp',
    issuer: 'NOVA Terminal',
    label: accountLabel || 'operator@nova-terminal',
    secret,
    algorithm: 'sha1',
    digits: 6,
    period: 30,
  });

  const qrDataUrl = await QRCode.toDataURL(otpauthUri, {
    width: 200,
    margin: 2,
    color: {
      dark: '#05070A',
      light: '#FFFFFF',
    },
  });

  return { secret, otpauthUri, qrDataUrl };
}

/**
 * Queries server-side enrollment & lockout status (never returns raw secret).
 */
export async function fetchTotpStatus(): Promise<TotpStatus> {
  if (!supabase) {
    throw new Error('Supabase client is not configured.');
  }
  const { data, error } = await supabase.rpc('get_totp_status');
  if (error) {
    throw new Error(error.message);
  }
  const res = (data ?? {}) as Record<string, unknown>;
  return {
    enrolled: Boolean(res.enrolled),
    failedAttempts: Number(res.failed_attempts ?? 0),
    lockedUntil: res.locked_until ? String(res.locked_until) : null,
    lockedRemainingSeconds: Number(res.locked_remaining_seconds ?? 0),
    lastVerifiedAt: res.last_verified_at ? String(res.last_verified_at) : null,
  };
}

/**
 * Completes enrollment by verifying the first 6-digit authenticator token on the server
 * and encrypting the secret at rest inside `public.user_totp_factors`.
 */
export async function enrollUserTotp(
  secret: string,
  initialCode: string
): Promise<TotpStatus> {
  if (!supabase) {
    throw new Error('Supabase client is not configured.');
  }
  const { data, error } = await supabase.rpc('enroll_user_totp', {
    p_secret: secret,
    p_initial_code: initialCode,
  });
  if (error) {
    throw new Error(error.message);
  }
  const res = (data ?? {}) as Record<string, unknown>;
  return {
    enrolled: Boolean(res.enrolled ?? true),
    failedAttempts: Number(res.failed_attempts ?? 0),
    lockedUntil: null,
    lockedRemainingSeconds: 0,
    lastVerifiedAt: new Date().toISOString(),
  };
}

/**
 * Verifies a 6-digit TOTP code server-side via `verify_user_totp` RPC,
 * enforcing the 5-attempt -> 15-minute lockout policy.
 */
export async function verifyUserTotp(
  code: string,
  actionLabel: string
): Promise<TotpVerifyResponse> {
  if (!supabase) {
    throw new Error('Supabase client is not configured.');
  }
  const { data, error } = await supabase.rpc('verify_user_totp', {
    p_code: code,
    p_action_label: actionLabel,
  });
  if (error) {
    throw new Error(error.message);
  }
  const res = (data ?? {}) as Record<string, unknown>;
  return {
    ok: Boolean(res.ok),
    errorCode: (res.error_code as TotpVerifyResponse['errorCode']) ?? null,
    remainingAttempts: Number(res.remaining_attempts ?? 0),
    lockedUntil: res.locked_until ? String(res.locked_until) : null,
    lockedRemainingSeconds: Number(res.locked_remaining_seconds ?? 0),
    message: String(res.message ?? 'Verification failed.'),
  };
}

/**
 * Generates a cryptographically random 6-digit challenge code for Local Demo Mode.
 * Replaces any static/hardcoded test codes.
 */
export function generateRandomDemoOtp(): string {
  if (
    typeof globalThis.crypto === 'undefined' ||
    typeof globalThis.crypto.getRandomValues !== 'function'
  ) {
    throw new Error('Cryptographic randomness (crypto.getRandomValues) is required.');
  }
  const arr = new Uint32Array(1);
  const maxValid = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  let value = 0;
  do {
    globalThis.crypto.getRandomValues(arr);
    value = arr[0];
  } while (value >= maxValid);
  return String(value % 1_000_000).padStart(6, '0');
}

interface DemoGuardState {
  failedAttempts: number;
  lockedUntilMs: number | null;
}

export function readDemoTwoFactorGuard(): {
  failedAttempts: number;
  lockedUntilMs: number | null;
  lockedRemainingSeconds: number;
} {
  if (typeof window === 'undefined') {
    return { failedAttempts: 0, lockedUntilMs: null, lockedRemainingSeconds: 0 };
  }
  try {
    const raw = window.localStorage.getItem(DEMO_2FA_LOCKOUT_STORAGE_KEY);
    if (!raw) {
      return { failedAttempts: 0, lockedUntilMs: null, lockedRemainingSeconds: 0 };
    }
    const parsed = JSON.parse(raw) as DemoGuardState;
    const now = Date.now();
    if (parsed.lockedUntilMs && parsed.lockedUntilMs > now) {
      return {
        failedAttempts: parsed.failedAttempts ?? TOTP_MAX_ATTEMPTS,
        lockedUntilMs: parsed.lockedUntilMs,
        lockedRemainingSeconds: Math.ceil((parsed.lockedUntilMs - now) / 1000),
      };
    }
    if (parsed.lockedUntilMs && parsed.lockedUntilMs <= now) {
      window.localStorage.removeItem(DEMO_2FA_LOCKOUT_STORAGE_KEY);
      return { failedAttempts: 0, lockedUntilMs: null, lockedRemainingSeconds: 0 };
    }
    return {
      failedAttempts: parsed.failedAttempts ?? 0,
      lockedUntilMs: null,
      lockedRemainingSeconds: 0,
    };
  } catch {
    return { failedAttempts: 0, lockedUntilMs: null, lockedRemainingSeconds: 0 };
  }
}

export function recordDemoTwoFactorFailure(): {
  failedAttempts: number;
  remainingAttempts: number;
  lockedUntilMs: number | null;
  lockedRemainingSeconds: number;
} {
  const current = readDemoTwoFactorGuard();
  const nextAttempts = current.failedAttempts + 1;
  if (nextAttempts >= TOTP_MAX_ATTEMPTS) {
    const lockedUntilMs = Date.now() + TOTP_LOCKOUT_MS;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(
        DEMO_2FA_LOCKOUT_STORAGE_KEY,
        JSON.stringify({ failedAttempts: nextAttempts, lockedUntilMs })
      );
    }
    return {
      failedAttempts: nextAttempts,
      remainingAttempts: 0,
      lockedUntilMs,
      lockedRemainingSeconds: Math.ceil(TOTP_LOCKOUT_MS / 1000),
    };
  }

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(
      DEMO_2FA_LOCKOUT_STORAGE_KEY,
      JSON.stringify({ failedAttempts: nextAttempts, lockedUntilMs: null })
    );
  }
  return {
    failedAttempts: nextAttempts,
    remainingAttempts: TOTP_MAX_ATTEMPTS - nextAttempts,
    lockedUntilMs: null,
    lockedRemainingSeconds: 0,
  };
}

export function clearDemoTwoFactorGuard(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(DEMO_2FA_LOCKOUT_STORAGE_KEY);
  }
}
