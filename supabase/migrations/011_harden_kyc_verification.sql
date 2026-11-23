-- ============================================================================
-- Migration 011: Harden KYC / KYB Verification (KYC-1 through KYC-5)
-- NOVA Terminal Payment System (NTPS)
--
-- Purpose:
--   [KYC-1] Enforce uniqueness on normalized (id_number, id_type) across
--           approved KYC/KYB submissions (allowing resubmission after reject).
--   [KYC-2] Prevent document owners from deleting or overwriting uploaded
--           files in `kyc-documents` while submission is pending_review or
--           approved (preserving compliance evidence).
--   [KYC-3] Allow nullable date_of_birth for corporate (KYB) accounts and
--           enforce minimum age >= 18 years for individual KYC accounts.
--   [KYC-4] Replace GUC bypass (`ntps.kyc_rpc_bypass`) in the KYC write guard
--           with strict PostgreSQL SECURITY INVOKER role verification
--           (`current_user IN ('postgres', 'supabase_admin', 'service_role')`),
--           and remove `set_config('ntps.kyc_rpc_bypass', ...)` from
--           `review_kyc_submission`.
--   [KYC-5] Restrict `is_user_kyc_approved(UUID)` to `service_role` only and
--           expose safe `is_my_kyc_approved()` for authenticated callers.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. PRE-FLIGHT PREREQUISITE CHECK
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.kyc_submissions') IS NULL THEN
    RAISE EXCEPTION 'Migration 011 requires public.kyc_submissions (apply migration 010 first)';
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- [KYC-1] Enforce uniqueness on normalized id_number + id_type for approved
--         submissions only (allows re-submission after rejection)
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_kyc_submissions_approved_id_unique
  ON public.kyc_submissions (upper(trim(id_number)), lower(trim(id_type)))
  WHERE status = 'approved'
    AND id_number IS NOT NULL
    AND btrim(id_number) <> '';

-- ----------------------------------------------------------------------------
-- [KYC-3] Allow nullable date_of_birth for corporate (KYB) accounts and
--         enforce minimum age >= 18 years for individual accounts
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'kyc_submissions'
      AND column_name = 'date_of_birth'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.kyc_submissions
      ALTER COLUMN date_of_birth DROP NOT NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_kyc_dob_and_minimum_age'
      AND conrelid = 'public.kyc_submissions'::regclass
  ) THEN
    ALTER TABLE public.kyc_submissions
      ADD CONSTRAINT chk_kyc_dob_and_minimum_age
      CHECK (
        COALESCE(lower(trim(account_type)), 'individual') = 'corporate'
        OR (
          date_of_birth IS NOT NULL
          AND date_of_birth <= (CURRENT_DATE - INTERVAL '18 years')::date
        )
      ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.kyc_submissions
  VALIDATE CONSTRAINT chk_kyc_dob_and_minimum_age;

-- ----------------------------------------------------------------------------
-- [KYC-2] Prevent owners from deleting or overwriting KYC documents once a
--         submission is pending_review or approved (preserve evidence)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "kyc_docs_owner_delete" ON storage.objects;
CREATE POLICY "kyc_docs_owner_delete"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'kyc-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND NOT EXISTS (
      SELECT 1
      FROM public.kyc_submissions ks
      WHERE ks.user_id = auth.uid()
        AND ks.status IN ('pending_review', 'approved')
    )
  );

DROP POLICY IF EXISTS "kyc_docs_owner_update" ON storage.objects;
CREATE POLICY "kyc_docs_owner_update"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'kyc-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND NOT EXISTS (
      SELECT 1
      FROM public.kyc_submissions ks
      WHERE ks.user_id = auth.uid()
        AND ks.status IN ('pending_review', 'approved')
    )
  )
  WITH CHECK (
    bucket_id = 'kyc-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND NOT EXISTS (
      SELECT 1
      FROM public.kyc_submissions ks
      WHERE ks.user_id = auth.uid()
        AND ks.status IN ('pending_review', 'approved')
    )
  );

-- ----------------------------------------------------------------------------
-- [KYC-4] Harden trigger guard: unify into a SECURITY INVOKER trigger that
--         checks privileged PostgreSQL role (`current_user`) rather than any
--         client-accessible GUC string, while preserving all anti-tamper,
--         path-traversal, immutability, and age-18 checks.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_guard_kyc_submission_write ON public.kyc_submissions;
DROP TRIGGER IF EXISTS trg_enforce_kyc_immutability_and_guard ON public.kyc_submissions;
DROP FUNCTION IF EXISTS public.guard_kyc_submission_write();

