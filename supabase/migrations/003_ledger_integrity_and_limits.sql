-- ============================================================================
-- Migration 003: Database-Level Double-Entry Integrity, Immutability,
--                Server-Side Limits & External Asset Rates
-- NOVA Terminal Payment System (NTPS)
--
-- Purpose:
--   Phase 2.1:
--     1. Enforce non-negative CHECK constraints on `wallets` (available, pending, locked).
--     2. Make `ledger_postings` & `journal_entries` strictly append-only at DB level
--        (block UPDATE / DELETE even for elevated roles via BEFORE triggers).
--     3. Enforce double-entry zero-sum invariant (`SUM(amount) = 0` and >= 2 legs
--        per `(journal_id, asset)`) via DEFERRABLE INITIALLY DEFERRED CONSTRAINT TRIGGER.
--     4. Harden `verify_ledger_invariant()` to check both zero-sum and >= 2 legs.
--   Phase 2.2:
--     5. Create `public.asset_rates` table (with CoinGecko refresh RPC for service_role)
--        and expose read-only SELECT access + Realtime publication.
--     6. Enforce terminal `allowed_assets`, `per_tx_limit_usd`, and 24h `daily_limit_usd`
--        inside server-side Postgres RPCs using `public.asset_rates`.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS ntps_internal;
REVOKE ALL ON SCHEMA ntps_internal FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA ntps_internal TO service_role;

-- ----------------------------------------------------------------------------
-- 1. NON-NEGATIVE WALLET CONSTRAINTS (Idempotent Guard)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.wallets'::regclass
      AND conname = 'wallets_available_non_negative'
  ) THEN
    -- Ensure existing inline checks or missing checks are explicitly named & enforced
    ALTER TABLE public.wallets
      ADD CONSTRAINT wallets_available_non_negative CHECK (available >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.wallets'::regclass
      AND conname = 'wallets_pending_non_negative'
  ) THEN
    ALTER TABLE public.wallets
      ADD CONSTRAINT wallets_pending_non_negative CHECK (pending >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.wallets'::regclass
      AND conname = 'wallets_locked_non_negative'
  ) THEN
    ALTER TABLE public.wallets
      ADD CONSTRAINT wallets_locked_non_negative CHECK (locked >= 0);
  END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. APPEND-ONLY PROTECTION ON LEDGER POSTINGS & JOURNAL ENTRIES
-- ----------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
  public.ledger_postings,
  public.journal_entries
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION ntps_internal.prevent_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Table % is strictly append-only; % operations are prohibited (record reversal journals instead).',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_ledger_postings_append_only ON public.ledger_postings;
CREATE TRIGGER trg_ledger_postings_append_only
  BEFORE UPDATE OR DELETE ON public.ledger_postings
  FOR EACH ROW
  EXECUTE FUNCTION ntps_internal.prevent_ledger_mutation();

DROP TRIGGER IF EXISTS trg_journal_entries_append_only ON public.journal_entries;
CREATE TRIGGER trg_journal_entries_append_only
  BEFORE UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION ntps_internal.prevent_ledger_mutation();

-- ----------------------------------------------------------------------------
-- 3. DEFERRED ZERO-SUM DOUBLE-ENTRY CONSTRAINT TRIGGER
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ntps_internal.enforce_journal_zero_sum()
RETURNS TRIGGER AS $$
DECLARE
  v_posting_count BIGINT;
  v_net_sum NUMERIC;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(amount), 0)
  INTO v_posting_count, v_net_sum
  FROM public.ledger_postings
  WHERE journal_id = NEW.journal_id
    AND asset = NEW.asset;

  IF v_posting_count < 2 THEN
    RAISE EXCEPTION 'Double-entry invariant failed for journal % (%): only % posting(s) recorded; minimum 2 required.',
      NEW.journal_id, NEW.asset, v_posting_count
      USING ERRCODE = '23514';
  END IF;

  IF ABS(v_net_sum) > 0.00000001 THEN
    RAISE EXCEPTION 'Double-entry invariant failed for journal % (%): SUM(amount) = %, expected 0.',
      NEW.journal_id, NEW.asset, v_net_sum
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_ledger_postings_zero_sum ON public.ledger_postings;
CREATE CONSTRAINT TRIGGER trg_ledger_postings_zero_sum
  AFTER INSERT ON public.ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION ntps_internal.enforce_journal_zero_sum();

