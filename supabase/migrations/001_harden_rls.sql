-- ============================================================================
-- Migration 001: Audit & Harden Row Level Security (RLS) & Role Privileges
-- NOVA Terminal Payment System (NTPS)
--
-- Purpose:
--   1. Enforce least-privilege table grants across `PUBLIC`, `anon`,
--      `authenticated`, and `service_role` on all 11 core tables.
--   2. Provide a non-PII `public_system_info` read surface for `anon` (SELECT-only)
--      while revoking all direct INSERT/UPDATE/DELETE/TRUNCATE privileges for
--      `anon` across all ledger, custody, and operational tables.
--   3. Eliminate client-direct write bypasses for `authenticated` on:
--      - `withdrawal_requests` (was vulnerable to direct `state = 'approved'` insert)
--      - `trading_accounts`    (was vulnerable to forged `balance`/`free_margin` insert)
--      - `terminals`           (was vulnerable to self-unfreeze / limit tampering)
--      - `deposit_addresses`   (now routed via `register_deposit_address` RPC)
--      - `invoices`            (now routed via `create_invoice_atomic` RPC)
--      - `whitelist_addresses` (was vulnerable to TOCTOU address swap before broadcast)
--      - `audit_logs`          (now strictly append-only via server RPC / service_role)
--   4. Explicitly restrict EXECUTE privileges on all SECURITY DEFINER RPCs
--      (SET search_path = public) so `PUBLIC` and `anon` cannot invoke them.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. REVOKE DEFAULT / OVER-PERMISSIVE PRIVILEGES ON ALL CORE TABLES
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE
  public.terminals,
  public.wallets,
  public.journal_entries,
  public.ledger_postings,
  public.transactions,
  public.whitelist_addresses,
  public.invoices,
  public.trading_accounts,
  public.audit_logs,
  public.deposit_addresses,
  public.withdrawal_requests
FROM PUBLIC, anon, authenticated;

-- Service role retains full operational access (TRON worker & administrative jobs)
GRANT ALL ON TABLE
  public.terminals,
  public.wallets,
  public.journal_entries,
  public.ledger_postings,
  public.transactions,
  public.whitelist_addresses,
  public.invoices,
  public.trading_accounts,
  public.audit_logs,
  public.deposit_addresses,
  public.withdrawal_requests
TO service_role;

-- Authenticated role receives strictly SELECT-only table privileges.
-- All state-changing financial & policy writes flow through SECURITY DEFINER RPCs.
GRANT SELECT ON TABLE
  public.terminals,
  public.wallets,
  public.journal_entries,
  public.ledger_postings,
  public.transactions,
  public.whitelist_addresses,
  public.invoices,
  public.trading_accounts,
  public.audit_logs,
  public.deposit_addresses,
  public.withdrawal_requests
TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. SAFE READ SURFACE FOR `anon` (SELECT-ONLY, ZERO PII / ZERO FINANCIAL DATA)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.public_system_info AS
SELECT
  'NOVA Terminal Payment System (NTPS)'::TEXT AS system_name,
  '1.1.0'::TEXT AS protocol_version,
  'NT-OMEGA-XXXX-XXXX'::TEXT AS terminal_id_format,
  'Crockford Base32 Mod-37'::TEXT AS checksum_algorithm,
  ARRAY['USDT', 'BTC', 'ETH']::TEXT[] AS supported_assets,
  ARRAY['TRC20', 'ERC20', 'BTC', 'ETH', 'ARBITRUM', 'NTPS_INTERNAL']::TEXT[] AS supported_networks,
  'TRC20'::TEXT AS live_chain_settlement_network;

REVOKE ALL ON public.public_system_info FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.public_system_info TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. DROP OVER-PERMISSIVE CLIENT WRITE POLICIES (CLOSE DIRECT POSTGREST BYPASSES)
-- ----------------------------------------------------------------------------
-- Terminals: block direct INSERT/UPDATE so limits, tier, and status cannot be tampered
DROP POLICY IF EXISTS "terminals_insert_own" ON public.terminals;
DROP POLICY IF EXISTS "terminals_update_own" ON public.terminals;

-- Whitelist Addresses: block direct INSERT/UPDATE/DELETE (prevents TOCTOU address swap)
DROP POLICY IF EXISTS "whitelist_insert_own" ON public.whitelist_addresses;
DROP POLICY IF EXISTS "whitelist_update_own" ON public.whitelist_addresses;
DROP POLICY IF EXISTS "whitelist_delete_own" ON public.whitelist_addresses;

