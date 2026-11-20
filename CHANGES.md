# NTPS Production Hardening Changelog (`CHANGES.md`)

## Phase 1.1 — Audit & Harden Row Level Security (RLS)

### Summary of Changes

1. **Database Migration (`supabase/migrations/001_harden_rls.sql`)**
   - *Rationale:* `supabase/schema.sql` (left untouched per migration rules) relied solely on RLS policies while leaving default PostgreSQL table privileges open (`PUBLIC` / `anon` / `authenticated`), contained 12 over-permissive `authenticated` write policies that allowed direct PostgREST bypasses, and omitted `REVOKE EXECUTE ... FROM PUBLIC, anon` on 9 of the 10 RPCs.
   - **Table Privileges Hardening:** Explicitly ran `REVOKE ALL` on all 11 core tables (`terminals`, `wallets`, `journal_entries`, `ledger_postings`, `transactions`, `whitelist_addresses`, `invoices`, `trading_accounts`, `audit_logs`, `deposit_addresses`, `withdrawal_requests`) from `PUBLIC`, `anon`, and `authenticated`. Granted `SELECT` only to `authenticated`, and `ALL` to `service_role`.
   - **Safe `anon` Read Surface:** Added `public.public_system_info` view exposing non-PII protocol metadata (`supported_assets`, `supported_networks`, `terminal_id_format`, `live_chain_settlement_network`) with `GRANT SELECT` to `anon, authenticated, service_role`.
   - **Closed Direct-Write Bypass Policies (Dropped 12 Policies):**
     - `withdrawal_requests_insert_own` — prevented `authenticated` from inserting `state = 'approved'` directly and bypassing compliance review.
     - `trading_accounts_insert_own` — prevented `authenticated` from forging arbitrary `balance`/`free_margin` rows and draining them via `transfer_trading_bridge`.
     - `terminals_insert_own`, `terminals_update_own` — prevented self-unfreezing locked terminals or raising `daily_limit_usd` / `per_tx_limit_usd` above caps.
     - `whitelist_insert_own`, `whitelist_update_own`, `whitelist_delete_own` — prevented TOCTOU address swaps between withdrawal approval and TRON worker broadcast.
     - `invoices_insert_own`, `invoices_update_own` — prevented tampering with invoice status/amount outside `pay_invoice_atomic`.
     - `deposit_addresses_insert_own`, `deposit_addresses_update_own` — routed watch-address registration through validated server logic + audit logging.
     - `audit_logs_insert_own` — prevented client-forged compliance log entries.
   - **Added 4 Hardened `SECURITY DEFINER` RPCs (`SET search_path = public`):**
     - `register_deposit_address(p_wallet_id, p_network, p_address)`
     - `update_sub_terminal_policy(p_terminal_id, p_status, p_daily_limit_usd, p_per_tx_limit_usd, p_allowed_assets)`
     - `add_whitelist_address(p_terminal_id, p_label, p_asset, p_network, p_address)`
     - `create_invoice_atomic(p_terminal_id, p_payer_terminal_id, p_asset, p_amount, p_description, p_expires_at, p_invoice_number, p_signed_uri, p_signature)`
   - **RPC Privilege Lock:** Revoked `EXECUTE` from `PUBLIC` and `anon` across all 14 functions in `public` schema (`credit_crypto_deposit` strictly `service_role`; all other 13 RPCs `authenticated, service_role`).

2. **Frontend Live-Mode Adapter (`src/lib/ledgerEngine.ts`)**
   - *Rationale:* Aligned `ensureDepositAddress`, `updateSubTerminalPolicy`, `addWhitelistDestination`, and `createInvoice` in live `supabase` mode to call the new `SECURITY DEFINER` RPCs instead of direct `.from(...).insert()` / `.update()`, ensuring existing features work seamlessly once `001_harden_rls.sql` is applied. Local Demo Mode (`local_demo`) remains completely unchanged.

3. **Automated `anon`-Key Verification Script (`supabase/tests/rls_anon_write_test.mjs`)**
   - *Rationale:* Provides a repeatable `anon`-key test suite probing direct `INSERT`/`UPDATE`/`DELETE` across sensitive tables, `anon` RPC execution attempts, `public_system_info` safe reads, and `wallets` read isolation.

---

### Manual Test Script — Phase 1.1

1. **Before running migration `001_harden_rls.sql`** (against your Supabase project with `schema.sql` applied):
   ```bash
   SUPABASE_URL="https://<your-project>.supabase.co" \
   SUPABASE_ANON_KEY="<your-anon-key>" \
   node supabase/tests/rls_anon_write_test.mjs
   ```
   - Expected: Direct `anon` writes fail due to missing RLS policies (`42501: new row violates row-level security policy` or `0` rows updated), and `SELECT public_system_info` returns `42P01 / PGRST205` (view does not exist yet).

2. **Apply migration `001_harden_rls.sql`** in Supabase SQL Editor (or `supabase db push`).

