-- ============================================================================
-- Migration 007: Stage-1 Pre-Production Validation & Serialization Hardening
-- NOVA Terminal Payment System (NTPS)
--
-- Purpose:
--   Closes Stage-1 database validation & concurrency items after migrations
--   001 through 006:
--     - SYS-7 : Validate NTPS Terminal ID format + Crockford Base32 Mod-37
--               checksum inside `bootstrap_user_terminal` and
--               `provision_sub_terminal_atomic` (including master prefix match).
--     - SYS-8 : Validate destination/deposit addresses per chain (`TRC20`,
--               `ERC20`, `ETH`, `ARBITRUM`, `BTC`) in `register_deposit_address`
--               and `add_whitelist_address` (plus asset/network compatibility).
--     - SYS-10: Enforce `aml_blocked_addresses` integrity via BEFORE INSERT OR
--               UPDATE validation trigger (supported network, valid chain
--               address format, non-empty reason).
--     - W-11  : Add serialized `append_worker_audit_log` RPC using a
--               transaction-scoped advisory lock (`pg_advisory_xact_lock`) so
--               concurrent worker audit inserts cannot fork `prev_hash`.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. SYS-7: CROCKFORD BASE32 MOD-37 TERMINAL ID VALIDATOR
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_valid_ntps_terminal_id(
  p_terminal_id TEXT,
  p_expected_type TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE
  v_alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_check_alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U';
  v_clean TEXT := upper(trim(COALESCE(p_terminal_id, '')));
  v_matches TEXT[];
  v_payload7 TEXT;
  v_check_char TEXT;
  v_sub_suffix TEXT;
  v_acc INTEGER := 0;
  v_idx INTEGER;
  v_pos INTEGER;
  v_expected_check TEXT;
BEGIN
  IF p_expected_type IS NOT NULL AND p_expected_type NOT IN ('master', 'sub') THEN
    RETURN FALSE;
  END IF;

  v_matches := regexp_match(
    v_clean,
    '^NT-OMEGA-([0-9A-Z]{4})-([0-9A-Z]{3}[0-9A-Z*~$=])(?:-(S[0-9]{2,3}))?$'
  );

  IF v_matches IS NULL THEN
    RETURN FALSE;
  END IF;

  v_sub_suffix := v_matches[3];
  IF p_expected_type = 'master' AND v_sub_suffix IS NOT NULL THEN
    RETURN FALSE;
  END IF;
  IF p_expected_type = 'sub' AND v_sub_suffix IS NULL THEN
    RETURN FALSE;
  END IF;

  v_payload7 := v_matches[1] || substr(v_matches[2], 1, 3);
  v_check_char := substr(v_matches[2], 4, 1);

  FOR v_idx IN 1..7 LOOP
    v_pos := strpos(v_alphabet, substr(v_payload7, v_idx, 1)) - 1;
    IF v_pos < 0 THEN
      RETURN FALSE;
    END IF;
    v_acc := (v_acc * 32 + v_pos) % 37;
  END LOOP;

  v_expected_check := substr(v_check_alphabet, v_acc + 1, 1);
  RETURN v_check_char = v_expected_check;
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = public;

-- Enforce SYS-7 inside `bootstrap_user_terminal`
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
    'Master treasury vault ' || v_clean_code || ' provisioned for authenticated operator.',
    'info',
    v_prev_hash,
    '0x' || encode(sha256(convert_to(v_prev_hash || v_master_id::TEXT || now()::TEXT, 'UTF8')), 'hex')
  );

  RETURN v_master_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Enforce SYS-7 inside `provision_sub_terminal_atomic` (preserves Stage-0 Master cap lock)
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

