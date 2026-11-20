-- ============================================================================
-- Migration 002: Real TOTP Two-Factor Authentication (2FA) & Lockout
-- NOVA Terminal Payment System (NTPS)
--
-- Purpose:
--   1. Create private non-API schema `ntps_internal` holding the server-side
--      AES-256 encryption key for TOTP secrets at rest.
--   2. Create `public.user_totp_factors` storing AES-256 pgcrypto-encrypted
--      TOTP secrets (`encrypted_secret`), `failed_attempts`, and `locked_until`.
--   3. Revoke all direct table access on `user_totp_factors` from `PUBLIC`,
--      `anon`, and `authenticated` so encrypted secrets never leave the server.
--   4. Implement RFC 6238 HMAC-SHA1 TOTP verification inside Postgres
--      (`ntps_internal.verify_totp_secret`) with +/- 1 step (30s) drift window.
--   5. Expose `get_totp_status()`, `enroll_user_totp()`, and `verify_user_totp()`
--      SECURITY DEFINER RPCs enforcing 5 failed attempts -> 15-minute lockout
--      and recording every enrollment, verification, failure, and lockout in
--      `public.audit_logs`.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. PRIVATE INTERNAL KEY VAULT SCHEMA (NOT EXPOSED TO POSTGREST API)
-- ----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS ntps_internal;
REVOKE ALL ON SCHEMA ntps_internal FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA ntps_internal TO service_role;