3. **After running migration `001_harden_rls.sql`**:
   ```bash
   SUPABASE_URL="https://<your-project>.supabase.co" \
   SUPABASE_ANON_KEY="<your-anon-key>" \
   node supabase/tests/rls_anon_write_test.mjs
   ```
   - Expected:
     - All 13 direct `anon` write probes (`wallets`, `ledger_postings`, `transactions`, `journal_entries`, `withdrawal_requests`, `deposit_addresses`, `terminals`, `trading_accounts`, `whitelist_addresses`, `invoices`, `audit_logs`) fail immediately at the PostgreSQL privilege layer (`42501: permission denied for table ...`).
     - `anon` RPC probes (`bootstrap_user_terminal`, `credit_crypto_deposit`) fail with `42501: permission denied for function ...`.
     - `SELECT public_system_info` returns `1 row` (`PASS (SAFE READ)`).
     - `SELECT wallets` is rejected (`42501: permission denied for table wallets`).

4. **Verify Frontend & Local Demo Mode**:
   ```bash
   npm run lint
   npm run build
   ```
   - Launch `npm run dev`, confirm Local Demo Mode works end-to-end, and if connected to live Supabase, sign in and verify registering a watch address, creating an invoice, adding a whitelist address, and updating a sub-terminal policy succeed via the new RPCs.

---

## Phase 1.2 — Implement Real 2FA (TOTP Enrollment, Server Verification & Lockout)

### Summary of Changes

1. **Database Migration (`supabase/migrations/002_real_2fa_totp.sql`)**
   - *Rationale:* Previously, `TwoFactorModal.tsx` accepted any 6-digit string and displayed a hardcoded `DEMO_TOTP = '482910'` auto-fill button without server-side verification.
   - **Internal Encryption Key Vault (`ntps_internal.vault_keys`):** Created a non-API schema (`ntps_internal`, excluded from PostgREST exposure) storing a 256-bit `totp_master_key` (with optional `app.settings.totp_encryption_key` GUC override).
   - **RFC 6238 Server-Side Verifier (`ntps_internal.base32_decode`, `ntps_internal.verify_totp_secret`):** Computes HMAC-SHA1 over 30-second time steps with a ±1 step drift window using `pgcrypto` (`extensions.hmac`).
   - **Encrypted Factor Storage (`public.user_totp_factors`):** Stores `encrypted_secret BYTEA` (`pgp_sym_encrypt(..., 'cipher-algo=aes256')`), `enabled`, `failed_attempts`, `locked_until`, `enrolled_at`, `last_verified_at`, and `updated_at` with RLS enabled and ALL direct privileges revoked from `PUBLIC`, `anon`, and `authenticated`.
   - **Three `SECURITY DEFINER` RPCs (`SET search_path = public, extensions, ntps_internal`):**
     - `get_totp_status()` — returns enrollment state, failed attempt count, and active lockout countdown without ever returning the raw secret.
     - `enroll_user_totp(p_secret, p_initial_code)` — verifies the user's first 6-digit authenticator code server-side before AES-256 encrypting and persisting the factor; logs `TOTP_ENROLLED` in `audit_logs`.
     - `verify_user_totp(p_code, p_action_label)` — verifies TOTP codes server-side and enforces lockout after **5 failed attempts → 15-minute lock**; logs `TOTP_VERIFIED`, `TOTP_FAILED_ATTEMPT`, `TOTP_LOCKOUT_TRIGGERED`, and `TOTP_LOCKED_ATTEMPT` in `audit_logs`.

2. **TOTP Helper & Local Demo Guard (`src/lib/totp.ts`)**
   - Uses `otplib` (`generateSecret`, `generateURI`) and `qrcode` (`QRCode.toDataURL`) to generate 160-bit Base32 enrollment secrets and QR codes client-side solely during initial enrollment, discarding the secret immediately once encrypted on-server.
   - Provides Supabase RPC wrappers (`fetchTotpStatus`, `enrollUserTotp`, `verifyUserTotp`).
   - Provides a cryptographically random 6-digit challenge generator (`generateRandomDemoOtp`) and 5-attempt / 15-minute lockout guard (`readDemoTwoFactorGuard`, `recordDemoTwoFactorFailure`, `clearDemoTwoFactorGuard`) for Local Demo Mode.

3. **Modal, Context & Audit Logging (`src/components/TwoFactorModal.tsx`, `src/context/TwoFactorContext.tsx`, `src/lib/ledgerEngine.ts`, `src/hooks/useNtpsLedger.ts`, `src/App.tsx`)**
   - **Removed** `DEMO_TOTP = '482910'` and the quick auto-fill button.
   - **Live Supabase Mode (`authMode === 'supabase'`):** Automatically checks `get_totp_status()`. Unenrolled accounts are presented with a QR code + Base32 setup key enrollment step; enrolled accounts verify directly against `verify_user_totp` with live lockout countdowns.
   - **Local Demo Mode (`authMode === 'local_demo'`):** Displays a clearly-labeled **Simulated 2FA — Local Demo Mode** banner with a random session challenge code (must be typed manually), enforces the same 5-attempt / 15-minute lockout behavior, and logs simulated 2FA outcomes (`TOTP_SIMULATED_VERIFIED`, `TOTP_SIMULATED_FAILED`, `TOTP_SIMULATED_LOCKOUT`, `TOTP_SIMULATED_LOCKED_ATTEMPT`) to `audit_logs`. Resetting the demo ledger clears any demo lockout state.

