-- ============================================================================
-- Migration 010: End-to-End KYC / KYB Verification System
-- NOVA Terminal Payment System (NTPS)
--
-- Purpose:
--   1. Create `public.kyc_submissions` supporting Individual (KYC) and
--      Corporate (KYB) onboarding profiles with strict RLS and a BEFORE
--      INSERT/UPDATE anti-tamper trigger so applicants cannot self-approve.
--   2. Create private Supabase Storage bucket `kyc-documents` (`public = false`,
--      10 MB limit, PDF/JPG/PNG only) with folder-scoped RLS policies
--      (`(storage.foldername(name))[1] = auth.uid()::text`) and read-only
--      inspection access for `compliance` / `super_admin` operators.
--   3. Add `public.review_kyc_submission(p_submission_id, p_decision, p_reason)`
--      restricted to active `compliance` and `super_admin` roles in
--      `public.app_admins`, requiring a non-empty reason on rejection and
--      recording a hash-chained `audit_logs` entry without leaking PII.
--   4. Gate `bootstrap_user_terminal`, `provision_sub_terminal_atomic`, and
--      `request_crypto_withdrawal` behind `status = 'approved'` in
--      `public.kyc_submissions` (preserving all Stage-0/1/2 hardening).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. PRE-FLIGHT PREREQUISITE CHECKS
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.terminals') IS NULL THEN
    RAISE EXCEPTION 'Migration 010 requires public.terminals (apply schema.sql first)';
  END IF;
  IF to_regprocedure('public.is_ntps_admin(text[])') IS NULL THEN
    RAISE EXCEPTION 'Migration 010 requires public.is_ntps_admin (apply migration 005 first)';
  END IF;
  IF to_regprocedure('public.is_valid_ntps_terminal_id(text, text)') IS NULL THEN
    RAISE EXCEPTION 'Migration 010 requires public.is_valid_ntps_terminal_id (apply migration 007 first)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. KYC / KYB SUBMISSIONS TABLE & ANTI-TAMPER TRIGGER
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kyc_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  account_type TEXT NOT NULL CHECK (account_type IN ('individual', 'corporate')),
  full_legal_name TEXT NOT NULL,
  date_of_birth DATE NOT NULL,
  nationality TEXT NOT NULL,
  country_of_residence TEXT NOT NULL,
  id_type TEXT NOT NULL CHECK (id_type IN ('national_id', 'passport', 'commercial_registry')),
  id_number TEXT NOT NULL,
  tax_or_reg_number TEXT,
  phone_number TEXT NOT NULL,
  address_line TEXT NOT NULL,
  id_front_path TEXT NOT NULL,
  id_back_path TEXT,
  selfie_path TEXT NOT NULL,
  proof_of_address_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('unverified', 'pending_review', 'approved', 'rejected')),
  rejection_reason TEXT,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kyc_submissions_status_updated
  ON public.kyc_submissions (status, updated_at DESC);

ALTER TABLE public.kyc_submissions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.kyc_submissions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.kyc_submissions TO authenticated;
GRANT ALL ON TABLE public.kyc_submissions TO service_role;

DROP POLICY IF EXISTS "kyc_select_own" ON public.kyc_submissions;
CREATE POLICY "kyc_select_own"
  ON public.kyc_submissions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "kyc_insert_own" ON public.kyc_submissions;
CREATE POLICY "kyc_insert_own"
  ON public.kyc_submissions FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND status IN ('unverified', 'pending_review')
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
  );

DROP POLICY IF EXISTS "kyc_update_own" ON public.kyc_submissions;
CREATE POLICY "kyc_update_own"
  ON public.kyc_submissions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND status IN ('unverified', 'pending_review')
  );

DROP POLICY IF EXISTS "kyc_select_admin" ON public.kyc_submissions;
CREATE POLICY "kyc_select_admin"
  ON public.kyc_submissions FOR SELECT
  TO authenticated
  USING (public.is_ntps_admin(ARRAY['compliance', 'super_admin']));

CREATE OR REPLACE FUNCTION public.guard_kyc_submission_write()
RETURNS TRIGGER AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_jwt_role TEXT := COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '');
  v_rpc_bypass TEXT := COALESCE(NULLIF(current_setting('ntps.kyc_rpc_bypass', true), ''), '');
  v_user_prefix TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
  ELSE
    NEW.created_at := COALESCE(NEW.created_at, now());
    NEW.updated_at := now();
  END IF;

  -- Privileged review_kyc_submission RPC, service_role, or direct SQL migration
  IF v_jwt_role = 'service_role'
     OR v_rpc_bypass = 'true'
     OR (v_jwt_role = '' AND current_user IN ('postgres', 'supabase_admin')) THEN
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
    RAISE EXCEPTION 'Approved KYC/KYB records are locked; contact compliance support for re-verification'
      USING ERRCODE = '42501';
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

  IF NEW.account_type = 'corporate' AND NEW.tax_or_reg_number IS NULL THEN
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_guard_kyc_submission_write ON public.kyc_submissions;
CREATE TRIGGER trg_guard_kyc_submission_write
  BEFORE INSERT OR UPDATE ON public.kyc_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_kyc_submission_write();