-- ----------------------------------------------------------------------------
-- 4. HARDENED LEDGER INVARIANT VERIFICATION RPC
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_ledger_invariant()
RETURNS TABLE(
  journal_count BIGINT,
  posting_count BIGINT,
  imbalanced_count BIGINT,
  is_balanced BOOLEAN
) AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT := current_setting('request.jwt.claim.role', true);
BEGIN
  IF v_uid IS NULL AND COALESCE(v_role, '') <> 'service_role' THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  RETURN QUERY
  WITH user_journals AS (
    SELECT DISTINCT lp.journal_id
    FROM public.ledger_postings lp
    WHERE (
      COALESCE(v_role, '') = 'service_role'
      OR EXISTS (
        SELECT 1 FROM public.transactions tx
        JOIN public.terminals t ON t.id = tx.terminal_id
        WHERE tx.journal_id = lp.journal_id AND t.owner_user_id = v_uid
      )
      OR EXISTS (
        SELECT 1 FROM public.wallets w
        JOIN public.terminals t ON t.id = w.terminal_id
        WHERE lp.account_ref = ('wallet:' || w.id::TEXT) AND t.owner_user_id = v_uid
      )
    )
  ),
  scoped_postings AS (
    SELECT lp.*
    FROM public.ledger_postings lp
    JOIN user_journals uj ON uj.journal_id = lp.journal_id
  ),
  grouped AS (
    SELECT
      sp.journal_id,
      sp.asset,
      COUNT(*) AS leg_count,
      SUM(sp.amount) AS net_amount
    FROM scoped_postings sp
    GROUP BY sp.journal_id, sp.asset
  ),
  violations AS (
    SELECT 1
    FROM grouped g
    WHERE ABS(g.net_amount) > 0.00000001
       OR g.leg_count < 2
  )
  SELECT
    (SELECT COUNT(*) FROM grouped)::BIGINT AS journal_count,
    (SELECT COUNT(*) FROM scoped_postings)::BIGINT AS posting_count,
    (SELECT COUNT(*) FROM violations)::BIGINT AS imbalanced_count,
    ((SELECT COUNT(*) FROM violations) = 0) AS is_balanced;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 5. EXTERNAL ASSET USD RATES TABLE + REFRESH RPC
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.asset_rates (
  asset TEXT PRIMARY KEY CHECK (asset IN ('USDT', 'BTC', 'ETH')),
  usd_rate NUMERIC(20, 8) NOT NULL CHECK (usd_rate > 0),
  change_24h_pct NUMERIC(10, 4) NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'seed',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.asset_rates (asset, usd_rate, change_24h_pct, source)
VALUES
  ('USDT', 1.00000000, 0.0000, 'seed'),
  ('BTC', 91420.00000000, 0.0000, 'seed'),
  ('ETH', 3285.00000000, 0.0000, 'seed')
ON CONFLICT (asset) DO NOTHING;

ALTER TABLE public.asset_rates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.asset_rates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.asset_rates TO anon, authenticated;
GRANT ALL ON TABLE public.asset_rates TO service_role;

DROP POLICY IF EXISTS "asset_rates_select_all" ON public.asset_rates;
CREATE POLICY "asset_rates_select_all"
  ON public.asset_rates FOR SELECT
  TO anon, authenticated
  USING (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'asset_rates'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.asset_rates;
    END IF;
  END IF;
END;
$$;

-- Helper to resolve current server-side USD valuation rate
CREATE OR REPLACE FUNCTION public.get_asset_usd_rate(p_asset TEXT)
RETURNS NUMERIC AS $$
DECLARE
  v_rate NUMERIC;
BEGIN
  SELECT usd_rate INTO v_rate
  FROM public.asset_rates
  WHERE asset = p_asset;

  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE EXCEPTION 'Missing valid USD reference rate for asset %', p_asset;
  END IF;

  RETURN v_rate;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Service-role RPC called by Edge Function / cron rate updater
CREATE OR REPLACE FUNCTION public.refresh_asset_rates(
  p_btc_usd NUMERIC,
  p_eth_usd NUMERIC,
  p_usdt_usd NUMERIC DEFAULT 1.0,
  p_source TEXT DEFAULT 'coingecko',
  p_btc_change_24h NUMERIC DEFAULT 0,
  p_eth_change_24h NUMERIC DEFAULT 0,
  p_usdt_change_24h NUMERIC DEFAULT 0
) RETURNS JSONB AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_source TEXT := COALESCE(NULLIF(trim(p_source), ''), 'coingecko');
BEGIN
  IF p_btc_usd IS NULL OR p_btc_usd <= 0
     OR p_eth_usd IS NULL OR p_eth_usd <= 0
     OR p_usdt_usd IS NULL OR p_usdt_usd <= 0 THEN
    RAISE EXCEPTION 'All asset USD rates must be strictly positive';
  END IF;

  INSERT INTO public.asset_rates (asset, usd_rate, change_24h_pct, source, fetched_at, updated_at)
  VALUES
    ('USDT', p_usdt_usd, COALESCE(p_usdt_change_24h, 0), v_source, v_now, v_now),
    ('BTC', p_btc_usd, COALESCE(p_btc_change_24h, 0), v_source, v_now, v_now),
    ('ETH', p_eth_usd, COALESCE(p_eth_change_24h, 0), v_source, v_now, v_now)
  ON CONFLICT (asset) DO UPDATE
  SET usd_rate = EXCLUDED.usd_rate,
      change_24h_pct = EXCLUDED.change_24h_pct,
      source = EXCLUDED.source,
      fetched_at = EXCLUDED.fetched_at,
      updated_at = EXCLUDED.updated_at;

  RETURN jsonb_build_object(
    'ok', true,
    'source', v_source,
    'fetched_at', v_now,
    'rates', jsonb_build_object('USDT', p_usdt_usd, 'BTC', p_btc_usd, 'ETH', p_eth_usd)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 6. SERVER-SIDE LIMIT ENFORCEMENT IN MONEY-MOVING RPCs
-- ----------------------------------------------------------------------------

-- 6A. Execute Internal Transfer (Enforces allowed_assets, per_tx_limit_usd & daily_limit_usd)
CREATE OR REPLACE FUNCTION public.execute_internal_transfer(
  p_source_terminal_id UUID,
  p_recipient_terminal_code TEXT,
  p_asset TEXT,
  p_amount NUMERIC,
  p_memo TEXT,
  p_idempotency_key TEXT,
  p_kind TEXT DEFAULT 'internal_transfer'
) RETURNS UUID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_source public.terminals%ROWTYPE;
  v_recipient public.terminals%ROWTYPE;
  v_existing_tx_id UUID;
  v_usd_rate NUMERIC;
  v_usd_amount NUMERIC;
  v_daily_outflow_usd NUMERIC := 0;
  v_total_avail NUMERIC := 0;
  v_remaining NUMERIC;
  v_take NUMERIC;
  v_wallet RECORD;
  v_rec_wallet_id UUID;
  v_journal_id UUID;
  v_tx_id UUID;
  v_ref TEXT;
  v_tx_hash TEXT;
  v_credit_ref TEXT;
  v_kind TEXT;
  v_default_net TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Transfer amount must be positive';
  END IF;

  SELECT tx.id INTO v_existing_tx_id
  FROM public.journal_entries je
  JOIN public.transactions tx ON tx.journal_id = je.id
  WHERE je.idempotency_key = p_idempotency_key
  LIMIT 1;

  IF v_existing_tx_id IS NOT NULL THEN
    RETURN v_existing_tx_id;
  END IF;

  SELECT * INTO v_source
  FROM public.terminals
  WHERE id = p_source_terminal_id AND owner_user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source terminal not found or unauthorized';
  END IF;

  IF v_source.status IN ('suspended', 'locked') THEN
    RAISE EXCEPTION 'Source terminal is currently %', v_source.status;
  END IF;

  IF v_source.terminal_id = p_recipient_terminal_code THEN
    RAISE EXCEPTION 'Source and recipient Terminal IDs cannot be identical';
  END IF;

  IF NOT (p_asset = ANY(v_source.allowed_assets)) THEN
    RAISE EXCEPTION 'Asset % is restricted by terminal % policy', p_asset, v_source.terminal_id;
  END IF;

  v_usd_rate := public.get_asset_usd_rate(p_asset);
  v_usd_amount := p_amount * v_usd_rate;

  IF v_usd_amount > v_source.per_tx_limit_usd THEN
    RAISE EXCEPTION 'Transfer value ($%) exceeds terminal per-transaction limit ($%)',
      round(v_usd_amount, 2), round(v_source.per_tx_limit_usd, 2);
  END IF;

  SELECT COALESCE(SUM(tx.amount * public.get_asset_usd_rate(tx.asset)), 0)
  INTO v_daily_outflow_usd
  FROM public.transactions tx
  WHERE tx.terminal_id = v_source.id
    AND tx.type IN ('withdrawal', 'internal_transfer', 'sub_allocation', 'invoice_payment')
    AND tx.status NOT IN ('reversed', 'failed')
    AND tx.created_at >= now() - interval '24 hours';

  IF v_daily_outflow_usd + v_usd_amount > v_source.daily_limit_usd THEN
    RAISE EXCEPTION 'Transfer ($%) exceeds remaining 24h terminal daily limit (used $% / cap $%)',
      round(v_usd_amount, 2), round(v_daily_outflow_usd, 2), round(v_source.daily_limit_usd, 2);
  END IF;

  FOR v_wallet IN
    SELECT * FROM public.wallets
    WHERE terminal_id = v_source.id AND asset = p_asset
    ORDER BY available DESC, id ASC
    FOR UPDATE
  LOOP
    v_total_avail := v_total_avail + v_wallet.available;
  END LOOP;

  IF v_total_avail < p_amount THEN
    RAISE EXCEPTION 'Insufficient available % balance', p_asset;
  END IF;

  SELECT * INTO v_recipient
  FROM public.terminals
  WHERE terminal_id = p_recipient_terminal_code
  LIMIT 1;

  v_kind := COALESCE(
    NULLIF(p_kind, ''),
    CASE WHEN v_recipient.id IS NOT NULL AND v_recipient.type = 'sub' THEN 'sub_allocation' ELSE 'internal_transfer' END
  );

  v_ref := 'NTPS-' || to_char(now(), 'YYMMDD') || '-' || substr(md5(p_idempotency_key || clock_timestamp()::TEXT), 1, 4);
  v_tx_hash := '0x' || encode(digest(p_idempotency_key || v_source.id::TEXT || now()::TEXT, 'sha256'), 'hex');

  INSERT INTO public.journal_entries (kind, idempotency_key, memo, created_by)
  VALUES (v_kind, p_idempotency_key, COALESCE(NULLIF(trim(p_memo), ''), 'NTPS instant settlement'), v_uid)
  RETURNING id INTO v_journal_id;

  v_remaining := p_amount;

  FOR v_wallet IN
    SELECT * FROM public.wallets
    WHERE terminal_id = v_source.id AND asset = p_asset AND available > 0
    ORDER BY available DESC, id ASC
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

  IF v_recipient.id IS NOT NULL THEN
    SELECT id INTO v_rec_wallet_id
    FROM public.wallets
    WHERE terminal_id = v_recipient.id AND asset = p_asset
    ORDER BY id ASC
    LIMIT 1
    FOR UPDATE;

    IF v_rec_wallet_id IS NULL THEN
      v_default_net := CASE p_asset WHEN 'USDT' THEN 'TRC20' WHEN 'BTC' THEN 'BTC' ELSE 'ETH' END;
      INSERT INTO public.wallets (terminal_id, asset, network, available)
      VALUES (v_recipient.id, p_asset, v_default_net, p_amount)
      RETURNING id INTO v_rec_wallet_id;
    ELSE
      UPDATE public.wallets
      SET available = available + p_amount,
          version = version + 1,
          updated_at = now()
      WHERE id = v_rec_wallet_id;
    END IF;

    v_credit_ref := 'wallet:' || v_rec_wallet_id::TEXT;
  ELSE
    v_credit_ref := 'counterparty:' || p_recipient_terminal_code;
  END IF;

  INSERT INTO public.ledger_postings (journal_id, account_ref, asset, amount)
  VALUES (v_journal_id, v_credit_ref, p_asset, p_amount);

  INSERT INTO public.transactions (
    reference, terminal_id, counterparty_terminal, type, asset, network, amount, fee, status, tx_hash, journal_id, memo
  ) VALUES (
    upper(v_ref), v_source.id, p_recipient_terminal_code, v_kind, p_asset, 'NTPS_INTERNAL', p_amount, 0, 'completed', v_tx_hash, v_journal_id, p_memo
  )
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 6B. Request Crypto Withdrawal (Enforces allowed_assets, per_tx_limit_usd & 24h daily_limit_usd server-side)
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
  IF v_uid IS NULL THEN
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
  WHERE id = p_terminal_id AND owner_user_id = v_uid
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

  -- Four-eyes security: regular authenticated users cannot self-approve, and >= $25,000 always enters review
  v_req_state := CASE
    WHEN COALESCE(p_auto_approve, FALSE)
      AND v_jwt_role = 'service_role'
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
    v_uid::TEXT,
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

-- 6C. Trading Bridge Transfer (Enforces active terminal status, allowed_assets, & per_tx_limit_usd)
CREATE OR REPLACE FUNCTION public.transfer_trading_bridge(
  p_terminal_id UUID,
  p_trading_account_id UUID,
  p_amount NUMERIC,
  p_direction TEXT,
  p_idempotency_key TEXT
) RETURNS UUID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_term public.terminals%ROWTYPE;
  v_tr public.trading_accounts%ROWTYPE;
  v_wallet public.wallets%ROWTYPE;
  v_existing_tx_id UUID;
  v_usd_amount NUMERIC;
  v_journal_id UUID;
  v_tx_id UUID;
  v_ref TEXT;
  v_tx_hash TEXT;
  v_default_net TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Transfer amount must be positive';
  END IF;

  IF p_direction NOT IN ('to_trading', 'from_trading') THEN
    RAISE EXCEPTION 'Invalid bridge direction: %', p_direction;
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
  WHERE id = p_terminal_id AND owner_user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bound terminal not found or unauthorized';
  END IF;

  IF v_term.status IN ('suspended', 'locked') THEN
    RAISE EXCEPTION 'Terminal is currently %', v_term.status;
  END IF;

  SELECT * INTO v_tr
  FROM public.trading_accounts
  WHERE id = p_trading_account_id AND terminal_id = v_term.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trading account not found for this terminal';
  END IF;

  IF NOT (v_tr.currency = ANY(v_term.allowed_assets)) THEN
    RAISE EXCEPTION 'Asset % is restricted by terminal % policy', v_tr.currency, v_term.terminal_id;
  END IF;

  v_usd_amount := p_amount * public.get_asset_usd_rate(v_tr.currency);
  IF v_usd_amount > v_term.per_tx_limit_usd THEN
    RAISE EXCEPTION 'Bridge amount ($%) exceeds terminal per-transaction limit ($%)',
      round(v_usd_amount, 2), round(v_term.per_tx_limit_usd, 2);
  END IF;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE terminal_id = v_term.id AND asset = v_tr.currency
  ORDER BY available DESC, id ASC
  LIMIT 1
  FOR UPDATE;

  IF p_direction = 'to_trading' THEN
    IF v_wallet.id IS NULL OR v_wallet.available < p_amount THEN
      RAISE EXCEPTION 'Insufficient available % in terminal wallet', v_tr.currency;
    END IF;

    UPDATE public.wallets
    SET available = available - p_amount,
        version = version + 1,
        updated_at = now()
    WHERE id = v_wallet.id;

    UPDATE public.trading_accounts
    SET balance = balance + p_amount,
        free_margin = free_margin + p_amount
    WHERE id = v_tr.id;
  ELSE
    IF v_tr.free_margin < p_amount THEN
      RAISE EXCEPTION 'Insufficient free margin in trading account for withdrawal';
    END IF;

    UPDATE public.trading_accounts
    SET balance = balance - p_amount,
        free_margin = free_margin - p_amount
    WHERE id = v_tr.id;

    IF v_wallet.id IS NULL THEN
      v_default_net := CASE v_tr.currency WHEN 'USDT' THEN 'TRC20' WHEN 'BTC' THEN 'BTC' ELSE 'ETH' END;
      INSERT INTO public.wallets (terminal_id, asset, network, available)
      VALUES (v_term.id, v_tr.currency, v_default_net, p_amount)
      RETURNING * INTO v_wallet;
    ELSE
      UPDATE public.wallets
      SET available = available + p_amount,
          version = version + 1,
          updated_at = now()
      WHERE id = v_wallet.id;
    END IF;
  END IF;

  v_ref := 'NTPS-' || to_char(now(), 'YYMMDD') || '-' || substr(md5(p_idempotency_key || clock_timestamp()::TEXT), 1, 4);
  v_tx_hash := '0x' || encode(digest(p_idempotency_key || v_tr.id::TEXT || now()::TEXT, 'sha256'), 'hex');

  INSERT INTO public.journal_entries (kind, idempotency_key, memo, created_by)
  VALUES (
    'trading_funding',
    p_idempotency_key,
    CASE WHEN p_direction = 'to_trading' THEN 'Margin transfer to ' || v_tr.account_login ELSE 'Margin recall from ' || v_tr.account_login END,
    v_uid
  )
  RETURNING id INTO v_journal_id;

  IF p_direction = 'to_trading' THEN
    INSERT INTO public.ledger_postings (journal_id, account_ref, asset, amount)
    VALUES
      (v_journal_id, 'wallet:' || v_wallet.id::TEXT, v_tr.currency, -p_amount),
      (v_journal_id, 'trading:' || v_tr.account_login, v_tr.currency, p_amount);
  ELSE
    INSERT INTO public.ledger_postings (journal_id, account_ref, asset, amount)
    VALUES
      (v_journal_id, 'trading:' || v_tr.account_login, v_tr.currency, -p_amount),
      (v_journal_id, 'wallet:' || v_wallet.id::TEXT, v_tr.currency, p_amount);
  END IF;

  INSERT INTO public.transactions (
    reference, terminal_id, counterparty_terminal, type, asset, network, amount, fee, status, tx_hash, journal_id, memo
  ) VALUES (
    upper(v_ref),
    v_term.id,
    v_tr.account_login,
    'trading_funding',
    v_tr.currency,
    'NTPS_INTERNAL',
    p_amount,
    0,
    'completed',
    v_tx_hash,
    v_journal_id,
    CASE WHEN p_direction = 'to_trading' THEN 'Margin allocation to ' || v_tr.account_login ELSE 'Margin recall from ' || v_tr.account_login END
  )
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 7. FUNCTION PRIVILEGE LOCKS
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION ntps_internal.prevent_ledger_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ntps_internal.enforce_journal_zero_sum() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.get_asset_usd_rate(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_asset_usd_rate(TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.refresh_asset_rates(NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_asset_rates(NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC) TO service_role;

REVOKE ALL ON FUNCTION public.verify_ledger_invariant() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_ledger_invariant() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.execute_internal_transfer(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.execute_internal_transfer(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.request_crypto_withdrawal(UUID, TEXT, TEXT, UUID, NUMERIC, NUMERIC, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_crypto_withdrawal(UUID, TEXT, TEXT, UUID, NUMERIC, NUMERIC, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.transfer_trading_bridge(UUID, UUID, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_trading_bridge(UUID, UUID, NUMERIC, TEXT, TEXT) TO authenticated, service_role;

COMMIT;