---

### Manual Test Checklist — Phase 1.2

1. **Local Demo Mode Verification (`npm run dev`):**
   - Open any 2FA-protected flow (`Internal Transfer`, `Withdraw`, `Pay Invoice`, or `Trading Margin Bridge`).
   - Verify the **Simulated 2FA — Local Demo Mode** banner appears with a freshly generated random 6-digit session code and **no** auto-fill button or hardcoded `'482910'`.
   - Enter an incorrect 6-digit code 4 times -> verify remaining attempt counter decrements (`4/5`, `3/5`, `2/5`, `1/5`) and `TOTP_SIMULATED_FAILED` entries appear in `Admin & Compliance -> Audit Log`.
   - Enter a 5th wrong code -> verify **15-minute lockout** activates with a live `MM:SS` countdown, submit button disables, and `TOTP_SIMULATED_LOCKOUT` is logged.
   - Click **Reset Demo Ledger** in the sidebar -> verify lockout clears and entering the exact displayed session code succeeds and logs `TOTP_SIMULATED_VERIFIED`.

2. **Live Supabase Mode Verification (after applying `002_real_2fa_totp.sql`):**
   - Apply `supabase/migrations/002_real_2fa_totp.sql` in Supabase SQL Editor (ensure `pgcrypto` extension is enabled).
   - Sign in with a Supabase account that has no enrolled factor and trigger a 2FA action -> verify the QR enrollment screen appears.
   - Scan the QR code with Google Authenticator / Authy / 1Password, enter an invalid code first -> verify enrollment rejects without saving; then enter the live 6-digit code -> verify activation and transaction confirmation succeed.
   - Trigger another 2FA action -> verify the QR screen no longer appears (prompts directly for 6-digit code), confirm `SELECT * FROM public.user_totp_factors;` is denied for `authenticated`/`anon` roles, and test 5 wrong codes -> verify `15:00` server-enforced lockout triggers and persists across page reloads.

---

## Phase 1.3 — Hot Wallet Key Protection & Broadcast Auditability

### Summary of Changes

1. **Frontend Secret & Bundle Isolation Audit (`src/`, `vite.config.ts`)**
   - Audited all files under `src/` and `vite.config.ts` for references to `HOT_WALLET_PRIVATE_KEY`, `HOT_WALLET_PRIVATE_KEY_ENCRYPTED`, `HOT_WALLET_DECRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TRONGRID_API_KEY`, `tronweb`, or private-key / mnemonic strings.
   - **Result: Clean.** `src/lib/supabase.ts` reads only public `import.meta.env.VITE_SUPABASE_URL` and `import.meta.env.VITE_SUPABASE_ANON_KEY`. Vite injects no `define` secrets and excludes non-`VITE_` server env vars from client bundles. (The only `service_role` reference in `src/` is inside the SQL documentation string `SUPABASE_SQL_SCHEMA` rendered by `SchemaModal.tsx`, containing no credentials.)

2. **AES-256-GCM Encrypted Hot Wallet Key Loader (`ntps-tron-worker/src/cryptoKey.ts`, `ntps-tron-worker/src/encryptKey.ts`, `ntps-tron-worker/package.json`, `ntps-tron-worker/.env.example`)**
   - Implemented `encryptHotWalletPrivateKey` and `decryptHotWalletPrivateKey` using Node `crypto` AES-256-GCM + per-payload random 16-byte salt (`scryptSync`), 12-byte IV, and 16-byte authentication tag (`ntps:v1:aes256gcm:<salt>:<iv>:<tag>:<ciphertext>`).
   - Implemented `resolveHotWalletPrivateKey()` in `ntps-tron-worker/src/index.ts`:
     - **Primary (Recommended):** Decrypts `HOT_WALLET_PRIVATE_KEY_ENCRYPTED` using `HOT_WALLET_DECRYPTION_KEY`.
     - **Backward-Compatible Migration Fallback:** Accepts plaintext `HOT_WALLET_PRIVATE_KEY` for local/migration environments while emitting `[SECURITY WARNING]` on startup.
     - Zero key material is ever logged or included in thrown error messages.
   - Added `npm run encrypt-key` script (`src/encryptKey.ts`) to encrypt raw 64-hex TRON private keys into the `.env` envelope format.
   - Updated `ntps-tron-worker/.env.example` with `HOT_WALLET_PRIVATE_KEY_ENCRYPTED` and `HOT_WALLET_DECRYPTION_KEY`.

