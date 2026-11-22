-- ============================================================================
-- Migration 009: Worker Destination Trust & TOCTOU Protection (W-01)
-- NOVA Terminal Payment System (NTPS)
--
-- Purpose:
--   Closes destination-trust & time-of-check/time-of-use (TOCTOU) gaps in
--   `whitelist_addresses` and `withdrawal_requests` cleanly after migrations
--   001 through 008 (preserving RBAC from 005, double-credit reversal locks &
--   policy claims from 006, chain address validation from 007, and worker
--   leases from 008):
--     1. Set `whitelist_addresses.verified` default to `FALSE` and enforce
--        `verified = FALSE` on non-admin/non-service_role inserts via both
--        `add_whitelist_address` and `trg_force_unverified_on_client_insert`.
--     2. Add `withdrawal_requests.destination_snapshot` and backfill active
--        pending/approved/broadcast rows.
--     3. Update `review_withdrawal_request` (preserving 005 RBAC + 006 SYS-9
--        reversal guards) to verify `whitelist_addresses.verified IS TRUE` and
--        atomically capture `destination_snapshot = v_wl.address` upon approve.
--     4. Update `claim_approved_withdrawal_for_broadcast` (preserving 006 W-04
--        policy & 24h limit enforcement) to also verify `verified IS TRUE` and
--        ensure `destination_snapshot` still matches `whitelist_addresses.address`.
--     5. Add `trg_guard_whitelist_address_mutation` preventing UPDATE/DELETE on
--        any whitelist row referenced by `review`/`approved`/`broadcast` requests.
--     6. Add admin RPC `verify_whitelist_address_admin(p_whitelist_address_id,
--        p_reason)` restricted to active `ops`, `compliance`, or `super_admin`
--        roles in `public.app_admins`.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. PRE-FLIGHT PREREQUISITE CHECKS
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.withdrawal_requests') IS NULL THEN
    RAISE EXCEPTION 'Migration 009 requires public.withdrawal_requests (apply schema.sql first)';
  END IF;
  IF to_regclass('public.whitelist_addresses') IS NULL THEN
    RAISE EXCEPTION 'Migration 009 requires public.whitelist_addresses (apply schema.sql first)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'withdrawal_requests'
      AND column_name = 'whitelist_address_id'
  ) THEN
    RAISE EXCEPTION 'Migration 009 requires withdrawal_requests.whitelist_address_id';
  END IF;
  IF to_regprocedure('public.is_ntps_admin(text[])') IS NULL THEN
    RAISE EXCEPTION 'Migration 009 requires public.is_ntps_admin (apply migration 005 first)';
  END IF;
  IF to_regprocedure('public.claim_approved_withdrawal_for_broadcast(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Migration 009 requires public.claim_approved_withdrawal_for_broadcast (apply migration 006 first)';
  END IF;
  IF to_regprocedure('public.is_valid_chain_address(text, text)') IS NULL THEN
    RAISE EXCEPTION 'Migration 009 requires public.is_valid_chain_address (apply migration 007 first)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. WHITELIST VERIFICATION DEFAULT & SNAPSHOT COLUMN
-- ----------------------------------------------------------------------------
ALTER TABLE public.whitelist_addresses
  ALTER COLUMN verified SET DEFAULT FALSE;

ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS destination_snapshot TEXT;

COMMENT ON COLUMN public.withdrawal_requests.destination_snapshot IS
  'W-01: Destination address captured atomically at admin approval time; worker and claim RPC reject mismatches (TOCTOU protection).';

-- Backfill any pre-existing active rows that lack a snapshot
UPDATE public.withdrawal_requests wr
SET destination_snapshot = wl.address
FROM public.whitelist_addresses wl
WHERE wr.whitelist_address_id = wl.id
  AND wr.destination_snapshot IS NULL
  AND wr.state IN ('review', 'approved', 'broadcast');

-- ----------------------------------------------------------------------------
-- 2. HARDENED `add_whitelist_address` (PRESERVES 007 SYS-8 + UNVERIFIED DEFAULT)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_whitelist_address(
  p_terminal_id UUID,
  p_label TEXT,
  p_asset TEXT,
  p_network TEXT,
  p_address TEXT
) RETURNS UUID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_jwt_role TEXT := COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '');
  v_term public.terminals%ROWTYPE;
  v_clean_label TEXT := trim(COALESCE(p_label, ''));
  v_clean_asset TEXT := upper(trim(COALESCE(p_asset, '')));
  v_clean_net TEXT := upper(trim(COALESCE(p_network, '')));
  v_clean_addr TEXT := trim(COALESCE(p_address, ''));
  v_is_privileged BOOLEAN := FALSE;
  v_wl_id UUID;
  v_prev_hash TEXT;
