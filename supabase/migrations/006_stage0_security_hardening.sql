-- ============================================================================
-- Migration 006: Stage-0 Launch Blocker Security Hardening
-- NOVA Terminal Payment System (NTPS)
--
-- Purpose:
--   Closes database-layer Stage-0 launch blockers cleanly for live upgrades
--   after migrations 001 through 005:
--     - SYS-1: Restrict withdrawal `p_auto_approve` strictly to `service_role`
--              or active ops/compliance/super_admin admins (< $25,000); all
--              regular authenticated requests always enter `'review'`.
--     - SYS-2: Lock Master Terminal row (`FOR UPDATE`) and validate positive
--              non-zero limits, `per_tx <= daily`, `daily <= master cap`,
--              non-empty label, and valid non-empty `allowed_assets` in
--              `provision_sub_terminal_atomic`.
--     - SYS-4: Enforce `service_role` caller identity inside
--              `credit_crypto_deposit`, add `pg_advisory_xact_lock`, dedup on
--              both `journal_entries` & `transactions.tx_hash`, and verify
--              wallet belongs to `p_terminal_id` with matching `asset`.
--     - SYS-9: Enforce idempotent reversal guards in `review_withdrawal_request`
--              so broadcast/completed/on-chain-hashed withdrawals cannot be
--              rejected and double-credited; requires manual reconciliation.
--     - W-04 : Add atomic `claim_approved_withdrawal_for_broadcast` RPC for
--              `ntps-tron-worker` that locks the request, transaction, and
--              terminal rows, re-verifies `terminal.status = 'active'`,
--              `allowed_assets`, `per_tx_limit_usd`, and 24h `daily_limit_usd`
--              before claiming `'approved' -> 'broadcast'`.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. SYS-4: HARDENED `credit_crypto_deposit` (SERVICE ROLE + OWNERSHIP LOCKS)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.credit_crypto_deposit(
  p_terminal_id UUID,
  p_wallet_id UUID,
  p_asset TEXT,
  p_network TEXT,
  p_amount NUMERIC,
  p_tx_hash TEXT
) RETURNS VOID AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '');
  v_clean_hash TEXT := trim(COALESCE(p_tx_hash, ''));
  v_term public.terminals%ROWTYPE;
  v_wallet public.wallets%ROWTYPE;
  v_journal_id UUID;
  v_ref TEXT;