3. **Hash-Chained Withdrawal Broadcast Audit Logging (`ntps-tron-worker/src/auditLog.ts`, `ntps-tron-worker/src/index.ts`)**
   - Added `recordWorkerAuditLog()` writing SHA-256 hash-chained (`0x` prefix, linked via `prev_hash` to the latest `audit_logs.row_hash`) records as actor `ntps-tron-worker`.
   - Every withdrawal broadcast attempt in `processApprovedWithdrawals()` now logs:
     - `WITHDRAWAL_BROADCAST_STARTED` (`info`) — immediately after claiming the `approved -> broadcast` state lock.
     - `WITHDRAWAL_BROADCAST_CONFIRMED` (`info`) — on successful TRC-20 broadcast, including the confirmed `tx_hash`.
     - `WITHDRAWAL_BROADCAST_FAILED` (`critical`) — on failure when returning the request to `review`, passing errors through `sanitizeErrorMessage()` to redact any 64-char hex or key material.

---

### Manual Test Checklist — Phase 1.3

1. **Generate Encrypted Key Envelope (`ntps-tron-worker/`):**
   ```bash
   cd ntps-tron-worker
   npm install
   npm run encrypt-key
   ```
   - Enter your 64-hex TRON private key and a strong `HOT_WALLET_DECRYPTION_KEY` (≥ 16 chars; 32+ recommended).
   - Copy the generated `HOT_WALLET_PRIVATE_KEY_ENCRYPTED="ntps:v1:aes256gcm:..."` into `ntps-tron-worker/.env`, set `HOT_WALLET_DECRYPTION_KEY`, and remove plaintext `HOT_WALLET_PRIVATE_KEY`.

2. **Verify Startup Key Modes & Secret Redaction:**
   - Start worker with `HOT_WALLET_PRIVATE_KEY_ENCRYPTED` + `HOT_WALLET_DECRYPTION_KEY` -> confirm console logs `[SECURITY] TRON hot wallet key decrypted via AES-256-GCM envelope.` and `(keySource=encrypted)` with **no** private key output.
   - Temporarily test a wrong `HOT_WALLET_DECRYPTION_KEY` -> confirm startup fails cleanly without leaking ciphertext or key values.
   - Temporarily test plaintext `HOT_WALLET_PRIVATE_KEY` only -> confirm backward compatibility works and prints `[SECURITY WARNING]`.

3. **Verify Broadcast Audit Trail:**
   - Approve a small `USDT (TRC20)` withdrawal (or trigger a simulated failure on Shasta/Nile testnet) and inspect `public.audit_logs` (or `Admin & Compliance -> Audit Log` in the UI):
     - Confirm `WITHDRAWAL_BROADCAST_STARTED` followed by `WITHDRAWAL_BROADCAST_CONFIRMED` (with `tx_hash`) or `WITHDRAWAL_BROADCAST_FAILED` (`critical`, sanitized error) appear with valid `prev_hash` → `row_hash` chaining.

4. **Verify Frontend Bundle Isolation:**
   - Run `npm run build` at repo root and confirm `grep -rn "HOT_WALLET_PRIVATE_KEY" dist/` returns no matches.

---

## Phase 2 — Database-Level Data Integrity, Server-Side Limits & External Asset Rates

### Summary of Changes

1. **PostgreSQL Double-Entry & Immutability Migration (`supabase/migrations/003_ledger_integrity_and_limits.sql`)**
   - **Phase 2.1 — Database-Enforced Ledger Invariants:**
     - **Non-Negative Wallet Checks:** Added idempotent named CHECK constraints (`wallets_available_non_negative`, `wallets_pending_non_negative`, `wallets_locked_non_negative`) enforcing `>= 0` on `public.wallets`.
     - **Append-Only Ledger Protection:** Revoked `UPDATE, DELETE, TRUNCATE` on `public.ledger_postings` and `public.journal_entries` from `PUBLIC, anon, authenticated` and added `BEFORE UPDATE OR DELETE` triggers (`trg_ledger_postings_append_only`, `trg_journal_entries_append_only`) raising SQLSTATE `42501` even for elevated roles.
     - **Deferred Zero-Sum Constraint Trigger (`trg_ledger_postings_zero_sum`):** Created `CONSTRAINT TRIGGER ... AFTER INSERT ON public.ledger_postings DEFERRABLE INITIALLY DEFERRED` backed by `ntps_internal.enforce_journal_zero_sum()`, enforcing both `COUNT(*) >= 2` and `ABS(SUM(amount)) <= 0.00000001` per `(journal_id, asset)` at commit time.
     - **Hardened `verify_ledger_invariant()`:** Checks both zero-sum balance and minimum 2-leg structure across user-scoped journals (and supports `service_role` global audits).
   - **Phase 2.2 — Server-Side Limits & External `asset_rates` Table:**
     - **External Rates Table (`public.asset_rates`):** Stores `USDT`, `BTC`, and `ETH` USD valuation rates, `change_24h_pct`, `source`, and `fetched_at` with seeded baseline rows, `SELECT`-only RLS for `anon`/`authenticated`, Realtime publication, `get_asset_usd_rate(p_asset)`, and `service_role`-only `refresh_asset_rates(...)` RPC.
     - **Server-Side Policy & Limit Enforcement:** Updated `execute_internal_transfer`, `request_crypto_withdrawal`, and `transfer_trading_bridge` (`SECURITY DEFINER`, `SET search_path = public`) to enforce terminal `allowed_assets`, `per_tx_limit_usd`, and rolling 24-hour `daily_limit_usd` directly in PostgreSQL using live `public.asset_rates`.