BEGIN
  IF v_uid IS NULL AND v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF length(v_clean_label) < 2 THEN
    RAISE EXCEPTION 'Whitelist label is required';
  END IF;

  IF v_clean_asset NOT IN ('USDT', 'BTC', 'ETH') THEN
    RAISE EXCEPTION 'Unsupported asset: %', p_asset;
  END IF;

  IF v_clean_net NOT IN ('TRC20', 'ERC20', 'BTC', 'ETH', 'ARBITRUM') THEN
    RAISE EXCEPTION 'Unsupported network: %', p_network;
  END IF;

  IF NOT (
    (v_clean_asset = 'USDT' AND v_clean_net IN ('TRC20', 'ERC20'))
    OR (v_clean_asset = 'BTC' AND v_clean_net = 'BTC')
    OR (v_clean_asset = 'ETH' AND v_clean_net IN ('ETH', 'ARBITRUM'))
  ) THEN
    RAISE EXCEPTION 'Asset % is incompatible with network %', v_clean_asset, v_clean_net;
  END IF;

  IF NOT public.is_valid_chain_address(v_clean_net, v_clean_addr) THEN
    RAISE EXCEPTION 'Invalid % destination address format', v_clean_net;
  END IF;

  SELECT * INTO v_term
  FROM public.terminals
  WHERE id = p_terminal_id
    AND (v_jwt_role = 'service_role' OR owner_user_id = v_uid)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Terminal not found or unauthorized';
  END IF;

  v_is_privileged := (v_jwt_role = 'service_role')
    OR public.is_ntps_admin(ARRAY['ops', 'compliance', 'super_admin']);

  INSERT INTO public.whitelist_addresses (
    terminal_id, label, asset, network, address, verified
  ) VALUES (
    v_term.id, v_clean_label, v_clean_asset, v_clean_net, v_clean_addr, v_is_privileged
  )
  RETURNING id INTO v_wl_id;

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC, id DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
  VALUES (
    'WHITELIST_ADDRESS_ADDED',
    COALESCE(v_uid::TEXT, 'service_role'),
    v_term.id::TEXT,
    'Added ' || v_clean_asset || ' (' || v_clean_net || ') destination "' || v_clean_label || '" -> ' || v_clean_addr || ' [verified=' || v_is_privileged::TEXT || ']',
    'info',
    v_prev_hash,
    '0x' || encode(sha256(convert_to(v_prev_hash || v_wl_id::TEXT || v_clean_addr || now()::TEXT, 'UTF8')), 'hex')
  );

  RETURN v_wl_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 3. `review_withdrawal_request`: PRESERVES 005 RBAC + 006 SYS-9 + ADDS W-01
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.review_withdrawal_request(UUID, TEXT, TEXT);

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
  v_wl public.whitelist_addresses%ROWTYPE;
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

    -- W-01: Lock whitelist row and require explicit verified = TRUE before approval
    SELECT * INTO v_wl
    FROM public.whitelist_addresses
    WHERE id = v_req.whitelist_address_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Whitelist destination for this withdrawal no longer exists';
    END IF;

    IF v_wl.verified IS NOT TRUE THEN
      RAISE EXCEPTION
        'Destination % is not verified; an admin must verify it before approval',
        v_wl.address
        USING ERRCODE = '42501';
    END IF;

    -- W-01: Atomically freeze destination snapshot at approval time
    UPDATE public.withdrawal_requests
    SET state = 'approved',
        destination_snapshot = v_wl.address
    WHERE id = v_req.id;
  ELSE
    -- SYS-9: Block double-credit reversals once broadcast or confirmed on-chain
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
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC, id DESC LIMIT 1),
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
    '0x' || encode(sha256(convert_to(v_prev_hash || v_tx.id::TEXT || p_action || v_clean_reason || now()::TEXT, 'UTF8')), 'hex')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 4. `claim_approved_withdrawal_for_broadcast`: PRESERVES 006 W-04 + ADDS W-01
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_approved_withdrawal_for_broadcast(
  p_request_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '');
  v_req public.withdrawal_requests%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
  v_wl public.whitelist_addresses%ROWTYPE;
  v_term public.terminals%ROWTYPE;
  v_usd_rate NUMERIC;
  v_usd_amount NUMERIC;
  v_daily_used_usd NUMERIC := 0;