-- ----------------------------------------------------------------------------
-- 2. PRIVATE STORAGE BUCKET (`kyc-documents`) & POLICIES
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'kyc-documents',
  'kyc-documents',
  false,
  10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/png']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 10485760,
    allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png'];

DROP POLICY IF EXISTS "kyc_docs_owner_insert" ON storage.objects;
CREATE POLICY "kyc_docs_owner_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'kyc-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "kyc_docs_owner_select" ON storage.objects;
CREATE POLICY "kyc_docs_owner_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'kyc-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "kyc_docs_owner_update" ON storage.objects;
CREATE POLICY "kyc_docs_owner_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'kyc-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'kyc-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "kyc_docs_owner_delete" ON storage.objects;
CREATE POLICY "kyc_docs_owner_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'kyc-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "kyc_docs_compliance_select" ON storage.objects;
CREATE POLICY "kyc_docs_compliance_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'kyc-documents'
    AND public.is_ntps_admin(ARRAY['compliance', 'super_admin'])
  );

-- ----------------------------------------------------------------------------
-- 3. KYC APPROVAL HELPER & COMPLIANCE REVIEW RPC
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_user_kyc_approved(
  p_user_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.kyc_submissions k
    WHERE k.user_id = p_user_id
      AND k.status = 'approved'
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.review_kyc_submission(
  p_submission_id UUID,
  p_decision TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB AS $$
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

  PERFORM set_config('ntps.kyc_rpc_bypass', 'true', true);

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 4. HARD KYC GATES ON TERMINAL PROVISIONING & WITHDRAWALS
-- ----------------------------------------------------------------------------

-- 4A. `bootstrap_user_terminal` (preserves 007 Crockford Mod-37 validation)
CREATE OR REPLACE FUNCTION public.bootstrap_user_terminal(
  p_terminal_id TEXT,
  p_label TEXT DEFAULT 'NOVA Treasury Master'
) RETURNS UUID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_clean_code TEXT := upper(trim(COALESCE(p_terminal_id, '')));
  v_master_id UUID;
  v_suffix TEXT;
  v_prev_hash TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_valid_ntps_terminal_id(v_clean_code, 'master') THEN
    RAISE EXCEPTION 'Invalid Master Terminal ID format or Crockford Mod-37 checksum: %', p_terminal_id;
  END IF;

  SELECT id INTO v_master_id
  FROM public.terminals
  WHERE owner_user_id = v_uid AND type = 'master'
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_master_id IS NOT NULL THEN
    RETURN v_master_id;
  END IF;

  IF NOT public.is_user_kyc_approved(v_uid) THEN
    RAISE EXCEPTION 'KYC/KYB approval is required before provisioning a Master Terminal'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.terminals (
    terminal_id, type, parent_id, owner_user_id, label, tier, status, daily_limit_usd, per_tx_limit_usd, allowed_assets
  ) VALUES (
    v_clean_code, 'master', NULL, v_uid, COALESCE(NULLIF(trim(p_label), ''), 'NOVA Treasury Master'), 'Gold', 'active', 500000.0000, 250000.0000, ARRAY['USDT', 'BTC', 'ETH']
  )
  RETURNING id INTO v_master_id;

  INSERT INTO public.wallets (terminal_id, asset, network, available, pending, locked)
  VALUES
    (v_master_id, 'USDT', 'TRC20', 0, 0, 0),
    (v_master_id, 'USDT', 'ERC20', 0, 0, 0),
    (v_master_id, 'BTC', 'BTC', 0, 0, 0),
    (v_master_id, 'ETH', 'ETH', 0, 0, 0);

  v_suffix := upper(substr(replace(v_master_id::TEXT, '-', ''), 1, 6));

  INSERT INTO public.trading_accounts (terminal_id, account_type, account_login, currency, balance, free_margin, leverage, status)
  VALUES
    (v_master_id, 'nova_margin', 'NOVA-MGIN-' || v_suffix, 'USDT', 0, 0, '1:50', 'active'),
    (v_master_id, 'mt5_omnibus', 'MT5-OMNI-' || v_suffix, 'USDT', 0, 0, '1:100', 'active');

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
  VALUES (
    'TERMINAL_PROVISIONED',
    v_uid::TEXT,
    v_master_id::TEXT,
    'Master treasury vault ' || v_clean_code || ' provisioned for KYC-verified operator.',
    'info',
    v_prev_hash,
    '0x' || encode(sha256(convert_to(v_prev_hash || v_master_id::TEXT || now()::TEXT, 'UTF8')), 'hex')
  );

  RETURN v_master_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4B. `provision_sub_terminal_atomic` (preserves 006 cap lock + 007 Crockford Mod-37)
CREATE OR REPLACE FUNCTION public.provision_sub_terminal_atomic(
  p_terminal_code TEXT,
  p_label TEXT,
  p_daily_limit NUMERIC,
  p_per_tx_limit NUMERIC,
  p_allowed_assets TEXT[]
) RETURNS UUID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_clean_code TEXT := upper(trim(COALESCE(p_terminal_code, '')));
  v_master public.terminals%ROWTYPE;
  v_sub_id UUID;
  v_asset TEXT;
  v_net TEXT;
  v_prev_hash TEXT;
  v_clean_label TEXT := trim(COALESCE(p_label, ''));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_user_kyc_approved(v_uid) THEN
    RAISE EXCEPTION 'KYC/KYB approval is required before provisioning Sub-Terminals'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_valid_ntps_terminal_id(v_clean_code, 'sub') THEN
    RAISE EXCEPTION 'Invalid Sub-Terminal ID format or Crockford Mod-37 checksum: %', p_terminal_code;
  END IF;

  IF v_clean_label = '' THEN
    RAISE EXCEPTION 'Sub-terminal label is required';
  END IF;

  IF p_daily_limit IS NULL OR p_daily_limit <= 0 OR p_per_tx_limit IS NULL OR p_per_tx_limit <= 0 THEN
    RAISE EXCEPTION 'Sub-terminal daily and per-transaction limits must be positive';
  END IF;

  IF p_per_tx_limit > p_daily_limit THEN
    RAISE EXCEPTION 'Per-transaction limit ($%) cannot exceed daily limit ($%)', p_per_tx_limit, p_daily_limit;
  END IF;

  IF array_length(p_allowed_assets, 1) IS NULL OR NOT (p_allowed_assets <@ ARRAY['USDT', 'BTC', 'ETH']::TEXT[]) THEN
    RAISE EXCEPTION 'Allowed assets must be a non-empty subset of USDT, BTC, ETH';
  END IF;

  SELECT * INTO v_master
  FROM public.terminals
  WHERE owner_user_id = v_uid AND type = 'master'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Master terminal not found';
  END IF;

  IF substr(v_clean_code, 1, 18) <> upper(v_master.terminal_id) THEN
    RAISE EXCEPTION 'Sub-terminal prefix (%) must match owning Master Terminal (%)',
      substr(v_clean_code, 1, 18), v_master.terminal_id;
  END IF;

  IF p_daily_limit > v_master.daily_limit_usd THEN
    RAISE EXCEPTION 'Sub-terminal daily limit ($%) cannot exceed Master Terminal cap ($%)',
      p_daily_limit, v_master.daily_limit_usd;
  END IF;

  INSERT INTO public.terminals (
    terminal_id, type, parent_id, owner_user_id, label, tier, status, daily_limit_usd, per_tx_limit_usd, allowed_assets
  ) VALUES (
    v_clean_code, 'sub', v_master.id, v_uid, v_clean_label, 'Desk', 'active', p_daily_limit, p_per_tx_limit, p_allowed_assets
  )
  RETURNING id INTO v_sub_id;

  FOREACH v_asset IN ARRAY p_allowed_assets
  LOOP
    v_net := CASE v_asset WHEN 'USDT' THEN 'TRC20' WHEN 'BTC' THEN 'BTC' ELSE 'ETH' END;
    INSERT INTO public.wallets (terminal_id, asset, network, available)
    VALUES (v_sub_id, v_asset, v_net, 0)
    ON CONFLICT (terminal_id, asset, network) DO NOTHING;
  END LOOP;

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
  VALUES (
    'SUB_TERMINAL_PROVISIONED',
    v_uid::TEXT,
    v_sub_id::TEXT,
    'Provisioned sub-terminal ' || v_clean_code || ' (' || v_clean_label || ')',
    'info',
    v_prev_hash,
    '0x' || encode(sha256(convert_to(v_prev_hash || v_sub_id::TEXT || now()::TEXT, 'UTF8')), 'hex')
  );

  RETURN v_sub_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4C. `request_crypto_withdrawal` (preserves 006 SYS-1 four-eyes + limits + adds KYC gate)
CREATE OR REPLACE FUNCTION public.request_crypto_withdrawal(
  p_terminal_id UUID,
  p_asset TEXT,
  p_network TEXT,
  p_whitelist_address_id UUID,
  p_amount NUMERIC,
  p_fee NUMERIC,
  p_memo TEXT,
  p_idempotency_key TEXT,
  p_auto_approve BOOLEAN DEFAULT FALSE
) RETURNS UUID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_jwt_role TEXT := COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '');
  v_is_privileged BOOLEAN := FALSE;
  v_term public.terminals%ROWTYPE;
  v_wl public.whitelist_addresses%ROWTYPE;
  v_existing_tx_id UUID;
  v_usd_rate NUMERIC;
  v_usd_amount NUMERIC;
  v_daily_used_usd NUMERIC := 0;
  v_total_required NUMERIC;
  v_total_avail NUMERIC := 0;
  v_remaining NUMERIC;
  v_take NUMERIC;
  v_wallet RECORD;
  v_journal_id UUID;
  v_tx_id UUID;
  v_ref TEXT;
  v_prev_hash TEXT;
  v_req_state TEXT;
BEGIN
  IF v_uid IS NULL AND v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_jwt_role <> 'service_role' AND NOT public.is_user_kyc_approved(v_uid) THEN
    RAISE EXCEPTION 'KYC/KYB approval is required before initiating external withdrawals'
      USING ERRCODE = '42501';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Withdrawal amount must be positive';
  END IF;

  IF COALESCE(p_fee, 0) < 0 THEN
    RAISE EXCEPTION 'Withdrawal network fee cannot be negative';
  END IF;

  SELECT tx.id INTO v_existing_tx_id
  FROM public.journal_entries je
  JOIN public.transactions tx ON tx.journal_id = je.id
  WHERE je.idempotency_key = p_idempotency_key
  LIMIT 1;

  IF v_existing_tx_id IS NOT NULL THEN
    RETURN v_existing_tx_id;
  END IF;

  SELECT * INTO v_term
  FROM public.terminals
  WHERE id = p_terminal_id
    AND (v_jwt_role = 'service_role' OR owner_user_id = v_uid)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source terminal not found or unauthorized';
  END IF;

  IF v_term.status <> 'active' THEN
    RAISE EXCEPTION 'Terminal must be active to initiate external withdrawals';
  END IF;

  IF NOT (p_asset = ANY(v_term.allowed_assets)) THEN
    RAISE EXCEPTION 'Asset % is restricted by terminal % policy', p_asset, v_term.terminal_id;
  END IF;

  v_usd_rate := public.get_asset_usd_rate(p_asset);
  v_usd_amount := p_amount * v_usd_rate;

  IF v_usd_amount > v_term.per_tx_limit_usd THEN
    RAISE EXCEPTION 'Withdrawal value ($%) exceeds terminal per-transaction limit ($%)',
      round(v_usd_amount, 2), round(v_term.per_tx_limit_usd, 2);
  END IF;

  SELECT COALESCE(SUM(tx.amount * public.get_asset_usd_rate(tx.asset)), 0)
  INTO v_daily_used_usd
  FROM public.transactions tx
  WHERE tx.terminal_id = v_term.id
    AND tx.type = 'withdrawal'
    AND tx.status NOT IN ('reversed', 'failed')
    AND tx.created_at >= now() - interval '24 hours';

  IF v_daily_used_usd + v_usd_amount > v_term.daily_limit_usd THEN
    RAISE EXCEPTION 'Withdrawal ($%) exceeds 24h terminal daily limit (used $% / cap $%)',
      round(v_usd_amount, 2), round(v_daily_used_usd, 2), round(v_term.daily_limit_usd, 2);
  END IF;

  SELECT * INTO v_wl
  FROM public.whitelist_addresses
  WHERE id = p_whitelist_address_id
    AND terminal_id = v_term.id
    AND asset = p_asset
    AND network = p_network
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Verified whitelist address not found for % (%)', p_asset, p_network;
  END IF;

  v_total_required := p_amount + COALESCE(p_fee, 0);

  FOR v_wallet IN
    SELECT * FROM public.wallets
    WHERE terminal_id = v_term.id AND asset = p_asset
    ORDER BY (network = p_network) DESC, available DESC, id ASC
    FOR UPDATE
  LOOP
    v_total_avail := v_total_avail + v_wallet.available;
  END LOOP;

  IF v_total_avail < v_total_required THEN
    RAISE EXCEPTION 'Insufficient available % balance for withdrawal + fee', p_asset;
  END IF;

  v_ref := 'NTPS-' || to_char(now(), 'YYMMDD') || '-' || substr(md5(p_idempotency_key || clock_timestamp()::TEXT), 1, 4);

  INSERT INTO public.journal_entries (kind, idempotency_key, memo, created_by)
  VALUES ('withdrawal', p_idempotency_key, COALESCE(NULLIF(trim(p_memo), ''), 'Custody withdrawal (' || v_wl.label || ')'), v_uid)
  RETURNING id INTO v_journal_id;

  v_remaining := v_total_required;

  FOR v_wallet IN
    SELECT * FROM public.wallets
    WHERE terminal_id = v_term.id AND asset = p_asset AND available > 0
    ORDER BY (network = p_network) DESC, available DESC, id ASC
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_wallet.available, v_remaining);
    IF v_take > 0 THEN
      UPDATE public.wallets
      SET available = available - v_take,
          version = version + 1,
          updated_at = now()
      WHERE id = v_wallet.id;

      INSERT INTO public.ledger_postings (journal_id, account_ref, asset, amount)
      VALUES (v_journal_id, 'wallet:' || v_wallet.id::TEXT, p_asset, -v_take);

      v_remaining := v_remaining - v_take;
    END IF;
  END LOOP;

  INSERT INTO public.ledger_postings (journal_id, account_ref, asset, amount)
  VALUES (v_journal_id, 'system:withdrawal_escrow_' || lower(p_asset) || '_' || lower(p_network), p_asset, p_amount);

  IF COALESCE(p_fee, 0) > 0 THEN
    INSERT INTO public.ledger_postings (journal_id, account_ref, asset, amount)
    VALUES (v_journal_id, 'system:fee_revenue_' || lower(p_asset), p_asset, p_fee);
  END IF;

  INSERT INTO public.transactions (
    reference, terminal_id, counterparty_terminal, type, asset, network, amount, fee, status, tx_hash, journal_id, memo
  ) VALUES (
    upper(v_ref), v_term.id, v_wl.address, 'withdrawal', p_asset, p_network, p_amount, COALESCE(p_fee, 0), 'pending', NULL, v_journal_id, p_memo
  )
  RETURNING id INTO v_tx_id;

  v_is_privileged := (v_jwt_role = 'service_role')
    OR public.is_ntps_admin(ARRAY['ops', 'compliance', 'super_admin']);

  v_req_state := CASE
    WHEN COALESCE(p_auto_approve, FALSE)
      AND v_is_privileged
      AND v_usd_amount < 25000
    THEN 'approved'
    ELSE 'review'
  END;

  INSERT INTO public.withdrawal_requests (transaction_id, whitelist_address_id, state)
  VALUES (v_tx_id, v_wl.id, v_req_state);

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
  VALUES (
    'WITHDRAWAL_REQUESTED',
    COALESCE(v_uid::TEXT, 'service_role'),
    v_term.id::TEXT,
    'Queued ' || p_amount::TEXT || ' ' || p_asset || ' (' || p_network || ', $' || round(v_usd_amount, 2)::TEXT || ') to ' || v_wl.address || ' in state=' || v_req_state
      || CASE WHEN COALESCE(p_auto_approve, FALSE) AND v_req_state <> 'approved' THEN ' (auto_approve ignored)' ELSE '' END,
    CASE WHEN v_req_state = 'review' THEN 'warn' ELSE 'info' END,
    v_prev_hash,
    '0x' || encode(sha256(convert_to(v_prev_hash || v_tx_id::TEXT || now()::TEXT, 'UTF8')), 'hex')
  );

  RETURN v_tx_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 5. PRIVILEGE LOCKS & REALTIME PUBLICATION
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.guard_kyc_submission_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_user_kyc_approved(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_user_kyc_approved(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.review_kyc_submission(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_kyc_submission(UUID, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.bootstrap_user_terminal(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bootstrap_user_terminal(TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.provision_sub_terminal_atomic(TEXT, TEXT, NUMERIC, NUMERIC, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.provision_sub_terminal_atomic(TEXT, TEXT, NUMERIC, NUMERIC, TEXT[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.request_crypto_withdrawal(UUID, TEXT, TEXT, UUID, NUMERIC, NUMERIC, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_crypto_withdrawal(UUID, TEXT, TEXT, UUID, NUMERIC, NUMERIC, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'kyc_submissions'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.kyc_submissions;
  END IF;
END $$;

COMMIT;