2. **CoinGecko Spot Rate Refresh Edge Function (`supabase/functions/refresh-asset-rates/index.ts`)**
   - Fetches live spot USD prices for `bitcoin`, `ethereum`, and `tether` from CoinGecko, validates positive finite values, and updates `public.asset_rates` atomically via `refresh_asset_rates` using `SUPABASE_SERVICE_ROLE_KEY` (with optional `RATE_REFRESH_SECRET` bearer guard for scheduled `pg_cron` invocations).

3. **Frontend Live Rate & Ledger Audit Integration (`src/types/ntps.ts`, `src/lib/ledgerEngine.ts`, `src/hooks/useNtpsLedger.ts`, `src/components/*`, `src/App.tsx`)**
   - `loadLiveSupabaseLedgerState()` queries `public.asset_rates` in live mode (with graceful fallback to `ASSET_USD_RATES` if migration `003` is pending) and computes USD portfolio valuations, 24h withdrawal usage, and risk tiers from DB rates; `useNtpsLedger` subscribes to `asset_rates` realtime updates.
   - Local Demo Mode retains `ASSET_USD_RATES` (`local_demo`) unchanged.
   - `LedgerAuditView.tsx` now surfaces a live **Double-Entry Invariant (`SUM = 0`)** verification banner displaying journal group count, posting count, imbalance status, verification source (`PostgreSQL RPC` vs `Local Engine Check`), and an interactive **Verify Invariant** button.

---

### Manual Test Checklist — Phase 2

1. **Apply Migration `003_ledger_integrity_and_limits.sql`:**
   - Run `supabase/migrations/003_ledger_integrity_and_limits.sql` in Supabase SQL Editor.

2. **Verify PostgreSQL Rejects Unbalanced Journals & Mutations (SQL Editor):**
   ```sql
   -- Test A: Single-leg or unbalanced journal MUST FAIL at COMMIT with SQLSTATE 23514
   BEGIN;
     INSERT INTO public.journal_entries (kind, idempotency_key, memo)
     VALUES ('internal_transfer', 'test_unbalanced_' || gen_random_uuid(), 'Negative test');
     INSERT INTO public.ledger_postings (journal_id, account_ref, asset, amount)
     SELECT id, 'wallet:00000000-0000-0000-0000-000000000001', 'USDT', 100
     FROM public.journal_entries ORDER BY created_at DESC LIMIT 1;
   COMMIT;
   -- Expected: ERROR: Double-entry invariant failed ... only 1 posting(s) recorded (23514)

   -- Test B: Two imbalanced legs MUST FAIL at COMMIT with SQLSTATE 23514
   BEGIN;
     WITH je AS (
       INSERT INTO public.journal_entries (kind, idempotency_key, memo)
       VALUES ('internal_transfer', 'test_skew_' || gen_random_uuid(), 'Negative test')
       RETURNING id
     )
     INSERT INTO public.ledger_postings (journal_id, account_ref, asset, amount)
     SELECT id, 'wallet:a', 'USDT', -100 FROM je
     UNION ALL
     SELECT id, 'wallet:b', 'USDT', 150 FROM je;
   COMMIT;
   -- Expected: ERROR: Double-entry invariant failed ... SUM(amount) = 50, expected 0 (23514)

   -- Test C: Append-only UPDATE/DELETE MUST FAIL with SQLSTATE 42501
   DELETE FROM public.ledger_postings WHERE id = (SELECT id FROM public.ledger_postings LIMIT 1);
   -- Expected: ERROR: Table ledger_postings is strictly append-only; DELETE operations are prohibited.
   ```

3. **Verify Server-Side Limit Enforcement:**
   - Call `request_crypto_withdrawal` or `execute_internal_transfer` directly via RPC with an amount exceeding `per_tx_limit_usd` or remaining 24h `daily_limit_usd` (or a disallowed asset) -> confirm PostgreSQL rejects the request even when bypassing UI validation.