BEGIN
  IF v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'Forbidden: credit_crypto_deposit requires service_role'
      USING ERRCODE = '42501';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Deposit amount must be positive';
  END IF;

  IF p_asset NOT IN ('USDT', 'BTC', 'ETH') THEN
    RAISE EXCEPTION 'Unsupported deposit asset: %', p_asset;
  END IF;

  IF p_network NOT IN ('TRC20', 'ERC20', 'BTC', 'ETH', 'ARBITRUM') THEN
    RAISE EXCEPTION 'Unsupported deposit network: %', p_network;
  END IF;

  IF v_clean_hash = '' THEN
    RAISE EXCEPTION 'On-chain transaction hash is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('dep_' || v_clean_hash));

  IF EXISTS (
    SELECT 1 FROM public.journal_entries WHERE idempotency_key = 'dep_' || v_clean_hash
  ) OR EXISTS (
    SELECT 1 FROM public.transactions WHERE tx_hash = v_clean_hash
  ) THEN
    RETURN;
  END IF;

  SELECT * INTO v_term
  FROM public.terminals
  WHERE id = p_terminal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target terminal % not found', p_terminal_id;
  END IF;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE id = p_wallet_id
    AND terminal_id = p_terminal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target wallet % does not belong to terminal %', p_wallet_id, p_terminal_id;
  END IF;

  IF v_wallet.asset <> p_asset THEN
    RAISE EXCEPTION 'Wallet asset (%) does not match deposit asset (%)', v_wallet.asset, p_asset;
  END IF;

  INSERT INTO public.journal_entries (kind, idempotency_key, memo)
  VALUES ('deposit', 'dep_' || v_clean_hash, 'Confirmed on-chain deposit (' || p_network || ')')
  RETURNING id INTO v_journal_id;

  INSERT INTO public.ledger_postings (journal_id, account_ref, asset, amount)
  VALUES
    (v_journal_id, 'system:hot_' || lower(p_asset) || '_' || lower(p_network), p_asset, -p_amount),
    (v_journal_id, 'wallet:' || v_wallet.id::TEXT, p_asset, p_amount);

  UPDATE public.wallets
  SET available = available + p_amount,
      version = version + 1,
      updated_at = now()
  WHERE id = v_wallet.id
    AND terminal_id = p_terminal_id;

  v_ref := 'NTX-' || to_char(now(), 'YYYY-MM-DD') || '-' || substr(md5(v_clean_hash), 1, 6);

  INSERT INTO public.transactions (
    reference, terminal_id, counterparty_terminal, type, asset, network, amount, fee, status, tx_hash, journal_id, memo
  ) VALUES (
    v_ref, p_terminal_id, 'onchain:' || p_network, 'deposit', p_asset, p_network, p_amount, 0, 'completed', v_clean_hash, v_journal_id, 'Confirmed on-chain deposit'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 2. SYS-2: VALIDATED SUB-TERMINAL PROVISIONING (`FOR UPDATE` MASTER LOCK)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provision_sub_terminal_atomic(
  p_terminal_code TEXT,
  p_label TEXT,
  p_daily_limit NUMERIC,
  p_per_tx_limit NUMERIC,
  p_allowed_assets TEXT[]
) RETURNS UUID AS $$
DECLARE
  v_uid UUID := auth.uid();
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

  IF p_daily_limit > v_master.daily_limit_usd THEN
    RAISE EXCEPTION 'Sub-terminal daily limit ($%) cannot exceed Master Terminal cap ($%)',
      p_daily_limit, v_master.daily_limit_usd;
  END IF;

  INSERT INTO public.terminals (
    terminal_id, type, parent_id, owner_user_id, label, tier, status, daily_limit_usd, per_tx_limit_usd, allowed_assets
  ) VALUES (
    p_terminal_code, 'sub', v_master.id, v_uid, v_clean_label, 'Desk', 'active', p_daily_limit, p_per_tx_limit, p_allowed_assets
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
    'Provisioned sub-terminal ' || p_terminal_code || ' (' || v_clean_label || ')',
    'info',
    v_prev_hash,
    '0x' || encode(digest(v_prev_hash || v_sub_id::TEXT || now()::TEXT, 'sha256'), 'hex')
  );

  RETURN v_sub_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 3. SYS-1: FOUR-EYES `request_crypto_withdrawal` (PRIVILEGED AUTO-APPROVE ONLY)
-- ----------------------------------------------------------------------------
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

  -- Four-eyes enforcement: non-privileged users always queue in 'review', and >= $25k always enters 'review'
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
    '0x' || encode(digest(v_prev_hash || v_tx_id::TEXT || now()::TEXT, 'sha256'), 'hex')
  );

  RETURN v_tx_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 4. SYS-9: ENSURE `review_withdrawal_request` BLOCKS DOUBLE-CREDIT REVERSALS
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 5. W-04: ATOMIC WORKER BROADCAST CLAIM WITH POLICY & LIMIT RE-ENFORCEMENT
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_approved_withdrawal_for_broadcast(
  p_request_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '');
  v_req public.withdrawal_requests%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
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
-- 6. PRIVILEGE LOCKS
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.credit_crypto_deposit(UUID, UUID, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_crypto_deposit(UUID, UUID, TEXT, TEXT, NUMERIC, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.provision_sub_terminal_atomic(TEXT, TEXT, NUMERIC, NUMERIC, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.provision_sub_terminal_atomic(TEXT, TEXT, NUMERIC, NUMERIC, TEXT[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.request_crypto_withdrawal(UUID, TEXT, TEXT, UUID, NUMERIC, NUMERIC, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_crypto_withdrawal(UUID, TEXT, TEXT, UUID, NUMERIC, NUMERIC, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.review_withdrawal_request(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_withdrawal_request(UUID, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.claim_approved_withdrawal_for_broadcast(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_approved_withdrawal_for_broadcast(UUID) TO service_role;

COMMIT;