-- ----------------------------------------------------------------------------
-- 2. SYS-8: CHAIN-SPECIFIC ON-CHAIN ADDRESS VALIDATOR & RPC HARDENING
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_valid_chain_address(
  p_network TEXT,
  p_address TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_net TEXT := upper(trim(COALESCE(p_network, '')));
  v_addr TEXT := trim(COALESCE(p_address, ''));
BEGIN
  IF v_addr = '' THEN
    RETURN FALSE;
  END IF;

  CASE v_net
    WHEN 'TRC20' THEN
      RETURN v_addr ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$';
    WHEN 'ERC20', 'ETH', 'ARBITRUM' THEN
      RETURN v_addr ~ '^0x[0-9a-fA-F]{40}$';
    WHEN 'BTC' THEN
      RETURN v_addr ~ '^(?:[13][1-9A-HJ-NP-Za-km-z]{25,34}|(?:bc1|tb1|BC1|TB1)[0-9ac-hj-np-zAC-HJ-NP-Z]{25,87})$';
    ELSE
      RETURN FALSE;
  END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = public;

-- Enforce SYS-8 inside `register_deposit_address`
CREATE OR REPLACE FUNCTION public.register_deposit_address(
  p_wallet_id UUID,
  p_network TEXT,
  p_address TEXT
) RETURNS UUID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_wallet public.wallets%ROWTYPE;
  v_term public.terminals%ROWTYPE;
  v_clean_net TEXT := upper(trim(COALESCE(p_network, '')));
  v_clean_addr TEXT := trim(COALESCE(p_address, ''));
  v_existing_id UUID;
  v_result_id UUID;
  v_prev_hash TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_clean_net NOT IN ('TRC20', 'ERC20', 'BTC', 'ETH', 'ARBITRUM') THEN
    RAISE EXCEPTION 'Unsupported deposit network: %', p_network;
  END IF;

  IF NOT public.is_valid_chain_address(v_clean_net, v_clean_addr) THEN
    RAISE EXCEPTION 'Invalid % deposit address format', v_clean_net;
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
  WHERE wallet_id = v_wallet.id AND network = v_clean_net
  FOR UPDATE;

  IF v_existing_id IS NOT NULL THEN
    UPDATE public.deposit_addresses
    SET address = v_clean_addr
    WHERE id = v_existing_id
    RETURNING id INTO v_result_id;
  ELSE
    INSERT INTO public.deposit_addresses (wallet_id, network, address)
    VALUES (v_wallet.id, v_clean_net, v_clean_addr)
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
    'Bound ' || v_wallet.asset || ' (' || v_clean_net || ') deposit address ' || v_clean_addr,
    'info',
    v_prev_hash,
    '0x' || encode(sha256(convert_to(v_prev_hash || v_result_id::TEXT || v_clean_addr || now()::TEXT, 'UTF8')), 'hex')
  );

  RETURN v_result_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Enforce SYS-8 inside `add_whitelist_address`
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
  v_clean_asset TEXT := upper(trim(COALESCE(p_asset, '')));
  v_clean_net TEXT := upper(trim(COALESCE(p_network, '')));
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
  WHERE id = p_terminal_id AND owner_user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Terminal not found or unauthorized';
  END IF;

  INSERT INTO public.whitelist_addresses (
    terminal_id, label, asset, network, address, verified
  ) VALUES (
    v_term.id, v_clean_label, v_clean_asset, v_clean_net, v_clean_addr, true
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
    'Added ' || v_clean_asset || ' (' || v_clean_net || ') destination "' || v_clean_label || '" -> ' || v_clean_addr,
    'info',
    v_prev_hash,
    '0x' || encode(sha256(convert_to(v_prev_hash || v_wl_id::TEXT || v_clean_addr || now()::TEXT, 'UTF8')), 'hex')
  );

  RETURN v_wl_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 3. SYS-10: AML BLOCKED ADDRESS VALIDATION TRIGGER
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ntps_internal.validate_aml_blocked_address()
RETURNS TRIGGER AS $$
BEGIN
  NEW.address := trim(COALESCE(NEW.address, ''));
  NEW.network := upper(trim(COALESCE(NEW.network, '')));
  NEW.reason := trim(COALESCE(NEW.reason, ''));

  IF NEW.network NOT IN ('TRC20', 'ERC20', 'BTC', 'ETH', 'ARBITRUM') THEN
    RAISE EXCEPTION 'Unsupported AML network: %', NEW.network
      USING ERRCODE = '23514';
  END IF;

  IF NEW.reason = '' THEN
    RAISE EXCEPTION 'AML block entry requires a non-empty compliance reason'
      USING ERRCODE = '23514';
  END IF;

  IF NOT public.is_valid_chain_address(NEW.network, NEW.address) THEN
    RAISE EXCEPTION 'Invalid % address in aml_blocked_addresses: %', NEW.network, NEW.address
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_validate_aml_blocked_address ON public.aml_blocked_addresses;
CREATE TRIGGER trg_validate_aml_blocked_address
  BEFORE INSERT OR UPDATE ON public.aml_blocked_addresses
  FOR EACH ROW
  EXECUTE FUNCTION ntps_internal.validate_aml_blocked_address();