4. **Verify External Rates & Ledger Audit Screen:**
   - Update `public.asset_rates` via `refresh_asset_rates(95000, 3400, 1.0, 'coingecko')` (or deploy/invoke `supabase/functions/refresh-asset-rates`) and confirm the Dashboard displays `[Feed: coingecko]` with updated valuations.
   - Navigate to **Ledger Audit Log** and confirm the **Double-Entry Invariant (`SUM = 0`)** banner reports `BALANCED · APPEND-ONLY` in both Live Mode and Local Demo Mode.

---

## Phase 3 — Real Realtime Updates (`useRealtimeLedger` & Live Header Indicator)

### Summary of Changes

1. **Dedicated Realtime Synchronization Hook (`src/hooks/useRealtimeLedger.ts`)**
   - Extracted and hardened Supabase Realtime channel lifecycle into `useRealtimeLedger({ userId, authMode, ledgerQueryKey })`, exposing `connectionState` (`'connected' | 'disconnected' | 'demo'`) and `lastEventAt`.
   - Subscribes via `postgres_changes` across `wallets`, `transactions`, `withdrawal_requests`, `invoices`, `deposit_addresses`, `terminals`, `trading_accounts`, `asset_rates`, and `audit_logs`.
   - **Coalesced Debounced Refetch (120 ms):** Groups rapid multi-table Postgres writes from a single atomic RPC or TRON worker settlement into one clean React Query invalidation.
   - **Duplicate-Channel & Race-Condition Protection:** Tracks the active `RealtimeChannel` ref, disposes prior channels before creating a new one on auth/user transitions, clears pending debounce timers on unmount, and listens to browser `online`/`offline` events to catch up on reconnect.

2. **Ledger Hook Integration (`src/hooks/useNtpsLedger.ts`)**
   - Replaced the inline `useEffect` subscription with `useRealtimeLedger` and exposed `realtimeStatus` and `lastRealtimeSyncAt` to the workspace UI.

3. **Workspace Header Live Connection Indicator (`src/App.tsx`)**
   - Added a header connection status indicator reflecting `Realtime: Live` (`connected`), `Realtime: Reconnecting` (`disconnected`), or `Demo Mode` (`demo`).
   - Clicking the indicator in live mode manually triggers an immediate React Query resync (`ledgerQuery.refetch()`); clicking it in Demo Mode opens the Supabase Auth & Connection modal.

---

### Manual Test Checklist — Phase 3

1. **Local Demo Mode Indicator:**
   - Start `npm run dev` without Supabase credentials (or toggle Local Preview Mode) -> confirm the header indicator shows `Demo Mode` (`#F5C542` dot) and no WebSocket channels are opened.

2. **Live Supabase Realtime Subscription & Live Updates:**
   - Sign in with a Supabase session and verify the header transitions to `Realtime: Live` (`emerald` dot).
   - With two browser tabs signed in as the same operator (or via `ntps-tron-worker` / SQL Editor calling `credit_crypto_deposit` or updating a `withdrawal_requests` row):
     - Confirm wallet balances, transaction rows, and withdrawal queue statuses update automatically in the UI within ~150 ms with **zero manual page reload**.

3. **Disconnect / Mode Switch Resilience:**
   - Toggle browser DevTools to **Offline** -> verify the header changes to `Realtime: Reconnecting`. Restore **Online** -> confirm it reconnects to `Realtime: Live` and triggers a catch-up refetch.
   - Sign out or switch between Supabase mode and Local Demo Mode repeatedly -> confirm zero duplicate Realtime channels accumulate and local demo state remains cleanly isolated.

---

## Phase 4 — TRON Worker Reliability (Retries, Cursors, Alerting & AML)

### Summary of Changes

1. **Database Migration (`supabase/migrations/004_worker_reliability_and_aml.sql`)**
   - **Withdrawal Retry & Duplicate-Payout Columns (`public.withdrawal_requests`):** Added `attempt_count`, `last_attempt_at`, `last_error`, and `tx_hash_candidate`.
   - **Persisted Deposit Cursors (`public.deposit_addresses`, `public.worker_checkpoints`):** Added `deposit_addresses.last_polled_timestamp_ms` and `worker_checkpoints` (`service_role` only) so TronGrid `min_timestamp` survives restarts cleanly.
   - **AML Blocked Address Registry (`public.aml_blocked_addresses`):** Stores restricted destination addresses with `risk_level` (`high`, `sanctioned`, `blocked`), `reason`, and `active` flag (`service_role` only).

2. **Retry with Exponential Backoff & Duplicate-Payout Guard (`ntps-tron-worker/src/index.ts`)**
   - **Pre-Broadcast Guard:** Skips rebroadcast and reconciles state if `transactions.tx_hash`, `withdrawal_requests.tx_hash_candidate`, or `transactions.status = 'completed'` is already set, logging `WITHDRAWAL_DUPLICATE_PAYOUT_PREVENTED`.
   - **3-Attempt Exponential Backoff:** Retries transient broadcast/DB failures up to `MAX_BROADCAST_ATTEMPTS = 3` (`WITHDRAWAL_RETRY_BASE_MS * 2^(attempt-1)` + jitter), caching `obtainedTxHash` in memory and in `tx_hash_candidate` immediately after `.send()` so a post-broadcast DB error retries only confirmation persistence and **never** sends a duplicate on-chain transfer.
   - Logs `WITHDRAWAL_BROADCAST_RETRY` (`warn`) on transient attempt failure and `WITHDRAWAL_BROADCAST_FAILED` (`critical`) when returning an exhausted request to `review`.