BEGIN
  IF v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'Forbidden: claim_approved_withdrawal_for_broadcast requires service_role'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_req
  FROM public.withdrawal_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND OR v_req.state <> 'approved' THEN
    RETURN FALSE;
  END IF;

  IF v_req.tx_hash_candidate IS NOT NULL OR v_req.broadcast_at IS NOT NULL THEN
    RAISE EXCEPTION 'Withdrawal request % already has broadcast or tx_hash_candidate evidence; manual reconciliation required', p_request_id
      USING ERRCODE = '40001';
  END IF;

  SELECT * INTO v_tx
  FROM public.transactions
  WHERE id = v_req.transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Associated transaction row not found for withdrawal request %', p_request_id;
  END IF;

  IF v_tx.status = 'completed' OR v_tx.tx_hash IS NOT NULL THEN
    RAISE EXCEPTION 'Transaction % already completed or has on-chain tx_hash; manual reconciliation required', v_tx.reference
      USING ERRCODE = '40001';
  END IF;

  -- W-01: Re-verify destination trust and TOCTOU snapshot under lock prior to claim
  SELECT * INTO v_wl
  FROM public.whitelist_addresses
  WHERE id = v_req.whitelist_address_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Whitelist destination row missing for withdrawal request %', p_request_id
      USING ERRCODE = '42501';
  END IF;

  IF v_wl.verified IS NOT TRUE THEN
    RAISE EXCEPTION 'Whitelist destination % is not explicitly verified; refusing broadcast claim', v_wl.address
      USING ERRCODE = '42501';
  END IF;

  IF NULLIF(trim(COALESCE(v_req.destination_snapshot, '')), '') IS NOT NULL
     AND trim(v_req.destination_snapshot) <> trim(v_wl.address) THEN
    RAISE EXCEPTION 'Destination address changed after approval (snapshot=%, current=%)',
      trim(v_req.destination_snapshot), trim(v_wl.address)
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_term
  FROM public.terminals
  WHERE id = v_tx.terminal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Originating terminal not found for withdrawal %', v_tx.reference;
  END IF;

  IF v_term.status <> 'active' THEN
    RAISE EXCEPTION 'Terminal % is % (must be active to broadcast)', v_term.terminal_id, v_term.status
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT (v_tx.asset = ANY(v_term.allowed_assets)) THEN
    RAISE EXCEPTION 'Asset % is not allowed by terminal % policy', v_tx.asset, v_term.terminal_id
      USING ERRCODE = 'P0001';
  END IF;

  v_usd_rate := public.get_asset_usd_rate(v_tx.asset);
  v_usd_amount := v_tx.amount * v_usd_rate;

  IF v_usd_amount > v_term.per_tx_limit_usd THEN
    RAISE EXCEPTION 'Withdrawal ($%) exceeds terminal % per-transaction limit ($%)',
      round(v_usd_amount, 2), v_term.terminal_id, round(v_term.per_tx_limit_usd, 2)
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(t.amount * public.get_asset_usd_rate(t.asset)), 0)
  INTO v_daily_used_usd
  FROM public.transactions t
  WHERE t.terminal_id = v_term.id
    AND t.type = 'withdrawal'
    AND t.status NOT IN ('reversed', 'failed')
    AND t.id <> v_tx.id
    AND t.created_at >= now() - interval '24 hours';

  IF v_daily_used_usd + v_usd_amount > v_term.daily_limit_usd THEN
    RAISE EXCEPTION 'Withdrawal ($%) exceeds 24h daily limit for terminal % (used $% / cap $%)',
      round(v_usd_amount, 2), v_term.terminal_id, round(v_daily_used_usd, 2), round(v_term.daily_limit_usd, 2)
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.withdrawal_requests
  SET state = 'broadcast',
      broadcast_at = now()
  WHERE id = v_req.id
    AND state = 'approved';

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 5. TRIGGERS: MUTATION GUARD (TOCTOU) & UNVERIFIED CLIENT INSERT GUARD
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_whitelist_address_mutation()
RETURNS TRIGGER AS $$
DECLARE
  v_pending_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT COUNT(*) INTO v_pending_count
    FROM public.withdrawal_requests
    WHERE whitelist_address_id = OLD.id
      AND state IN ('review', 'approved', 'broadcast');

    IF v_pending_count > 0 THEN
      RAISE EXCEPTION
        'Cannot delete whitelist address %: % pending withdrawal request(s) reference it',
        OLD.id, v_pending_count
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.address IS DISTINCT FROM OLD.address
     OR NEW.network IS DISTINCT FROM OLD.network
     OR NEW.asset IS DISTINCT FROM OLD.asset THEN
    SELECT COUNT(*) INTO v_pending_count
    FROM public.withdrawal_requests
    WHERE whitelist_address_id = OLD.id
      AND state IN ('review', 'approved', 'broadcast');

    IF v_pending_count > 0 THEN
      RAISE EXCEPTION
        'Cannot change destination of whitelist address %: % pending withdrawal request(s) reference it. Reject or complete them first.',
        OLD.id, v_pending_count
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_guard_whitelist_address_mutation ON public.whitelist_addresses;
CREATE TRIGGER trg_guard_whitelist_address_mutation
  BEFORE UPDATE OR DELETE ON public.whitelist_addresses
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_whitelist_address_mutation();

