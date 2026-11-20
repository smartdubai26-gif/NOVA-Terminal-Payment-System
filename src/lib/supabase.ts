import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(
  supabaseUrl &&
    supabaseAnonKey &&
    supabaseUrl.startsWith('http') &&
    supabaseAnonKey.length > 16
);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
      },
    })
  : null;

export const SUPABASE_SQL_SCHEMA = `-- ============================================================================
-- NOVA Terminal Payment System (NTPS) - Supabase PostgreSQL Schema (Complete)
-- Double-Entry Immutable Ledger (SUM = 0) + Atomic RPCs + TRON Worker + RLS
-- ============================================================================

create extension if not exists "pgcrypto";

-- 1. TERMINALS (Master & Sub-Terminals)
create table if not exists public.terminals (
  id uuid primary key default gen_random_uuid(),
  terminal_id text not null unique,
  type text not null check (type in ('master', 'sub')),
  parent_id uuid references public.terminals(id) on delete restrict,
  owner_user_id uuid not null,
  label text not null,
  tier text not null default 'Gold' check (tier in ('Gold', 'Institutional', 'Desk')),
  status text not null default 'active' check (status in ('active', 'suspended', 'locked', 'restricted')),
  daily_limit_usd numeric(20, 4) not null default 500000.0000,
  per_tx_limit_usd numeric(20, 4) not null default 150000.0000,
  allowed_assets text[] not null default array['USDT', 'BTC', 'ETH'],
  created_at timestamptz not null default now()
);

-- 2. WALLETS (Multi-Asset Balances with Optimistic Locking Version)
create table if not exists public.wallets (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.terminals(id) on delete cascade,
  asset text not null check (asset in ('USDT', 'BTC', 'ETH')),
  network text not null,
  available numeric(28, 8) not null default 0 check (available >= 0),
  pending numeric(28, 8) not null default 0 check (pending >= 0),
  locked numeric(28, 8) not null default 0 check (locked >= 0),
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  unique (terminal_id, asset, network)
);

-- 3. JOURNAL ENTRIES (Double-Entry Header with Idempotency Key)
create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  idempotency_key text not null unique,
  memo text,
  created_by uuid,
  created_at timestamptz not null default now()
);

-- 4. LEDGER POSTINGS (Signed Double-Entry Lines: SUM(amount) = 0 per journal_id)
create table if not exists public.ledger_postings (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null references public.journal_entries(id) on delete restrict,
  account_ref text not null,
  asset text not null check (asset in ('USDT', 'BTC', 'ETH')),
  amount numeric(28, 8) not null check (amount <> 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_ledger_postings_journal on public.ledger_postings(journal_id);
create index if not exists idx_ledger_postings_account on public.ledger_postings(account_ref);

-- 5. TRANSACTIONS (Operational Payment Records)
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  terminal_id uuid not null references public.terminals(id) on delete restrict,
  counterparty_terminal text,
  type text not null,
  asset text not null,
  network text not null,
  amount numeric(28, 8) not null check (amount > 0),
  fee numeric(28, 8) not null default 0,
  status text not null default 'completed' check (status in ('detected', 'pending', 'completed', 'failed', 'reversed')),
  tx_hash text unique,
  journal_id uuid references public.journal_entries(id) on delete restrict,
  memo text,
  created_at timestamptz not null default now()
);

-- 6. WHITELIST ADDRESSES
create table if not exists public.whitelist_addresses (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.terminals(id) on delete cascade,
  label text not null,
  asset text not null,
  network text not null,
  address text not null,
  verified boolean not null default true,
  created_at timestamptz not null default now()
);

-- 7. INVOICES (Signed QR Invoices & Payment Requests)
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  terminal_id uuid not null references public.terminals(id) on delete cascade,
  payer_terminal_id text,
  asset text not null check (asset in ('USDT', 'BTC', 'ETH')),
  amount numeric(28, 8) not null check (amount > 0),
  description text not null,
  expires_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'paid', 'expired', 'cancelled')),
  signed_uri text not null,
  signature text not null,
  created_at timestamptz not null default now()
);

-- 8. TRADING ACCOUNTS (NOVA Margin & MT5 Omnibus Bridge)
create table if not exists public.trading_accounts (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.terminals(id) on delete cascade,
  account_type text not null check (account_type in ('nova_margin', 'mt5_omnibus')),
  account_login text not null unique,
  currency text not null check (currency in ('USDT', 'BTC', 'ETH')),
  balance numeric(28, 8) not null default 0 check (balance >= 0),
  free_margin numeric(28, 8) not null default 0 check (free_margin >= 0),
  leverage text not null default '1:100',
  status text not null default 'active' check (status in ('active', 'suspended'))
);

-- 9. AUDIT LOGS (Hash-Chained Compliance Record)
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  actor text not null,
  terminal_id text,
  details text not null,
  severity text not null check (severity in ('info', 'warn', 'critical')),
  prev_hash text not null,
  row_hash text not null,
  created_at timestamptz not null default now()
);

-- 10. DEPOSIT ADDRESSES (Per-Wallet Inbound Network Addresses)
create table if not exists public.deposit_addresses (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  network text not null,
  address text not null unique,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_deposit_addresses_wallet_network
  on public.deposit_addresses(wallet_id, network);

-- 11. WITHDRAWAL REQUESTS (Approval & TRON Broadcast Lifecycle)
create table if not exists public.withdrawal_requests (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  whitelist_address_id uuid not null references public.whitelist_addresses(id) on delete restrict,
  state text not null default 'review' check (state in ('review', 'approved', 'broadcast', 'confirmed', 'rejected')),
  broadcast_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 12. ATOMIC RPC FUNCTIONS (Double-Entry Ledger SUM(amount) = 0)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.credit_crypto_deposit(
  p_terminal_id UUID,
  p_wallet_id UUID,
  p_asset TEXT,
  p_network TEXT,
  p_amount NUMERIC,
  p_tx_hash TEXT
) RETURNS VOID AS $$
DECLARE
  v_journal_id UUID;
  v_ref TEXT;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Deposit amount must be positive';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.journal_entries WHERE idempotency_key = 'dep_' || p_tx_hash
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.journal_entries (kind, idempotency_key, memo)
  VALUES ('deposit', 'dep_' || p_tx_hash, 'Confirmed on-chain deposit (' || p_network || ')')
  RETURNING id INTO v_journal_id;

  INSERT INTO public.ledger_postings (journal_id, account_ref, asset, amount)
  VALUES
    (v_journal_id, 'system:hot_' || lower(p_asset) || '_' || lower(p_network), p_asset, -p_amount),
    (v_journal_id, 'wallet:' || p_wallet_id::TEXT, p_asset, p_amount);

  UPDATE public.wallets
  SET available = available + p_amount,
      version = version + 1,
      updated_at = now()
  WHERE id = p_wallet_id;

  v_ref := 'NTX-' || to_char(now(), 'YYYY-MM-DD') || '-' || substr(md5(p_tx_hash), 1, 6);

  INSERT INTO public.transactions (
    reference, terminal_id, counterparty_terminal, type, asset, network, amount, fee, status, tx_hash, journal_id, memo
  ) VALUES (
    v_ref, p_terminal_id, 'onchain:' || p_network, 'deposit', p_asset, p_network, p_amount, 0, 'completed', p_tx_hash, v_journal_id, 'Confirmed on-chain deposit'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.bootstrap_user_terminal(
  p_terminal_id TEXT,
  p_label TEXT DEFAULT 'NOVA Treasury Master'
) RETURNS UUID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_master_id UUID;
  v_suffix TEXT;
  v_prev_hash TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT id INTO v_master_id
  FROM public.terminals
  WHERE owner_user_id = v_uid AND type = 'master'
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_master_id IS NOT NULL THEN
    RETURN v_master_id;
  END IF;

  INSERT INTO public.terminals (
    terminal_id, type, parent_id, owner_user_id, label, tier, status, daily_limit_usd, per_tx_limit_usd, allowed_assets
  ) VALUES (
    p_terminal_id, 'master', NULL, v_uid, COALESCE(NULLIF(trim(p_label), ''), 'NOVA Treasury Master'), 'Gold', 'active', 500000.0000, 250000.0000, ARRAY['USDT', 'BTC', 'ETH']
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
    'Master treasury vault ' || p_terminal_id || ' provisioned for authenticated operator.',
    'info',
    v_prev_hash,
    '0x' || encode(digest(v_prev_hash || v_master_id::TEXT || now()::TEXT, 'sha256'), 'hex')
  );

  RETURN v_master_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
  v_term public.terminals%ROWTYPE;
  v_wl public.whitelist_addresses%ROWTYPE;
  v_existing_tx_id UUID;
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

  v_req_state := CASE WHEN COALESCE(p_auto_approve, FALSE) THEN 'approved' ELSE 'review' END;

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
    'Queued ' || p_amount::TEXT || ' ' || p_asset || ' (' || p_network || ') to ' || v_wl.address || ' in state=' || v_req_state,
    CASE WHEN v_req_state = 'review' THEN 'warn' ELSE 'info' END,
    v_prev_hash,
    '0x' || encode(digest(v_prev_hash || v_tx_id::TEXT || now()::TEXT, 'sha256'), 'hex')
  );

  RETURN v_tx_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.review_withdrawal_request(
  p_transaction_id UUID,
  p_action TEXT
) RETURNS VOID AS $$
DECLARE
  v_uid UUID := auth.uid();
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

  IF p_action NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'Invalid review action: %', p_action;
  END IF;

  SELECT tx.* INTO v_tx
  FROM public.transactions tx
  JOIN public.terminals t ON t.id = tx.terminal_id
  WHERE tx.id = p_transaction_id AND t.owner_user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Withdrawal transaction not found or unauthorized';
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
      RAISE EXCEPTION 'Cannot reject withdrawal in state %', v_req.state;
    END IF;

    UPDATE public.withdrawal_requests
    SET state = 'rejected'
    WHERE id = v_req.id;

    UPDATE public.transactions
    SET status = 'reversed'
    WHERE id = v_tx.id;

    IF v_tx.journal_id IS NOT NULL THEN
      INSERT INTO public.journal_entries (kind, idempotency_key, memo, created_by)
      VALUES ('withdrawal_reversal', 'rev_' || v_tx.id::TEXT, 'Compliance reversal of ' || v_tx.reference, v_uid)
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
    'Transaction ' || v_tx.reference || ' was ' || p_action || 'd by compliance officer.',
    CASE WHEN p_action = 'approve' THEN 'info' ELSE 'warn' END,
    v_prev_hash,
    '0x' || encode(digest(v_prev_hash || v_tx.id::TEXT || now()::TEXT, 'sha256'), 'hex')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.pay_invoice_atomic(
  p_invoice_id UUID,
  p_payer_terminal_id UUID,
  p_idempotency_key TEXT
) RETURNS UUID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_inv public.invoices%ROWTYPE;
  v_recipient public.terminals%ROWTYPE;
  v_payer public.terminals%ROWTYPE;
  v_tx_id UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_inv
  FROM public.invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF v_inv.status <> 'open' THEN
    RAISE EXCEPTION 'Invoice is already %', v_inv.status;
  END IF;

  SELECT * INTO v_payer
  FROM public.terminals
  WHERE id = p_payer_terminal_id AND owner_user_id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payer terminal not found or unauthorized';
  END IF;

  SELECT * INTO v_recipient
  FROM public.terminals
  WHERE id = v_inv.terminal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice recipient terminal not found';
  END IF;

  IF v_payer.id = v_recipient.id THEN
    RAISE EXCEPTION 'Payer terminal cannot be the same as invoice recipient';
  END IF;

  v_tx_id := public.execute_internal_transfer(
    v_payer.id,
    v_recipient.terminal_id,
    v_inv.asset,
    v_inv.amount,
    'Invoice settlement: ' || v_inv.invoice_number || ' — ' || v_inv.description,
    p_idempotency_key,
    'invoice_payment'
  );

  UPDATE public.invoices
  SET status = 'paid',
      payer_terminal_id = v_payer.terminal_id
  WHERE id = v_inv.id;

  RETURN v_tx_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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

  SELECT * INTO v_tr
  FROM public.trading_accounts
  WHERE id = p_trading_account_id AND terminal_id = v_term.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trading account not found for this terminal';
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
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_master
  FROM public.terminals
  WHERE owner_user_id = v_uid AND type = 'master'
  ORDER BY created_at ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Master terminal not found';
  END IF;

  INSERT INTO public.terminals (
    terminal_id, type, parent_id, owner_user_id, label, tier, status, daily_limit_usd, per_tx_limit_usd, allowed_assets
  ) VALUES (
    p_terminal_code, 'sub', v_master.id, v_uid, p_label, 'Desk', 'active', p_daily_limit, p_per_tx_limit, p_allowed_assets
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
    'Provisioned sub-terminal ' || p_terminal_code || ' (' || p_label || ')',
    'info',
    v_prev_hash,
    '0x' || encode(digest(v_prev_hash || v_sub_id::TEXT || now()::TEXT, 'sha256'), 'hex')
  );

  RETURN v_sub_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.update_terminal_status_admin(
  p_terminal_id UUID,
  p_status TEXT,
  p_reason TEXT
) RETURNS VOID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_term public.terminals%ROWTYPE;
  v_prev_hash TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_status NOT IN ('active', 'suspended', 'locked', 'restricted') THEN
    RAISE EXCEPTION 'Invalid terminal status: %', p_status;
  END IF;

  SELECT * INTO v_term
  FROM public.terminals
  WHERE id = p_terminal_id AND owner_user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Terminal not found or unauthorized';
  END IF;

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
    'Reason: ' || COALESCE(NULLIF(trim(p_reason), ''), 'Compliance status update'),
    CASE WHEN p_status = 'active' THEN 'info' ELSE 'warn' END,
    v_prev_hash,
    '0x' || encode(digest(v_prev_hash || v_term.id::TEXT || p_status || now()::TEXT, 'sha256'), 'hex')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.verify_ledger_invariant()
RETURNS TABLE(
  journal_count BIGINT,
  posting_count BIGINT,
  imbalanced_count BIGINT,
  is_balanced BOOLEAN
) AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  RETURN QUERY
  WITH user_journals AS (
    SELECT DISTINCT lp.journal_id
    FROM public.ledger_postings lp
    WHERE EXISTS (
      SELECT 1 FROM public.transactions tx
      JOIN public.terminals t ON t.id = tx.terminal_id
      WHERE tx.journal_id = lp.journal_id AND t.owner_user_id = v_uid
    )
    OR EXISTS (
      SELECT 1 FROM public.wallets w
      JOIN public.terminals t ON t.id = w.terminal_id
      WHERE lp.account_ref = ('wallet:' || w.id::TEXT) AND t.owner_user_id = v_uid
    )
  ),
  scoped_postings AS (
    SELECT lp.*
    FROM public.ledger_postings lp
    JOIN user_journals uj ON uj.journal_id = lp.journal_id
  ),
  grouped AS (
    SELECT sp.journal_id, sp.asset, SUM(sp.amount) AS net_amount
    FROM scoped_postings sp
    GROUP BY sp.journal_id, sp.asset
  )
  SELECT
    (SELECT COUNT(*) FROM grouped)::BIGINT AS journal_count,
    (SELECT COUNT(*) FROM scoped_postings)::BIGINT AS posting_count,
    (SELECT COUNT(*) FROM grouped WHERE ABS(net_amount) > 0.000001)::BIGINT AS imbalanced_count,
    ((SELECT COUNT(*) FROM grouped WHERE ABS(net_amount) > 0.000001) = 0) AS is_balanced;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.credit_crypto_deposit(UUID, UUID, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_crypto_deposit(UUID, UUID, TEXT, TEXT, NUMERIC, TEXT) TO service_role;

GRANT EXECUTE ON FUNCTION public.bootstrap_user_terminal(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.execute_internal_transfer(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_crypto_withdrawal(UUID, TEXT, TEXT, UUID, NUMERIC, NUMERIC, TEXT, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_withdrawal_request(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_invoice_atomic(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_trading_bridge(UUID, UUID, NUMERIC, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.provision_sub_terminal_atomic(TEXT, TEXT, NUMERIC, NUMERIC, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_terminal_status_admin(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_ledger_invariant() TO authenticated;

-- ============================================================================
-- 13. ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================
alter table public.terminals enable row level security;
alter table public.wallets enable row level security;
alter table public.journal_entries enable row level security;
alter table public.ledger_postings enable row level security;
alter table public.transactions enable row level security;
alter table public.whitelist_addresses enable row level security;
alter table public.invoices enable row level security;
alter table public.trading_accounts enable row level security;
alter table public.audit_logs enable row level security;
alter table public.deposit_addresses enable row level security;
alter table public.withdrawal_requests enable row level security;

drop policy if exists "terminals_select_own" on public.terminals;
create policy "terminals_select_own"
  on public.terminals for select
  to authenticated
  using (auth.uid() = owner_user_id);

drop policy if exists "terminals_insert_own" on public.terminals;
create policy "terminals_insert_own"
  on public.terminals for insert
  to authenticated
  with check (auth.uid() = owner_user_id);

drop policy if exists "terminals_update_own" on public.terminals;
create policy "terminals_update_own"
  on public.terminals for update
  to authenticated
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

drop policy if exists "wallets_select_own" on public.wallets;
create policy "wallets_select_own"
  on public.wallets for select
  to authenticated
  using (
    exists (
      select 1 from public.terminals t
      where t.id = wallets.terminal_id
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "journal_entries_select_own" on public.journal_entries;
create policy "journal_entries_select_own"
  on public.journal_entries for select
  to authenticated
  using (
    auth.uid() = created_by
    or exists (
      select 1 from public.transactions tx
      join public.terminals t on t.id = tx.terminal_id
      where tx.journal_id = journal_entries.id
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "ledger_postings_select_own" on public.ledger_postings;
create policy "ledger_postings_select_own"
  on public.ledger_postings for select
  to authenticated
  using (
    exists (
      select 1 from public.transactions tx
      join public.terminals t on t.id = tx.terminal_id
      where tx.journal_id = ledger_postings.journal_id
        and t.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.wallets w
      join public.terminals t on t.id = w.terminal_id
      where ledger_postings.account_ref = ('wallet:' || w.id::text)
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "transactions_select_own" on public.transactions;
create policy "transactions_select_own"
  on public.transactions for select
  to authenticated
  using (
    exists (
      select 1 from public.terminals t
      where t.id = transactions.terminal_id
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "whitelist_select_own" on public.whitelist_addresses;
create policy "whitelist_select_own"
  on public.whitelist_addresses for select
  to authenticated
  using (
    exists (
      select 1 from public.terminals t
      where t.id = whitelist_addresses.terminal_id
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "whitelist_insert_own" on public.whitelist_addresses;
create policy "whitelist_insert_own"
  on public.whitelist_addresses for insert
  to authenticated
  with check (
    exists (
      select 1 from public.terminals t
      where t.id = whitelist_addresses.terminal_id
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "whitelist_update_own" on public.whitelist_addresses;
create policy "whitelist_update_own"
  on public.whitelist_addresses for update
  to authenticated
  using (
    exists (
      select 1 from public.terminals t
      where t.id = whitelist_addresses.terminal_id
        and t.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.terminals t
      where t.id = whitelist_addresses.terminal_id
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "whitelist_delete_own" on public.whitelist_addresses;
create policy "whitelist_delete_own"
  on public.whitelist_addresses for delete
  to authenticated
  using (
    exists (
      select 1 from public.terminals t
      where t.id = whitelist_addresses.terminal_id
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "invoices_select_own" on public.invoices;
create policy "invoices_select_own"
  on public.invoices for select
  to authenticated
  using (
    exists (
      select 1 from public.terminals t
      where t.id = invoices.terminal_id
        and t.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.terminals pt
      where pt.terminal_id = invoices.payer_terminal_id
        and pt.owner_user_id = auth.uid()
    )
  );

drop policy if exists "invoices_insert_own" on public.invoices;
create policy "invoices_insert_own"
  on public.invoices for insert
  to authenticated
  with check (
    exists (
      select 1 from public.terminals t
      where t.id = invoices.terminal_id
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "invoices_update_own" on public.invoices;
create policy "invoices_update_own"
  on public.invoices for update
  to authenticated
  using (
    exists (
      select 1 from public.terminals t
      where t.id = invoices.terminal_id
        and t.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.terminals t
      where t.id = invoices.terminal_id
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "trading_accounts_select_own" on public.trading_accounts;
create policy "trading_accounts_select_own"
  on public.trading_accounts for select
  to authenticated
  using (
    exists (
      select 1 from public.terminals t
      where t.id = trading_accounts.terminal_id
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "trading_accounts_insert_own" on public.trading_accounts;
create policy "trading_accounts_insert_own"
  on public.trading_accounts for insert
  to authenticated
  with check (
    exists (
      select 1 from public.terminals t
      where t.id = trading_accounts.terminal_id
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "deposit_addresses_select_own" on public.deposit_addresses;
create policy "deposit_addresses_select_own"
  on public.deposit_addresses for select
  to authenticated
  using (
    exists (
      select 1 from public.wallets w
      join public.terminals t on t.id = w.terminal_id
      where w.id = deposit_addresses.wallet_id
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "deposit_addresses_insert_own" on public.deposit_addresses;
create policy "deposit_addresses_insert_own"
  on public.deposit_addresses for insert
  to authenticated
  with check (
    exists (
      select 1 from public.wallets w
      join public.terminals t on t.id = w.terminal_id
      where w.id = deposit_addresses.wallet_id
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "deposit_addresses_update_own" on public.deposit_addresses;
create policy "deposit_addresses_update_own"
  on public.deposit_addresses for update
  to authenticated
  using (
    exists (
      select 1 from public.wallets w
      join public.terminals t on t.id = w.terminal_id
      where w.id = deposit_addresses.wallet_id
        and t.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.wallets w
      join public.terminals t on t.id = w.terminal_id
      where w.id = deposit_addresses.wallet_id
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "withdrawal_requests_select_own" on public.withdrawal_requests;
create policy "withdrawal_requests_select_own"
  on public.withdrawal_requests for select
  to authenticated
  using (
    exists (
      select 1 from public.transactions tx
      join public.terminals t on t.id = tx.terminal_id
      where tx.id = withdrawal_requests.transaction_id
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "withdrawal_requests_insert_own" on public.withdrawal_requests;
create policy "withdrawal_requests_insert_own"
  on public.withdrawal_requests for insert
  to authenticated
  with check (
    exists (
      select 1 from public.transactions tx
      join public.terminals t on t.id = tx.terminal_id
      where tx.id = withdrawal_requests.transaction_id
        and t.owner_user_id = auth.uid()
    )
    and exists (
      select 1 from public.whitelist_addresses wl
      join public.terminals wt on wt.id = wl.terminal_id
      where wl.id = withdrawal_requests.whitelist_address_id
        and wt.owner_user_id = auth.uid()
    )
  );

drop policy if exists "audit_logs_select_own" on public.audit_logs;
create policy "audit_logs_select_own"
  on public.audit_logs for select
  to authenticated
  using (
    actor = auth.uid()::text
    or exists (
      select 1 from public.terminals t
      where (t.id::text = audit_logs.terminal_id or t.terminal_id = audit_logs.terminal_id)
        and t.owner_user_id = auth.uid()
    )
  );

drop policy if exists "audit_logs_insert_own" on public.audit_logs;
create policy "audit_logs_insert_own"
  on public.audit_logs for insert
  to authenticated
  with check (
    actor = auth.uid()::text
    and (
      audit_logs.terminal_id is null
      or exists (
        select 1 from public.terminals t
        where (t.id::text = audit_logs.terminal_id or t.terminal_id = audit_logs.terminal_id)
          and t.owner_user_id = auth.uid()
      )
    )
  );

-- ============================================================================
-- 14. SUPABASE REALTIME PUBLICATION
-- ============================================================================
DO $$
DECLARE
  v_table TEXT;
  v_tables TEXT[] := ARRAY[
    'terminals',
    'wallets',
    'transactions',
    'withdrawal_requests',
    'invoices',
    'deposit_addresses',
    'trading_accounts',
    'audit_logs'
  ];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH v_table IN ARRAY v_tables
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = v_table
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
      END IF;
    END LOOP;
  END IF;
END;
$$;`;