3. **Persisted `min_timestamp` Deposit Polling (`ntps-tron-worker/src/index.ts`)**
   - Queries TronGrid with `&limit=50&order_by=block_timestamp,asc&min_timestamp=<last_polled_timestamp_ms>`, processes transactions in ascending timestamp order, halts cursor advancement if an RPC credit fails, and persists `last_polled_timestamp_ms` + `worker_checkpoints` on progress.
   - Gracefully falls back to in-memory cursors if migration `004` has not yet been applied.

4. **Failure Alerting (`ntps-tron-worker/src/alerts.ts`, `ntps-tron-worker/.env.example`)**
   - Added `sendWorkerAlert()` supporting HTTP JSON webhooks (`ALERT_WEBHOOK_URL`) and Supabase Edge Functions (`ALERT_EDGE_FUNCTION_URL` authenticated via `SUPABASE_SERVICE_ROLE_KEY`), with 5-minute cooldown deduplication for repeated polling outages (`POLL_FAILURE_ALERT_THRESHOLD`, default `3`).
   - Fires immediate critical alerts on `WITHDRAWAL_BROADCAST_EXHAUSTED`, `WITHDRAWAL_AML_BLOCKED`, and `DEPOSIT_CREDIT_FAILED`.

5. **Lightweight AML Destination Screening (`ntps-tron-worker/src/aml.ts`)**
   - Added `screenWithdrawalDestination()` running prior to every broadcast to validate TRON Base58Check format (`tronWeb.isAddress`), built-in TRON burn blackholes (`T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`), env-configured `AML_BLOCKED_ADDRESSES`, and `public.aml_blocked_addresses`.
   - Blocked destinations return to `review`, log `WITHDRAWAL_AML_BLOCKED` (`critical`) in `audit_logs`, and emit a critical alert.

---

### Manual Test Checklist — Phase 4

1. **Apply Migration `004_worker_reliability_and_aml.sql`:**
   - Run `supabase/migrations/004_worker_reliability_and_aml.sql` in Supabase SQL Editor.

2. **Configure Worker Env (`ntps-tron-worker/.env`):**
   - Set `WITHDRAWAL_RETRY_BASE_MS="2000"`, `POLL_FAILURE_ALERT_THRESHOLD="3"`, and optionally `ALERT_WEBHOOK_URL`, `ALERT_EDGE_FUNCTION_URL`, and `AML_BLOCKED_ADDRESSES`.

3. **Verify Persisted `min_timestamp` Deposit Polling:**
   - Start `ntps-tron-worker` and send a test TRC-20 USDT deposit (Nile/Shasta testnet or mainnet). Confirm `deposit_addresses.last_polled_timestamp_ms` and `worker_checkpoints.cursor_ms` update to the transaction's `block_timestamp`, restart the worker, and confirm polling resumes from that `min_timestamp` without duplicating or missing deposits.

4. **Verify Duplicate-Payout Guard & Exponential Backoff:**
   - Approve a withdrawal whose `transactions.tx_hash` (or `withdrawal_requests.tx_hash_candidate`) is already populated -> confirm worker logs `WITHDRAWAL_DUPLICATE_PAYOUT_PREVENTED` and does **not** call `contract.transfer(...).send()`.
   - Simulate an RPC failure (e.g., invalid TronGrid URL or insufficient TRX energy on testnet) -> confirm 3 attempts run with exponential backoff (`2s`, `4s`), `attempt_count` increments, `WITHDRAWAL_BROADCAST_RETRY` and `WITHDRAWAL_BROADCAST_FAILED` appear in `audit_logs`, request returns to `review`, and `ALERT_WEBHOOK_URL` receives `WITHDRAWAL_BROADCAST_EXHAUSTED`.

5. **Verify AML Destination Screening:**
   - Insert a test TRON address into `AML_BLOCKED_ADDRESSES` (or `public.aml_blocked_addresses`), queue/approve a withdrawal to that address, and confirm broadcast is blocked with `WITHDRAWAL_AML_BLOCKED` logged in `audit_logs` and critical alert dispatched.


---

## Phase 5 — Final Cleanup, Mode Clarity & Documentation

### Summary of Changes

1. **AI Studio Leftover Removal (`metadata.json`, `.env.example`, `package.json`, `vite.config.ts`)**
   - Deleted `/metadata.json`.
   - Removed `GEMINI_API_KEY` and AI Studio / Cloud Run boilerplate comments from `.env.example`, leaving clean NTPS Supabase configuration variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `APP_URL`).
   - Updated `package.json` metadata (`"name": "nova-terminal-payment-system"`, `"version": "1.0.0"`) and removed the unused `@google/genai` dependency.
   - Cleaned template-specific comments in `vite.config.ts` while preserving build asset copying and optional `DISABLE_HMR` support.