CREATE OR REPLACE FUNCTION public.enforce_kyc_immutability_and_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_is_privileged_role BOOLEAN;
  v_user_prefix TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
  ELSE
    NEW.created_at := COALESCE(NEW.created_at, now());
    NEW.updated_at := now();
  END IF;

  -- SECURITY INVOKER ensures `current_user` reflects the active PostgreSQL
  -- execution context ('authenticated' on direct PostgREST writes vs
  -- 'postgres'/'supabase_admin'/'service_role' inside SECURITY DEFINER RPCs
  -- or privileged sessions). Never trust custom GUC flags here.
  v_is_privileged_role := (current_user IN ('postgres', 'supabase_admin', 'service_role'));

  IF v_is_privileged_role THEN
    RETURN NEW;
  END IF;

  IF v_uid IS NULL OR NEW.user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Forbidden: KYC submission user_id must match authenticated operator'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'Forbidden: cannot reassign KYC submission ownership'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'approved' THEN
    RAISE EXCEPTION 'Approved KYC/KYB submissions cannot be modified'
      USING ERRCODE = '42501';
  END IF;

  -- Enforce minimum age 18 for non-corporate (individual) KYC submissions
  IF COALESCE(lower(trim(NEW.account_type)), 'individual') <> 'corporate' THEN
    IF NEW.date_of_birth IS NULL THEN
      RAISE EXCEPTION 'date_of_birth is required for individual KYC submissions'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.date_of_birth > (CURRENT_DATE - INTERVAL '18 years')::date THEN
      RAISE EXCEPTION 'Applicant must be at least 18 years old'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.date_of_birth IS NOT NULL AND NEW.date_of_birth > CURRENT_DATE THEN
    RAISE EXCEPTION 'Incorporation date cannot be in the future'
      USING ERRCODE = '23514';
  END IF;

  NEW.full_legal_name := trim(COALESCE(NEW.full_legal_name, ''));
  NEW.nationality := trim(COALESCE(NEW.nationality, ''));
  NEW.country_of_residence := trim(COALESCE(NEW.country_of_residence, ''));
  NEW.id_number := trim(COALESCE(NEW.id_number, ''));
  NEW.tax_or_reg_number := NULLIF(trim(COALESCE(NEW.tax_or_reg_number, '')), '');
  NEW.phone_number := trim(COALESCE(NEW.phone_number, ''));
  NEW.address_line := trim(COALESCE(NEW.address_line, ''));
  NEW.id_front_path := trim(COALESCE(NEW.id_front_path, ''));
  NEW.id_back_path := NULLIF(trim(COALESCE(NEW.id_back_path, '')), '');
  NEW.selfie_path := trim(COALESCE(NEW.selfie_path, ''));
  NEW.proof_of_address_path := trim(COALESCE(NEW.proof_of_address_path, ''));

  IF length(NEW.full_legal_name) < 2
     OR NEW.nationality = ''
     OR NEW.country_of_residence = ''
     OR length(NEW.id_number) < 3
     OR length(NEW.phone_number) < 5
     OR length(NEW.address_line) < 5 THEN
    RAISE EXCEPTION 'Incomplete KYC/KYB applicant details'
      USING ERRCODE = '23514';
  END IF;

  IF COALESCE(lower(trim(NEW.account_type)), 'individual') = 'corporate'
     AND NEW.tax_or_reg_number IS NULL THEN
    RAISE EXCEPTION 'Corporate KYB submissions require a tax or registration number'
      USING ERRCODE = '23514';
  END IF;

  v_user_prefix := v_uid::TEXT || '/';

  IF left(NEW.id_front_path, length(v_user_prefix)) <> v_user_prefix
     OR NEW.id_front_path LIKE '%..%'
     OR left(NEW.selfie_path, length(v_user_prefix)) <> v_user_prefix
     OR NEW.selfie_path LIKE '%..%'
     OR left(NEW.proof_of_address_path, length(v_user_prefix)) <> v_user_prefix
     OR NEW.proof_of_address_path LIKE '%..%'
     OR (
       NEW.id_back_path IS NOT NULL
       AND (left(NEW.id_back_path, length(v_user_prefix)) <> v_user_prefix OR NEW.id_back_path LIKE '%..%')
     ) THEN
    RAISE EXCEPTION 'Invalid KYC storage document path: files must reside inside your user folder'
      USING ERRCODE = '42501';
  END IF;

  -- Force applicant writes into pending_review and strip any attempted review fields
  NEW.status := 'pending_review';
  NEW.rejection_reason := NULL;
  NEW.reviewed_by := NULL;
  NEW.reviewed_at := NULL;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_kyc_immutability_and_guard
  BEFORE INSERT OR UPDATE ON public.kyc_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_kyc_immutability_and_guard();

REVOKE ALL ON FUNCTION public.enforce_kyc_immutability_and_guard() FROM PUBLIC, anon, authenticated;