CREATE TABLE IF NOT EXISTS ntps_internal.vault_keys (
  key_name TEXT PRIMARY KEY,
  key_material TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE ntps_internal.vault_keys FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE ntps_internal.vault_keys TO service_role;

INSERT INTO ntps_internal.vault_keys (key_name, key_material)
VALUES ('totp_master_key', encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (key_name) DO NOTHING;

CREATE OR REPLACE FUNCTION ntps_internal.get_totp_encryption_key()
RETURNS TEXT AS $$
DECLARE
  v_setting TEXT;
  v_key TEXT;
BEGIN
  v_setting := NULLIF(current_setting('app.settings.totp_encryption_key', true), '');
  IF v_setting IS NOT NULL THEN
    RETURN v_setting;
  END IF;

  SELECT key_material INTO v_key
  FROM ntps_internal.vault_keys
  WHERE key_name = 'totp_master_key'
  LIMIT 1;

  IF v_key IS NULL OR length(v_key) < 32 THEN
    RAISE EXCEPTION 'Server TOTP encryption key is not initialized';
  END IF;

  RETURN v_key;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, ntps_internal;

REVOKE ALL ON FUNCTION ntps_internal.get_totp_encryption_key() FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. RFC 4648 BASE32 DECODER & RFC 6238 TOTP VERIFIER
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ntps_internal.base32_decode(p_input TEXT)
RETURNS BYTEA AS $$
DECLARE
  v_clean TEXT := regexp_replace(upper(COALESCE(p_input, '')), '[^A-Z2-7]', '', 'g');
  v_alphabet CONSTANT TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  v_len INTEGER := length(v_clean);
  v_i INTEGER;
  v_val INTEGER;
  v_buffer INTEGER := 0;
  v_bits INTEGER := 0;
  v_hex TEXT := '';
BEGIN
  FOR v_i IN 1..v_len LOOP
    v_val := strpos(v_alphabet, substr(v_clean, v_i, 1)) - 1;
    IF v_val < 0 THEN
      RAISE EXCEPTION 'Invalid Base32 character in TOTP secret';
    END IF;
    v_buffer := (v_buffer << 5) | v_val;
    v_bits := v_bits + 5;
    IF v_bits >= 8 THEN
      v_bits := v_bits - 8;
      v_hex := v_hex || lpad(to_hex((v_buffer >> v_bits) & 255), 2, '0');
      v_buffer := v_buffer & ((1 << v_bits) - 1);
    END IF;
  END LOOP;
  RETURN decode(v_hex, 'hex');
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog;

REVOKE ALL ON FUNCTION ntps_internal.base32_decode(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION ntps_internal.verify_totp_secret(
  p_secret TEXT,
  p_code TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_clean_code TEXT := regexp_replace(COALESCE(p_code, ''), '\s+', '', 'g');
  v_secret_bytes BYTEA;
  v_step BIGINT;
  v_offset_step INTEGER;
  v_counter_bytes BYTEA;
  v_hmac BYTEA;
  v_trunc_offset INTEGER;
  v_bin_code BIGINT;
  v_candidate TEXT;
BEGIN
  IF v_clean_code !~ '^\d{6}$' THEN
    RETURN FALSE;
  END IF;

  v_secret_bytes := ntps_internal.base32_decode(p_secret);
  IF length(v_secret_bytes) < 10 THEN
    RETURN FALSE;
  END IF;

  v_step := floor(extract(epoch FROM clock_timestamp()) / 30)::BIGINT;

  -- Allow +/- 1 time step (+/- 30s) for clock drift
  FOR v_offset_step IN -1..1 LOOP
    v_counter_bytes := decode(lpad(to_hex(v_step + v_offset_step), 16, '0'), 'hex');
    v_hmac := hmac(v_counter_bytes, v_secret_bytes, 'sha1');
    v_trunc_offset := get_byte(v_hmac, 19) & 15;
    v_bin_code := (
      ((get_byte(v_hmac, v_trunc_offset) & 127)::BIGINT << 24) |
      (get_byte(v_hmac, v_trunc_offset + 1)::BIGINT << 16) |
      (get_byte(v_hmac, v_trunc_offset + 2)::BIGINT << 8) |
      get_byte(v_hmac, v_trunc_offset + 3)::BIGINT
    );
    v_candidate := lpad((v_bin_code % 1000000)::TEXT, 6, '0');
    IF v_candidate = v_clean_code THEN
      RETURN TRUE;
    END IF;
  END LOOP;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions, ntps_internal;

REVOKE ALL ON FUNCTION ntps_internal.verify_totp_secret(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. ENCRYPTED PER-USER TOTP FACTORS TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_totp_factors (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_secret BYTEA NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_totp_factors ENABLE ROW LEVEL SECURITY;

-- Never allow direct client reads or writes on `user_totp_factors`
-- so `encrypted_secret` is strictly inaccessible outside server RPCs.
REVOKE ALL ON TABLE public.user_totp_factors FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.user_totp_factors TO service_role;

-- ----------------------------------------------------------------------------
-- 4. PUBLIC SECURITY DEFINER RPCs FOR 2FA STATUS, ENROLLMENT & VERIFICATION
-- ----------------------------------------------------------------------------

-- 4A. Get TOTP Enrollment & Lockout Status (Never exposes secret material)
CREATE OR REPLACE FUNCTION public.get_totp_status()
RETURNS JSONB AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_factor public.user_totp_factors%ROWTYPE;
  v_rem_sec INTEGER := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_factor
  FROM public.user_totp_factors
  WHERE user_id = v_uid;

  IF NOT FOUND OR NOT v_factor.enabled THEN
    RETURN jsonb_build_object(
      'enrolled', false,
      'failed_attempts', 0,
      'locked_until', null,
      'locked_remaining_seconds', 0,
      'last_verified_at', null
    );
  END IF;

  IF v_factor.locked_until IS NOT NULL AND v_factor.locked_until > now() THEN
    v_rem_sec := CEIL(EXTRACT(EPOCH FROM (v_factor.locked_until - now())))::INTEGER;
  END IF;

  RETURN jsonb_build_object(
    'enrolled', true,
    'failed_attempts', CASE WHEN v_rem_sec > 0 OR v_factor.locked_until IS NULL THEN v_factor.failed_attempts ELSE 0 END,
    'locked_until', CASE WHEN v_rem_sec > 0 THEN v_factor.locked_until ELSE null END,
    'locked_remaining_seconds', GREATEST(0, v_rem_sec),
    'last_verified_at', v_factor.last_verified_at
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, ntps_internal;

-- 4B. Enroll User TOTP Factor (Verifies initial code BEFORE storing encrypted secret)
CREATE OR REPLACE FUNCTION public.enroll_user_totp(
  p_secret TEXT,
  p_initial_code TEXT
) RETURNS JSONB AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_clean_secret TEXT := regexp_replace(upper(COALESCE(p_secret, '')), '[^A-Z2-7]', '', 'g');
  v_enc_key TEXT;
  v_encrypted BYTEA;
  v_prev_hash TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF length(v_clean_secret) < 16 THEN
    RAISE EXCEPTION 'TOTP secret must be at least 16 Base32 characters';
  END IF;

  IF NOT ntps_internal.verify_totp_secret(v_clean_secret, p_initial_code) THEN
    RAISE EXCEPTION 'Invalid initial 6-digit authenticator code. Confirm device clock sync and retry.';
  END IF;

  v_enc_key := ntps_internal.get_totp_encryption_key();
  v_encrypted := pgp_sym_encrypt(v_clean_secret, v_enc_key, 'cipher-algo=aes256');

  INSERT INTO public.user_totp_factors (
    user_id, encrypted_secret, enabled, failed_attempts, locked_until, enrolled_at, last_verified_at, updated_at
  ) VALUES (
    v_uid, v_encrypted, true, 0, NULL, now(), now(), now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    encrypted_secret = EXCLUDED.encrypted_secret,
    enabled = true,
    failed_attempts = 0,
    locked_until = NULL,
    enrolled_at = now(),
    last_verified_at = now(),
    updated_at = now();

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
  VALUES (
    'TOTP_ENROLLED',
    v_uid::TEXT,
    NULL,
    'Operator enrolled AES-256 encrypted TOTP authenticator factor.',
    'info',
    v_prev_hash,
    '0x' || encode(sha256(convert_to(v_prev_hash || v_uid::TEXT || 'TOTP_ENROLLED' || now()::TEXT, 'UTF8')), 'hex')
  );

  RETURN jsonb_build_object(
    'enrolled', true,
    'failed_attempts', 0,
    'locked_until', null,
    'locked_remaining_seconds', 0
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, ntps_internal;

-- 4C. Server-Side TOTP Verification with 5-Attempt -> 15-Minute Lockout
CREATE OR REPLACE FUNCTION public.verify_user_totp(
  p_code TEXT,
  p_action_label TEXT DEFAULT 'Protected Operation'
) RETURNS JSONB AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_factor public.user_totp_factors%ROWTYPE;
  v_enc_key TEXT;
  v_plain_secret TEXT;
  v_valid BOOLEAN;
  v_next_attempts INTEGER;
  v_locked_until TIMESTAMPTZ;
  v_rem_sec INTEGER;
  v_prev_hash TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_factor
  FROM public.user_totp_factors
  WHERE user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND OR NOT v_factor.enabled THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'NOT_ENROLLED',
      'remaining_attempts', 0,
      'locked_until', null,
      'locked_remaining_seconds', 0,
      'message', 'Two-factor authentication is not enrolled. Complete TOTP QR setup first.'
    );
  END IF;

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  -- Enforce active 15-minute lockout
  IF v_factor.locked_until IS NOT NULL AND v_factor.locked_until > now() THEN
    v_rem_sec := CEIL(EXTRACT(EPOCH FROM (v_factor.locked_until - now())))::INTEGER;

    INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
    VALUES (
      'TOTP_LOCKED_ATTEMPT',
      v_uid::TEXT,
      NULL,
      'Blocked 2FA attempt during 15-minute lockout for action: ' || COALESCE(NULLIF(trim(p_action_label), ''), 'Protected Operation'),
      'warn',
      v_prev_hash,
      '0x' || encode(sha256(convert_to(v_prev_hash || v_uid::TEXT || 'TOTP_LOCKED' || now()::TEXT, 'UTF8')), 'hex')
    );

    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'LOCKED_OUT',
      'remaining_attempts', 0,
      'locked_until', v_factor.locked_until,
      'locked_remaining_seconds', GREATEST(1, v_rem_sec),
      'message', '2FA is temporarily locked after 5 failed attempts. Try again in ' || GREATEST(1, CEIL(v_rem_sec / 60.0)::INTEGER) || ' minute(s).'
    );
  END IF;

  -- Clear expired lockout window automatically
  IF v_factor.locked_until IS NOT NULL AND v_factor.locked_until <= now() THEN
    v_factor.failed_attempts := 0;
    v_factor.locked_until := NULL;
  END IF;

  v_enc_key := ntps_internal.get_totp_encryption_key();
  v_plain_secret := pgp_sym_decrypt(v_factor.encrypted_secret, v_enc_key);
  v_valid := ntps_internal.verify_totp_secret(v_plain_secret, p_code);

  IF v_valid THEN
    UPDATE public.user_totp_factors
    SET failed_attempts = 0,
        locked_until = NULL,
        last_verified_at = now(),
        updated_at = now()
    WHERE user_id = v_uid;

    INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
    VALUES (
      'TOTP_VERIFIED',
      v_uid::TEXT,
      NULL,
      'Server-side TOTP verification succeeded for: ' || COALESCE(NULLIF(trim(p_action_label), ''), 'Protected Operation'),
      'info',
      v_prev_hash,
      '0x' || encode(sha256(convert_to(v_prev_hash || v_uid::TEXT || 'TOTP_OK' || now()::TEXT, 'UTF8')), 'hex')
    );

    RETURN jsonb_build_object(
      'ok', true,
      'error_code', null,
      'remaining_attempts', 5,
      'locked_until', null,
      'locked_remaining_seconds', 0,
      'message', 'Verified'
    );
  END IF;

  -- Invalid TOTP code: increment failed attempts & enforce 5-attempt lockout
  v_next_attempts := v_factor.failed_attempts + 1;
  IF v_next_attempts >= 5 THEN
    v_locked_until := now() + interval '15 minutes';

    UPDATE public.user_totp_factors
    SET failed_attempts = v_next_attempts,
        locked_until = v_locked_until,
        updated_at = now()
    WHERE user_id = v_uid;

    INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
    VALUES (
      'TOTP_LOCKOUT_TRIGGERED',
      v_uid::TEXT,
      NULL,
      'Operator reached 5 failed TOTP attempts on "' || COALESCE(NULLIF(trim(p_action_label), ''), 'Protected Operation') || '". Locked for 15 minutes.',
      'critical',
      v_prev_hash,
      '0x' || encode(sha256(convert_to(v_prev_hash || v_uid::TEXT || 'TOTP_LOCKOUT' || now()::TEXT, 'UTF8')), 'hex')
    );

    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'LOCKED_OUT',
      'remaining_attempts', 0,
      'locked_until', v_locked_until,
      'locked_remaining_seconds', 900,
      'message', 'Too many failed 2FA attempts (5/5). Verification locked for 15 minutes.'
    );
  ELSE
    UPDATE public.user_totp_factors
    SET failed_attempts = v_next_attempts,
        locked_until = NULL,
        updated_at = now()
    WHERE user_id = v_uid;

    INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
    VALUES (
      'TOTP_FAILED_ATTEMPT',
      v_uid::TEXT,
      NULL,
      'Invalid TOTP code (' || v_next_attempts || '/5) for: ' || COALESCE(NULLIF(trim(p_action_label), ''), 'Protected Operation'),
      'warn',
      v_prev_hash,
      '0x' || encode(sha256(convert_to(v_prev_hash || v_uid::TEXT || 'TOTP_FAIL' || now()::TEXT, 'UTF8')), 'hex')
    );

    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'INVALID_CODE',
      'remaining_attempts', 5 - v_next_attempts,
      'locked_until', null,
      'locked_remaining_seconds', 0,
      'message', 'Invalid 6-digit authenticator code. ' || (5 - v_next_attempts) || ' attempt(s) remaining before 15-minute lockout.'
    );
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, ntps_internal;

-- Restrict RPC privileges strictly to authenticated + service_role
REVOKE ALL ON FUNCTION public.get_totp_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.enroll_user_totp(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.verify_user_totp(TEXT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_totp_status() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enroll_user_totp(TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.verify_user_totp(TEXT, TEXT) TO authenticated, service_role;

COMMIT;