2. **Production Documentation (`README.md`)**
   - Authored a complete `README.md` with:
     - End-to-end ASCII architecture diagram spanning the React SPA, Supabase (Auth, RLS, Double-Entry PostgreSQL Triggers & RPCs, Realtime, Edge Functions), and `ntps-tron-worker` (AES-256-GCM key protection, TronGrid cursor polling, AML screening, exponential backoff broadcaster, and alerting).
     - Explicit network scope matrix clarifying that **USDT (`TRC20`)** is live on-chain via `ntps-tron-worker`, `NTPS_INTERNAL` settles natively inside the ledger, and `ERC20`, `BTC`, `ETH`, and `ARBITRUM` are **simulated / ledger-only rails**.
     - Local setup, migration sequence (`001`–`004`), environment variable reference, and production deployment steps.

3. **Explicit Demo Mode Badge & Simulated Network Flags**
   - **Header Badge (`src/App.tsx`):** Updated the Local Demo Mode header status badge to explicitly display **`DEMO MODE — local data`** so operators cannot confuse sandboxed local state with a live Supabase connection.
   - **Code & UI Simulated Rail Flags (`src/types/ntps.ts`, `src/lib/ledgerEngine.ts`, `src/components/DashboardView.tsx`, `src/components/DepositWithdrawView.tsx`):**
     - Added `LIVE_ONCHAIN_NETWORKS`, `SIMULATED_NETWORKS`, and `isSimulatedNetwork()` helper in `src/lib/ledgerEngine.ts` with explicit JSDoc documentation.
     - Tagged simulated rails with `(Sim)` vs `· Live` on network selectors and added clear inline warning banners in `DepositWithdrawView.tsx` (both Deposit and Withdraw views) plus updated asset subtitles in `DashboardView.tsx`.

---

### Final Verification Checklist (Phases 1–5)

1. **Cleanliness & Bundle Hygiene:**
   - Confirm `metadata.json` is deleted and `.env.example` contains no `GEMINI_API_KEY` or AI Studio references.
   - Run `npm run build` and verify no `SUPABASE_SERVICE_ROLE_KEY`, `HOT_WALLET`, or `TOTP` secrets appear in `dist/`.
2. **Mode & Network Clarity:**
   - Launch without Supabase credentials -> confirm header displays `DEMO MODE — local data` and Local Demo flows work without errors.
   - Open **Deposit & Withdraw** -> verify `TRC-20 · Live` vs `(Sim)` labels and simulated rail notice banners appear for `ERC20`, `BTC`, `ETH`, and `ARBITRUM`.
3. **Database & Worker Readiness:**
   - Apply `supabase/schema.sql` followed by `001` through `004` in order; verify `verify_ledger_invariant()` passes (`ok = true`).
   - Encrypt hot wallet private key (`npm --prefix ntps-tron-worker run encrypt-key`), build worker (`npm --prefix ntps-tron-worker run build`), and validate testnet deposit/withdrawal round-trip.

---

## Admin RBAC Enhancement (`005_admin_rbac.sql`)

### Summary of Changes

1. **Database Migration (`supabase/migrations/005_admin_rbac.sql`)**
   - Created `public.app_admins` (`user_id`, `role` in `ops | compliance | treasury | super_admin`, `is_active`, `created_at`) with RLS enabled and `service_role`-only write access (`authenticated` can only `SELECT` its own row).
   - Added `public.is_ntps_admin(required_roles)` and `public.get_my_admin_role()` (`SECURITY DEFINER`, `SET search_path = public`).
   - Added admin read-only `SELECT` RLS policies (`*_select_admin`) across operational tables so separated compliance/ops staff can inspect terminals and flagged withdrawals.
   - Replaced `review_withdrawal_request(p_transaction_id, p_action, p_reason)` and `update_terminal_status_admin(p_terminal_id, p_status, p_reason)` to require an active `ops`, `compliance`, or `super_admin` role in `public.app_admins`, enforce a non-empty audit reason, and record the operator role + reason in hash-chained `audit_logs`.

2. **Frontend RBAC Integration (`src/types/ntps.ts`, `src/lib/ledgerEngine.ts`, `src/hooks/useNtpsLedger.ts`, `src/components/AdminPanelView.tsx`, `src/App.tsx`)**
   - Added `AdminRole`, `AdminProfile`, `fetchAdminProfile()`, and `adminProfileQuery` (falling back safely to a simulated `super_admin` profile in Local Demo Mode).
   - Added an RBAC role status banner and a mandatory compliance review reason input in `AdminPanelView.tsx`, surfacing clear permission error alerts when an account lacks `ops`, `compliance`, or `super_admin` authorization.
