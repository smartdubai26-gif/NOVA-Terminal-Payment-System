-- ============================================================================
-- Migration 008: Stage-2 Periodic & Defensive Worker Lease Hardening
-- NOVA Terminal Payment System (NTPS)
--
-- Purpose:
--   Closes database-supported Stage-2 concurrency hardening (`W-21`) after
--   migrations 001 through 007:
--     - W-21: Add atomic PgBouncer-safe worker cycle lease RPCs
--             (`acquire_worker_lease`, `release_worker_lease`) backed by
--             `public.worker_checkpoints.metadata` (`service_role` only) so
--             accidental multi-replica deployments cannot process overlapping
--             withdrawal broadcast or deposit watcher cycles.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.acquire_worker_lease(
  p_worker_key TEXT,
  p_instance_id TEXT,
  p_ttl_seconds INTEGER DEFAULT 45
) RETURNS BOOLEAN AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '');
  v_clean_key TEXT := trim(COALESCE(p_worker_key, ''));
  v_clean_instance TEXT := trim(COALESCE(p_instance_id, ''));
  v_ttl_seconds INTEGER := GREATEST(10, LEAST(COALESCE(p_ttl_seconds, 45), 300));
  v_now TIMESTAMPTZ := now();
  v_expires_at TIMESTAMPTZ := v_now + make_interval(secs => v_ttl_seconds);
  v_claimed_key TEXT;
BEGIN
  IF v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'Forbidden: acquire_worker_lease requires service_role'
      USING ERRCODE = '42501';
  END IF;

  IF v_clean_key = '' THEN
    RAISE EXCEPTION 'worker_key is required';
  END IF;

  IF v_clean_instance = '' THEN
    RAISE EXCEPTION 'instance_id is required';
  END IF;

  INSERT INTO public.worker_checkpoints (
    worker_key,
    cursor_ms,
    consecutive_failures,
    last_error,
    metadata,
    updated_at
  ) VALUES (
    v_clean_key,
    0,
    0,
    NULL,
    jsonb_build_object(
      'lease_owner', v_clean_instance,
      'lease_acquired_at', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'lease_expires_at', to_char(v_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ),
    v_now
  )
  ON CONFLICT (worker_key) DO UPDATE
  SET
    metadata = COALESCE(public.worker_checkpoints.metadata, '{}'::jsonb) || jsonb_build_object(
      'lease_owner', v_clean_instance,
      'lease_acquired_at', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'lease_expires_at', to_char(v_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ),
    updated_at = v_now
  WHERE
    NULLIF(public.worker_checkpoints.metadata->>'lease_owner', '') IS NULL
    OR public.worker_checkpoints.metadata->>'lease_owner' = v_clean_instance
    OR NULLIF(public.worker_checkpoints.metadata->>'lease_expires_at', '') IS NULL
    OR (public.worker_checkpoints.metadata->>'lease_expires_at')::timestamptz <= v_now
  RETURNING worker_key INTO v_claimed_key;

  RETURN v_claimed_key IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.release_worker_lease(
  p_worker_key TEXT,
  p_instance_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '');
  v_clean_key TEXT := trim(COALESCE(p_worker_key, ''));
  v_clean_instance TEXT := trim(COALESCE(p_instance_id, ''));
  v_released_key TEXT;
BEGIN
  IF v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'Forbidden: release_worker_lease requires service_role'
      USING ERRCODE = '42501';
  END IF;

  IF v_clean_key = '' OR v_clean_instance = '' THEN
    RETURN FALSE;
  END IF;

  UPDATE public.worker_checkpoints
  SET
    metadata = COALESCE(metadata, '{}'::jsonb) - 'lease_owner' - 'lease_expires_at' - 'lease_acquired_at',
    updated_at = now()
  WHERE worker_key = v_clean_key
    AND metadata->>'lease_owner' = v_clean_instance
  RETURNING worker_key INTO v_released_key;

  RETURN v_released_key IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.acquire_worker_lease(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_worker_lease(TEXT, TEXT, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public.release_worker_lease(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_worker_lease(TEXT, TEXT) TO service_role;

COMMIT;
