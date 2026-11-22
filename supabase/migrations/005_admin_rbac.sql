-- ============================================================================
-- Migration 005: Role-Based Admin Access Control (RBAC)
-- NOVA Terminal Payment System (NTPS)
--
-- Purpose:
--   1. Create `public.app_admins` separating privileged ops/compliance/treasury/
--      super_admin operators from standard terminal owners (`auth.uid()`).
--   2. Add `public.is_ntps_admin(required_roles)` and `public.get_my_admin_role()`
--      helper functions (`SECURITY DEFINER`, `SET search_path = public`).
--   3. Grant active admins read-only SELECT visibility across operational tables
--      via non-recursive RLS policies while blocking all client writes to `app_admins`.
--   4. Harden `review_withdrawal_request` and `update_terminal_status_admin` so
--      only active admins with role IN ('ops', 'compliance', 'super_admin') can
--      execute them, requiring a non-empty audit reason and writing a hash-chained
--      `audit_logs` record.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. ADMIN ROLE REGISTRY (`public.app_admins`)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_admins (
  user_id UUID PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('ops', 'compliance', 'treasury', 'super_admin')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.app_admins ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.app_admins FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.app_admins TO service_role;
GRANT SELECT ON TABLE public.app_admins TO authenticated;

DROP POLICY IF EXISTS "app_admins_select_own" ON public.app_admins;
CREATE POLICY "app_admins_select_own"
  ON public.app_admins FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 2. ADMIN CHECK HELPER FUNCTIONS (`SET search_path = public`)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_ntps_admin(
  required_roles TEXT[] DEFAULT ARRAY['ops', 'compliance', 'treasury', 'super_admin']
) RETURNS BOOLEAN AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.app_admins a
    WHERE a.user_id = v_uid
      AND a.is_active = TRUE
      AND (
        a.role = 'super_admin'
        OR a.role = ANY(COALESCE(required_roles, ARRAY['ops', 'compliance', 'treasury', 'super_admin']::TEXT[]))
      )
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_my_admin_role()
RETURNS JSONB AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_admin public.app_admins%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'is_admin', FALSE,
      'role', NULL,
      'is_active', FALSE
    );
  END IF;

  SELECT * INTO v_admin
  FROM public.app_admins
  WHERE user_id = v_uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'is_admin', FALSE,
      'role', NULL,
      'is_active', FALSE
    );
  END IF;

  RETURN jsonb_build_object(
    'is_admin', v_admin.is_active,
    'role', v_admin.role,
    'is_active', v_admin.is_active
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 3. ADMIN READ-ONLY RLS POLICIES (SEPARATE OPERATORS CAN INSPECT ALL TERMINALS)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "terminals_select_admin" ON public.terminals;
CREATE POLICY "terminals_select_admin"
  ON public.terminals FOR SELECT
  TO authenticated
  USING (public.is_ntps_admin());

DROP POLICY IF EXISTS "wallets_select_admin" ON public.wallets;
CREATE POLICY "wallets_select_admin"
  ON public.wallets FOR SELECT
  TO authenticated
  USING (public.is_ntps_admin());

DROP POLICY IF EXISTS "journal_entries_select_admin" ON public.journal_entries;
CREATE POLICY "journal_entries_select_admin"
  ON public.journal_entries FOR SELECT
  TO authenticated
  USING (public.is_ntps_admin());

DROP POLICY IF EXISTS "ledger_postings_select_admin" ON public.ledger_postings;
CREATE POLICY "ledger_postings_select_admin"
  ON public.ledger_postings FOR SELECT
  TO authenticated
  USING (public.is_ntps_admin());

DROP POLICY IF EXISTS "transactions_select_admin" ON public.transactions;
CREATE POLICY "transactions_select_admin"
  ON public.transactions FOR SELECT
  TO authenticated
  USING (public.is_ntps_admin());

DROP POLICY IF EXISTS "whitelist_select_admin" ON public.whitelist_addresses;
CREATE POLICY "whitelist_select_admin"
  ON public.whitelist_addresses FOR SELECT
  TO authenticated
  USING (public.is_ntps_admin());

DROP POLICY IF EXISTS "withdrawal_requests_select_admin" ON public.withdrawal_requests;
CREATE POLICY "withdrawal_requests_select_admin"
  ON public.withdrawal_requests FOR SELECT
  TO authenticated
  USING (public.is_ntps_admin());

DROP POLICY IF EXISTS "audit_logs_select_admin" ON public.audit_logs;
CREATE POLICY "audit_logs_select_admin"
  ON public.audit_logs FOR SELECT
  TO authenticated
  USING (public.is_ntps_admin());

-- ----------------------------------------------------------------------------
-- 4. RBAC-ENFORCED ADMIN RPCs
-- ----------------------------------------------------------------------------

-- 4A. Four-Eyes Withdrawal Queue Review (ops / compliance / super_admin)
DROP FUNCTION IF EXISTS public.review_withdrawal_request(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.review_withdrawal_request(
  p_transaction_id UUID,
  p_action TEXT,
  p_reason TEXT
) RETURNS VOID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_admin_role TEXT;
  v_clean_reason TEXT := trim(COALESCE(p_reason, ''));
  v_tx public.transactions%ROWTYPE;
  v_req public.withdrawal_requests%ROWTYPE;
  v_rev_journal_id UUID;
  v_posting RECORD;
  v_wallet_id UUID;
  v_prev_hash TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_ntps_admin(ARRAY['ops', 'compliance', 'super_admin']) THEN
    RAISE EXCEPTION 'Forbidden: active ops, compliance, or super_admin role required in app_admins'
      USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_admin_role
  FROM public.app_admins
  WHERE user_id = v_uid AND is_active = TRUE;

  IF v_clean_reason = '' THEN
    RAISE EXCEPTION 'Mandatory compliance review reason is required';
  END IF;

  IF p_action NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'Invalid review action: %', p_action;
  END IF;

  SELECT tx.* INTO v_tx
  FROM public.transactions tx
  WHERE tx.id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Withdrawal transaction not found';
  END IF;

  SELECT * INTO v_req
  FROM public.withdrawal_requests
  WHERE transaction_id = v_tx.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Associated withdrawal_requests row not found';
  END IF;

  IF p_action = 'approve' THEN
    IF v_req.state <> 'review' THEN
      RAISE EXCEPTION 'Withdrawal request is already in state %', v_req.state;
    END IF;

    UPDATE public.withdrawal_requests
    SET state = 'approved'
    WHERE id = v_req.id;
  ELSE
    IF v_req.state NOT IN ('review', 'approved') THEN
      RAISE EXCEPTION 'Cannot reject withdrawal in state %; manual reconciliation required', v_req.state
        USING ERRCODE = '40001';
    END IF;

    IF v_tx.status = 'completed' OR v_tx.tx_hash IS NOT NULL THEN
      RAISE EXCEPTION 'Withdrawal % already has on-chain tx_hash or completed status; manual reconciliation required', v_tx.reference
        USING ERRCODE = '40001';
    END IF;

    IF v_req.broadcast_at IS NOT NULL OR v_req.tx_hash_candidate IS NOT NULL THEN
      RAISE EXCEPTION 'Withdrawal % already entered worker broadcast pipeline; manual reconciliation required', v_tx.reference
        USING ERRCODE = '40001';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.journal_entries WHERE idempotency_key = 'rev_' || v_tx.id::TEXT
    ) THEN
      RAISE EXCEPTION 'Withdrawal % reversal already recorded', v_tx.reference
        USING ERRCODE = '40001';
    END IF;

    UPDATE public.withdrawal_requests
    SET state = 'rejected'
    WHERE id = v_req.id;

    UPDATE public.transactions
    SET status = 'reversed'
    WHERE id = v_tx.id;

    IF v_tx.journal_id IS NOT NULL THEN
      INSERT INTO public.journal_entries (kind, idempotency_key, memo, created_by)
      VALUES ('withdrawal_reversal', 'rev_' || v_tx.id::TEXT, 'Compliance reversal of ' || v_tx.reference || ' (' || v_clean_reason || ')', v_uid)
      RETURNING id INTO v_rev_journal_id;

      FOR v_posting IN
        SELECT * FROM public.ledger_postings WHERE journal_id = v_tx.journal_id
      LOOP
        INSERT INTO public.ledger_postings (journal_id, account_ref, asset, amount)
        VALUES (v_rev_journal_id, v_posting.account_ref, v_posting.asset, -v_posting.amount);

        IF v_posting.account_ref LIKE 'wallet:%' AND v_posting.amount < 0 THEN
          v_wallet_id := substring(v_posting.account_ref FROM 8)::UUID;
          UPDATE public.wallets
          SET available = available + ABS(v_posting.amount),
              version = version + 1,
              updated_at = now()
          WHERE id = v_wallet_id;
        END IF;
      END LOOP;
    END IF;
  END IF;

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
  VALUES (
    'WITHDRAWAL_REVIEW_' || upper(p_action),
    v_uid::TEXT,
    v_tx.terminal_id::TEXT,
    'Transaction ' || v_tx.reference || ' was ' || p_action || 'd by ' || COALESCE(v_admin_role, 'admin') || '. Reason: ' || v_clean_reason,
    CASE WHEN p_action = 'approve' THEN 'info' ELSE 'warn' END,
    v_prev_hash,
    '0x' || encode(digest(v_prev_hash || v_tx.id::TEXT || p_action || v_clean_reason || now()::TEXT, 'sha256'), 'hex')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4B. Admin Terminal Status Control (ops / compliance / super_admin)
CREATE OR REPLACE FUNCTION public.update_terminal_status_admin(
  p_terminal_id UUID,
  p_status TEXT,
  p_reason TEXT
) RETURNS VOID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_admin_role TEXT;
  v_clean_reason TEXT := trim(COALESCE(p_reason, ''));
  v_term public.terminals%ROWTYPE;
  v_prev_status TEXT;
  v_prev_hash TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_ntps_admin(ARRAY['ops', 'compliance', 'super_admin']) THEN
    RAISE EXCEPTION 'Forbidden: active ops, compliance, or super_admin role required in app_admins'
      USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_admin_role
  FROM public.app_admins
  WHERE user_id = v_uid AND is_active = TRUE;

  IF p_status NOT IN ('active', 'suspended', 'locked', 'restricted') THEN
    RAISE EXCEPTION 'Invalid terminal status: %', p_status;
  END IF;

  IF v_clean_reason = '' THEN
    RAISE EXCEPTION 'Mandatory compliance audit reason is required';
  END IF;

  SELECT * INTO v_term
  FROM public.terminals
  WHERE id = p_terminal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Terminal not found';
  END IF;

  v_prev_status := v_term.status;

  UPDATE public.terminals
  SET status = p_status
  WHERE id = v_term.id;

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
  VALUES (
    'TERMINAL_STATUS_' || upper(p_status),
    v_uid::TEXT,
    v_term.id::TEXT,
    'Admin (' || COALESCE(v_admin_role, 'admin') || ') changed status ' || v_prev_status || ' -> ' || p_status || '. Reason: ' || v_clean_reason,
    CASE WHEN p_status = 'active' THEN 'info' ELSE 'warn' END,
    v_prev_hash,
    '0x' || encode(digest(v_prev_hash || v_term.id::TEXT || p_status || v_clean_reason || now()::TEXT, 'sha256'), 'hex')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 5. LOCK DOWN EXECUTE GRANTS
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.is_ntps_admin(TEXT[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_admin_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_withdrawal_request(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_terminal_status_admin(UUID, TEXT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.is_ntps_admin(TEXT[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_admin_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_withdrawal_request(UUID, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_terminal_status_admin(UUID, TEXT, TEXT) TO authenticated, service_role;

COMMIT;