-- Invoices: block direct INSERT/UPDATE (status & amount integrity enforced by RPC)
DROP POLICY IF EXISTS "invoices_insert_own" ON public.invoices;
DROP POLICY IF EXISTS "invoices_update_own" ON public.invoices;

-- Trading Accounts: block direct INSERT (prevents forged free_margin credit exploit)
DROP POLICY IF EXISTS "trading_accounts_insert_own" ON public.trading_accounts;

-- Deposit Addresses: block direct INSERT/UPDATE (routed through validated RPC)
DROP POLICY IF EXISTS "deposit_addresses_insert_own" ON public.deposit_addresses;
DROP POLICY IF EXISTS "deposit_addresses_update_own" ON public.deposit_addresses;

-- Withdrawal Requests: block direct INSERT (prevents bypassing compliance state='review')
DROP POLICY IF EXISTS "withdrawal_requests_insert_own" ON public.withdrawal_requests;

-- Audit Logs: block direct client INSERT (audit trail written only by RPC / service_role)
DROP POLICY IF EXISTS "audit_logs_insert_own" ON public.audit_logs;

-- ----------------------------------------------------------------------------
-- 4. ENSURE ALL 11 TABLES HAVE RLS ENABLED & FORCE-CLEAN SELECT POLICIES
-- ----------------------------------------------------------------------------
ALTER TABLE public.terminals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whitelist_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trading_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deposit_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withdrawal_requests ENABLE ROW LEVEL SECURITY;

-- Note: Existing `*_select_own` policies on all 11 tables remain scoped to
-- `TO authenticated` with `auth.uid()` ownership predicates, meaning `anon`
-- (`auth.uid() IS NULL`) receives zero rows even if SELECT were ever granted,
-- and with REVOKE ALL above, `anon` is denied at both privilege and RLS layers.

-- ----------------------------------------------------------------------------
-- 5. NEW SECURITY DEFINER RPCs TO REPLACE REMOVED DIRECT CLIENT WRITES
-- ----------------------------------------------------------------------------

-- 5A. Register or Update Inbound Deposit Watch Address (Validated & Audited)
CREATE OR REPLACE FUNCTION public.register_deposit_address(
  p_wallet_id UUID,
  p_network TEXT,
  p_address TEXT
) RETURNS UUID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_wallet public.wallets%ROWTYPE;
  v_term public.terminals%ROWTYPE;
  v_clean_addr TEXT := trim(COALESCE(p_address, ''));
  v_existing_id UUID;
  v_result_id UUID;
  v_prev_hash TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_network NOT IN ('TRC20', 'ERC20', 'BTC', 'ETH', 'ARBITRUM') THEN
    RAISE EXCEPTION 'Unsupported deposit network: %', p_network;
  END IF;

  IF length(v_clean_addr) < 12 THEN
    RAISE EXCEPTION 'Deposit address must be at least 12 characters';
  END IF;

  IF p_network = 'TRC20' AND v_clean_addr !~ '^T[1-9A-HJ-NP-Za-km-z]{33}$' THEN
    RAISE EXCEPTION 'Invalid TRC-20 address format';
  END IF;

  SELECT w.* INTO v_wallet
  FROM public.wallets w
  JOIN public.terminals t ON t.id = w.terminal_id
  WHERE w.id = p_wallet_id
    AND t.owner_user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found or unauthorized';
  END IF;

  SELECT * INTO v_term FROM public.terminals WHERE id = v_wallet.terminal_id;

  SELECT id INTO v_existing_id
  FROM public.deposit_addresses
  WHERE wallet_id = v_wallet.id AND network = p_network
  FOR UPDATE;

  IF v_existing_id IS NOT NULL THEN
    UPDATE public.deposit_addresses
    SET address = v_clean_addr
    WHERE id = v_existing_id
    RETURNING id INTO v_result_id;
  ELSE
    INSERT INTO public.deposit_addresses (wallet_id, network, address)
    VALUES (v_wallet.id, p_network, v_clean_addr)
    RETURNING id INTO v_result_id;
  END IF;

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
  VALUES (
    'DEPOSIT_ADDRESS_REGISTERED',
    v_uid::TEXT,
    v_term.id::TEXT,
    'Bound ' || v_wallet.asset || ' (' || p_network || ') deposit address ' || v_clean_addr,
    'info',
    v_prev_hash,
    '0x' || encode(sha256(convert_to(v_prev_hash || v_result_id::TEXT || v_clean_addr || now()::TEXT, 'UTF8')), 'hex')
  );

  RETURN v_result_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 5B. Update Sub-Terminal Policy (Cannot Self-Unfreeze Locked Terminal or Exceed Master Caps)