-- ----------------------------------------------------------------------------
-- 4. W-11: ATOMIC HASH-CHAINED WORKER AUDIT LOG RPC (ADVISORY LOCK)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.append_worker_audit_log(
  p_event_type TEXT,
  p_actor TEXT DEFAULT 'ntps-tron-worker',
  p_terminal_id TEXT DEFAULT NULL,
  p_details TEXT DEFAULT '',
  p_severity TEXT DEFAULT 'info'
) RETURNS UUID AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), '');
  v_clean_event TEXT := trim(COALESCE(p_event_type, ''));
  v_clean_actor TEXT := COALESCE(NULLIF(trim(COALESCE(p_actor, '')), ''), 'ntps-tron-worker');
  v_clean_details TEXT := trim(COALESCE(p_details, ''));
  v_clean_severity TEXT := lower(trim(COALESCE(p_severity, 'info')));
  v_prev_hash TEXT;
  v_row_hash TEXT;
  v_now TIMESTAMPTZ := now();
  v_id UUID;
BEGIN
  IF v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'Forbidden: append_worker_audit_log requires service_role'
      USING ERRCODE = '42501';
  END IF;

  IF v_clean_event = '' THEN
    RAISE EXCEPTION 'Audit event_type is required';
  END IF;

  IF v_clean_details = '' THEN
    RAISE EXCEPTION 'Audit details are required';
  END IF;

  IF v_clean_severity NOT IN ('info', 'warn', 'critical') THEN
    RAISE EXCEPTION 'Invalid audit severity: %', p_severity;
  END IF;

  -- Serialize hash-chain head read + insert across concurrent worker operations
  PERFORM pg_advisory_xact_lock(hashtext('ntps_audit_logs_chain'));

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC, id DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  v_row_hash := '0x' || encode(
    sha256(
      convert_to(
        v_prev_hash || '|' || v_clean_event || '|' || v_clean_actor || '|' ||
        COALESCE(p_terminal_id, '') || '|' || v_clean_details || '|' ||
        to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'UTF8'
      )
    ),
    'hex'
  );

  INSERT INTO public.audit_logs (
    event_type, actor, terminal_id, details, severity, prev_hash, row_hash, created_at
  ) VALUES (
    v_clean_event, v_clean_actor, NULLIF(trim(COALESCE(p_terminal_id, '')), ''), v_clean_details, v_clean_severity, v_prev_hash, v_row_hash, v_now
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 5. PRIVILEGE LOCKS
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.is_valid_ntps_terminal_id(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_valid_ntps_terminal_id(TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_valid_chain_address(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_valid_chain_address(TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION ntps_internal.validate_aml_blocked_address() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.bootstrap_user_terminal(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bootstrap_user_terminal(TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.provision_sub_terminal_atomic(TEXT, TEXT, NUMERIC, NUMERIC, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.provision_sub_terminal_atomic(TEXT, TEXT, NUMERIC, NUMERIC, TEXT[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.register_deposit_address(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_deposit_address(UUID, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.add_whitelist_address(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_whitelist_address(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.append_worker_audit_log(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_worker_audit_log(TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

COMMIT;