CREATE OR REPLACE FUNCTION public.force_unverified_on_client_insert()
RETURNS TRIGGER AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '');
BEGIN
  -- Only service_role (or direct superuser/SQL migration scripts outside PostgREST JWTs)
  -- or active admins may insert with verified = TRUE.
  IF v_jwt_role <> 'service_role'
     AND NOT (v_jwt_role = '' AND current_user IN ('postgres', 'supabase_admin'))
     AND NOT public.is_ntps_admin(ARRAY['ops', 'compliance', 'super_admin']) THEN
    NEW.verified := FALSE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_force_unverified_on_client_insert ON public.whitelist_addresses;
CREATE TRIGGER trg_force_unverified_on_client_insert
  BEFORE INSERT ON public.whitelist_addresses
  FOR EACH ROW
  EXECUTE FUNCTION public.force_unverified_on_client_insert();

-- ----------------------------------------------------------------------------
-- 6. ADMIN RPC: EXPLICIT WHITELIST ADDRESS VERIFICATION
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_whitelist_address_admin(
  p_whitelist_address_id UUID,
  p_reason TEXT
) RETURNS VOID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_admin_role TEXT;
  v_clean_reason TEXT := trim(COALESCE(p_reason, ''));
  v_wl public.whitelist_addresses%ROWTYPE;
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
    RAISE EXCEPTION 'Mandatory verification reason is required';
  END IF;

  SELECT * INTO v_wl
  FROM public.whitelist_addresses
  WHERE id = p_whitelist_address_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Whitelist address not found';
  END IF;

  IF v_wl.verified IS TRUE THEN
    RETURN;
  END IF;

  UPDATE public.whitelist_addresses
  SET verified = TRUE
  WHERE id = v_wl.id;

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC, id DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
  VALUES (
    'WHITELIST_ADDRESS_VERIFIED',
    v_uid::TEXT,
    v_wl.terminal_id::TEXT,
    'Destination ' || v_wl.address || ' (' || v_wl.asset || '/' || v_wl.network || ') verified by ' || COALESCE(v_admin_role, 'admin') || '. Reason: ' || v_clean_reason,
    'info',
    v_prev_hash,
    '0x' || encode(sha256(convert_to(v_prev_hash || v_wl.id::TEXT || v_wl.address || now()::TEXT, 'UTF8')), 'hex')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 7. PRIVILEGE LOCKS & SUPPORTING INDEXES
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.add_whitelist_address(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_whitelist_address(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.review_withdrawal_request(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_withdrawal_request(UUID, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.claim_approved_withdrawal_for_broadcast(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_approved_withdrawal_for_broadcast(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.verify_whitelist_address_admin(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_whitelist_address_admin(UUID, TEXT) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_state_broadcast_at
  ON public.withdrawal_requests(state, broadcast_at)
  WHERE state = 'broadcast';

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_whitelist_pending
  ON public.withdrawal_requests(whitelist_address_id)
  WHERE state IN ('review', 'approved', 'broadcast');

COMMIT;
