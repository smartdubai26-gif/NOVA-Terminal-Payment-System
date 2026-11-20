-- ============================================================================
-- Migration 004: TRON Worker Reliability, Persisted Deposit Cursor & AML Screening
-- NOVA Terminal Payment System (NTPS)
--
-- Purpose:
--   1. Add broadcast retry tracking (`attempt_count`, `last_attempt_at`,
--      `last_error`, `tx_hash_candidate`) to `public.withdrawal_requests` to
--      enforce max-retry tracking and prevent duplicate on-chain payouts.
--   2. Add persisted `last_polled_timestamp_ms` cursor to `public.deposit_addresses`
--      plus `public.worker_checkpoints` so `watchDeposits()` resumes cleanly
--      across worker restarts using TronGrid `min_timestamp`.
--   3. Create `public.aml_blocked_addresses` for lightweight pre-broadcast AML
--      destination screening (`service_role` managed, zero client tampering).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. WITHDRAWAL RETRY & DUPLICATE-PAYOUT GUARD COLUMNS
-- ----------------------------------------------------------------------------
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS tx_hash_candidate TEXT;

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_state_created
  ON public.withdrawal_requests(state, created_at);

-- ----------------------------------------------------------------------------
-- 2. PERSISTED DEPOSIT POLLING CURSOR (`min_timestamp` Across Restarts)
-- ----------------------------------------------------------------------------
ALTER TABLE public.deposit_addresses
  ADD COLUMN IF NOT EXISTS last_polled_timestamp_ms BIGINT NOT NULL DEFAULT 0 CHECK (last_polled_timestamp_ms >= 0);

CREATE TABLE IF NOT EXISTS public.worker_checkpoints (
  worker_key TEXT PRIMARY KEY,
  cursor_ms BIGINT NOT NULL DEFAULT 0 CHECK (cursor_ms >= 0),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.worker_checkpoints ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.worker_checkpoints FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.worker_checkpoints TO service_role;

-- ----------------------------------------------------------------------------
-- 3. LIGHTWEIGHT AML BLOCKED ADDRESS REGISTRY
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.aml_blocked_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address TEXT NOT NULL UNIQUE,
  network TEXT NOT NULL DEFAULT 'TRC20',
  reason TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'blocked' CHECK (risk_level IN ('high', 'sanctioned', 'blocked')),
  source TEXT NOT NULL DEFAULT 'compliance_list',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.aml_blocked_addresses ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.aml_blocked_addresses FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.aml_blocked_addresses TO service_role;

CREATE INDEX IF NOT EXISTS idx_aml_blocked_addresses_active
  ON public.aml_blocked_addresses(network, address)
  WHERE active = true;

COMMIT;