-- Update `review_kyc_submission` to remove `ntps.kyc_rpc_bypass` GUC reliance
-- and surface a clean conflict error if another user already holds an approved
-- submission for the same normalized (id_number, id_type) [KYC-1].
CREATE OR REPLACE FUNCTION public.review_kyc_submission(
  p_submission_id UUID,
  p_decision TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_admin_role TEXT;
  v_decision TEXT := lower(trim(COALESCE(p_decision, '')));
  v_clean_reason TEXT := trim(COALESCE(p_reason, ''));
  v_sub public.kyc_submissions%ROWTYPE;
  v_prev_hash TEXT;
  v_now TIMESTAMPTZ := now();
  v_row_hash TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_ntps_admin(ARRAY['compliance', 'super_admin']) THEN
    RAISE EXCEPTION 'Forbidden: active compliance or super_admin role required in app_admins'
      USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_admin_role
  FROM public.app_admins
  WHERE user_id = v_uid AND is_active = TRUE;

  IF v_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid KYC review decision: %. Expected approved or rejected', p_decision;
  END IF;

  IF v_decision = 'rejected' AND v_clean_reason = '' THEN
    RAISE EXCEPTION 'Mandatory rejection reason is required when rejecting a KYC submission';
  END IF;

  SELECT * INTO v_sub
  FROM public.kyc_submissions
  WHERE id = p_submission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KYC submission not found';
  END IF;

  IF v_decision = 'approved' THEN
    IF COALESCE(lower(trim(v_sub.account_type)), 'individual') <> 'corporate'
       AND (
         v_sub.date_of_birth IS NULL
         OR v_sub.date_of_birth > (CURRENT_DATE - INTERVAL '18 years')::date
       ) THEN
      RAISE EXCEPTION 'Cannot approve individual KYC: applicant must be at least 18 years old';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.kyc_submissions other
      WHERE other.id <> v_sub.id
        AND other.status = 'approved'
        AND upper(trim(other.id_number)) = upper(trim(v_sub.id_number))
        AND lower(trim(other.id_type)) = lower(trim(v_sub.id_type))
    ) THEN
      RAISE EXCEPTION 'Duplicate identity conflict: another approved KYC/KYB account already uses this ID number and type'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  UPDATE public.kyc_submissions
  SET status = v_decision,
      rejection_reason = CASE
        WHEN v_decision = 'rejected' THEN v_clean_reason
        ELSE NULL
      END,
      reviewed_by = v_uid,
      reviewed_at = v_now,
      updated_at = v_now
  WHERE id = v_sub.id
  RETURNING * INTO v_sub;

  -- Serialize hash-chain head read + insert to prevent concurrent prev_hash forks
  PERFORM pg_advisory_xact_lock(hashtext('ntps_audit_logs_chain'));

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC, id DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  v_row_hash := '0x' || encode(
    sha256(
      convert_to(
        v_prev_hash || '|' || v_sub.id::TEXT || '|' || v_decision || '|' || COALESCE(v_clean_reason, '') || '|' ||
        to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'UTF8'
      )
    ),
    'hex'
  );

  INSERT INTO public.audit_logs (
    event_type, actor, terminal_id, details, severity, prev_hash, row_hash, created_at
  ) VALUES (
    'KYC_SUBMISSION_' || upper(v_decision),
    v_uid::TEXT,
    NULL,
    'KYC submission ' || v_sub.id::TEXT || ' (' || v_sub.account_type || ') for user ' || v_sub.user_id::TEXT ||
      ' was ' || v_decision || ' by ' || COALESCE(v_admin_role, 'compliance') ||
      CASE WHEN v_clean_reason <> '' THEN '. Reason: ' || v_clean_reason ELSE '' END,
    CASE WHEN v_decision = 'approved' THEN 'info' ELSE 'warn' END,
    v_prev_hash,
    v_row_hash,
    v_now
  );

  RETURN jsonb_build_object(
    'id', v_sub.id,
    'user_id', v_sub.user_id,
    'status', v_sub.status,
    'rejection_reason', v_sub.rejection_reason,
    'reviewed_by', v_sub.reviewed_by,
    'reviewed_at', v_sub.reviewed_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.review_kyc_submission(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_kyc_submission(UUID, TEXT, TEXT) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- [KYC-5] Restrict is_user_kyc_approved(UUID) to service_role only and provide
--         a safe self-check helper is_my_kyc_approved() for authenticated users
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'is_user_kyc_approved'
      AND pg_get_function_identity_arguments(p.oid) = 'uuid'
  ) THEN
    REVOKE ALL ON FUNCTION public.is_user_kyc_approved(UUID) FROM PUBLIC;
    REVOKE EXECUTE ON FUNCTION public.is_user_kyc_approved(UUID) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.is_user_kyc_approved(UUID) FROM anon;
    GRANT EXECUTE ON FUNCTION public.is_user_kyc_approved(UUID) TO service_role;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.is_my_kyc_approved()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.kyc_submissions
    WHERE user_id = auth.uid()
      AND status = 'approved'
  );
$$;

REVOKE ALL ON FUNCTION public.is_my_kyc_approved() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_my_kyc_approved() TO authenticated, service_role;

COMMIT;