CREATE OR REPLACE FUNCTION public.update_sub_terminal_policy(
  p_terminal_id UUID,
  p_status TEXT DEFAULT NULL,
  p_daily_limit_usd NUMERIC DEFAULT NULL,
  p_per_tx_limit_usd NUMERIC DEFAULT NULL,
  p_allowed_assets TEXT[] DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_sub public.terminals%ROWTYPE;
  v_master public.terminals%ROWTYPE;
  v_next_status TEXT;
  v_next_daily NUMERIC;
  v_next_per_tx NUMERIC;
  v_next_assets TEXT[];
  v_prev_hash TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_sub
  FROM public.terminals
  WHERE id = p_terminal_id
    AND owner_user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Terminal not found or unauthorized';
  END IF;

  IF v_sub.type <> 'sub' THEN
    RAISE EXCEPTION 'Self-service policy updates are restricted to sub-terminals';
  END IF;

  IF v_sub.status IN ('locked', 'restricted') THEN
    RAISE EXCEPTION 'Compliance-% terminal cannot be modified via self-service policy', v_sub.status;
  END IF;

  IF p_status IS NOT NULL AND p_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'Sub-terminal policy status must be active or suspended';
  END IF;

  IF v_sub.parent_id IS NOT NULL THEN
    SELECT * INTO v_master FROM public.terminals WHERE id = v_sub.parent_id;
  END IF;

  v_next_status := COALESCE(p_status, v_sub.status);
  v_next_daily := COALESCE(p_daily_limit_usd, v_sub.daily_limit_usd);
  v_next_per_tx := COALESCE(p_per_tx_limit_usd, v_sub.per_tx_limit_usd);
  v_next_assets := COALESCE(p_allowed_assets, v_sub.allowed_assets);

  IF v_next_daily <= 0 OR v_next_per_tx <= 0 THEN
    RAISE EXCEPTION 'Limits must be positive';
  END IF;

  IF v_next_per_tx > v_next_daily THEN
    RAISE EXCEPTION 'Per-transaction limit cannot exceed daily limit';
  END IF;

  IF v_master.id IS NOT NULL AND v_next_daily > v_master.daily_limit_usd THEN
    RAISE EXCEPTION 'Sub-terminal daily limit cannot exceed Master Terminal cap ($%)', v_master.daily_limit_usd;
  END IF;

  IF array_length(v_next_assets, 1) IS NULL OR NOT (v_next_assets <@ ARRAY['USDT', 'BTC', 'ETH']::TEXT[]) THEN
    RAISE EXCEPTION 'Allowed assets must be a non-empty subset of USDT, BTC, ETH';
  END IF;

  UPDATE public.terminals
  SET status = v_next_status,
      daily_limit_usd = v_next_daily,
      per_tx_limit_usd = v_next_per_tx,
      allowed_assets = v_next_assets
  WHERE id = v_sub.id;

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
  VALUES (
    'SUB_TERMINAL_POLICY_UPDATED',
    v_uid::TEXT,
    v_sub.id::TEXT,
    'Updated policy for ' || v_sub.terminal_id || ' (status=' || v_next_status || ', daily=$' || v_next_daily || ', per_tx=$' || v_next_per_tx || ')',
    'info',
    v_prev_hash,
    '0x' || encode(sha256(convert_to(v_prev_hash || v_sub.id::TEXT || v_next_status || now()::TEXT, 'UTF8')), 'hex')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 5C. Add Verified Custody Whitelist Destination (Immutable After Creation)
CREATE OR REPLACE FUNCTION public.add_whitelist_address(
  p_terminal_id UUID,
  p_label TEXT,
  p_asset TEXT,
  p_network TEXT,
  p_address TEXT
) RETURNS UUID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_term public.terminals%ROWTYPE;
  v_clean_label TEXT := trim(COALESCE(p_label, ''));
  v_clean_addr TEXT := trim(COALESCE(p_address, ''));
  v_wl_id UUID;
  v_prev_hash TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF length(v_clean_label) < 2 THEN
    RAISE EXCEPTION 'Whitelist label is required';
  END IF;

  IF p_asset NOT IN ('USDT', 'BTC', 'ETH') THEN
    RAISE EXCEPTION 'Unsupported asset: %', p_asset;
  END IF;

  IF p_network NOT IN ('TRC20', 'ERC20', 'BTC', 'ETH', 'ARBITRUM') THEN
    RAISE EXCEPTION 'Unsupported network: %', p_network;
  END IF;

  IF length(v_clean_addr) < 12 THEN
    RAISE EXCEPTION 'Destination address is too short';
  END IF;

  IF p_network = 'TRC20' AND v_clean_addr !~ '^T[1-9A-HJ-NP-Za-km-z]{33}$' THEN
    RAISE EXCEPTION 'Invalid TRC-20 destination address';
  END IF;

  SELECT * INTO v_term
  FROM public.terminals
  WHERE id = p_terminal_id AND owner_user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Terminal not found or unauthorized';
  END IF;

  INSERT INTO public.whitelist_addresses (
    terminal_id, label, asset, network, address, verified
  ) VALUES (
    v_term.id, v_clean_label, p_asset, p_network, v_clean_addr, true
  )
  RETURNING id INTO v_wl_id;

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
  VALUES (
    'WHITELIST_ADDRESS_ADDED',
    v_uid::TEXT,
    v_term.id::TEXT,
    'Added ' || p_asset || ' (' || p_network || ') destination "' || v_clean_label || '" -> ' || v_clean_addr,
    'info',
    v_prev_hash,
    '0x' || encode(sha256(convert_to(v_prev_hash || v_wl_id::TEXT || v_clean_addr || now()::TEXT, 'UTF8')), 'hex')
  );

  RETURN v_wl_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 5D. Create Signed Invoice Atomically (Forces Initial status = 'open')
CREATE OR REPLACE FUNCTION public.create_invoice_atomic(
  p_terminal_id UUID,
  p_payer_terminal_id TEXT,
  p_asset TEXT,
  p_amount NUMERIC,
  p_description TEXT,
  p_expires_at TIMESTAMPTZ,
  p_invoice_number TEXT,
  p_signed_uri TEXT,
  p_signature TEXT
) RETURNS UUID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_term public.terminals%ROWTYPE;
  v_inv_id UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_asset NOT IN ('USDT', 'BTC', 'ETH') THEN
    RAISE EXCEPTION 'Unsupported invoice asset: %', p_asset;
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invoice amount must be positive';
  END IF;

  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'Invoice expiry must be in the future';
  END IF;

  SELECT * INTO v_term
  FROM public.terminals
  WHERE id = p_terminal_id AND owner_user_id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recipient terminal not found or unauthorized';
  END IF;

  INSERT INTO public.invoices (
    invoice_number,
    terminal_id,
    payer_terminal_id,
    asset,
    amount,
    description,
    expires_at,
    status,
    signed_uri,
    signature
  ) VALUES (
    p_invoice_number,
    v_term.id,
    NULLIF(trim(COALESCE(p_payer_terminal_id, '')), ''),
    p_asset,
    p_amount,
    COALESCE(NULLIF(trim(p_description), ''), 'NTPS Payment Request'),
    p_expires_at,
    'open',
    p_signed_uri,
    p_signature
  )
  RETURNING id INTO v_inv_id;

  RETURN v_inv_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 6. LOCK DOWN FUNCTION EXECUTION PRIVILEGES (REVOKE FROM PUBLIC & anon)
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.credit_crypto_deposit(UUID, UUID, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_crypto_deposit(UUID, UUID, TEXT, TEXT, NUMERIC, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.bootstrap_user_terminal(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.execute_internal_transfer(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_crypto_withdrawal(UUID, TEXT, TEXT, UUID, NUMERIC, NUMERIC, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_withdrawal_request(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_invoice_atomic(UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.transfer_trading_bridge(UUID, UUID, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.provision_sub_terminal_atomic(TEXT, TEXT, NUMERIC, NUMERIC, TEXT[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_terminal_status_admin(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_ledger_invariant() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.register_deposit_address(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_sub_terminal_policy(UUID, TEXT, NUMERIC, NUMERIC, TEXT[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.add_whitelist_address(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_invoice_atomic(UUID, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.bootstrap_user_terminal(TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.execute_internal_transfer(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_crypto_withdrawal(UUID, TEXT, TEXT, UUID, NUMERIC, NUMERIC, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_withdrawal_request(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.pay_invoice_atomic(UUID, UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.transfer_trading_bridge(UUID, UUID, NUMERIC, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.provision_sub_terminal_atomic(TEXT, TEXT, NUMERIC, NUMERIC, TEXT[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_terminal_status_admin(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_ledger_invariant() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_deposit_address(UUID, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_sub_terminal_policy(UUID, TEXT, NUMERIC, NUMERIC, TEXT[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_whitelist_address(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_invoice_atomic(UUID, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT) TO authenticated, service_role;

COMMIT;
