# NOVA Terminal Payment System (NTPS)

An institutional multi-asset settlement platform built on a **ledger-first double-entry architecture** with Crockford Base32 terminal addressing (`NT-OMEGA-...`), hierarchical sub-terminal policy controls, four-eyes compliance review, TOTP 2FA verification, and live **USDT (TRC-20)** on-chain settlement.

---

## System Architecture

```text
+-----------------------------------------------------------------------------+
|                        React 19 + TypeScript + Vite SPA                     |
|                                                                             |
|  - Terminal Workspace & Sub-Terminals (Crockford Base32 NT-OMEGA-...)       |
|  - Double-Entry Preview Engine (`src/lib/ledgerEngine.ts`)                  |
|  - Real TOTP 2FA Modal (`otplib` + `qrcode`, server-verified in live mode)  |
|  - `useSupabaseAuth` -> Live Session vs. Sandboxed `DEMO MODE — localStorage` |
|  - `useRealtimeLedger` -> Debounced WebSocket sync (`Realtime: Live`)       |
+--------------------------------------+--------------------------------------+
                                       |
          HTTPS (Supabase JS SDK)      |      WSS (Supabase Realtime)
          RLS-enforced SELECT + RPCs   |      `postgres_changes`
                                       v
+-----------------------------------------------------------------------------+
|                            Supabase Platform                                |
|                                                                             |
|  +-----------------------+    +------------------------------------------+  |
|  |   Supabase Auth       |    | PostgreSQL + RLS + Double-Entry Engine   |  |
|  |   auth.uid() JWT      |--->| - 11+ RLS tables (`001_harden_rls.sql`)  |  |
|  +-----------------------+    | - Append-only `journal_entries` &        |  |
|                               |   `ledger_postings` (SUM = 0 constraint) |  |
|  +-----------------------+    | - Server limits & `verify_ledger_invariant`|  |
|  |   Edge Functions      |    | - TOTP secrets & 5-try/15m lockout (`002`)|  |
|  | `refresh-asset-rates` |--->| - `asset_rates` external USD oracle (`003`)|  |
|  | (CoinGecko USD feed)  |    | - Worker cursors & `aml_blocked_addresses` |  |
|  +-----------------------+    +------------------------------------------+  |
+--------------------------------------^--------------------------------------+
                                       |
               Service-Role RPCs       |
               (`credit_crypto_deposit`|
                & withdrawal state)    |
                                       |
+--------------------------------------+--------------------------------------+
|                   `ntps-tron-worker` (Standalone Node Daemon)               |
|                                                                             |
|  - Hot Wallet Key Loader: AES-256-GCM envelope decryption (`cryptoKey.ts`)  |
|  - Deposit Watcher: TronGrid TRC-20 poller with persisted `min_timestamp`   |
|  - Withdrawal Broadcaster:                                                  |
|      1. Pre-broadcast duplicate-payout guard (`tx_hash` / candidate check)  |
|      2. Lightweight AML destination screening (`aml.ts`)                    |
|      3. 3-attempt exponential backoff + TronWeb TRC-20 broadcast            |
|  - Observability: Hash-chained `audit_logs` + Webhook/Edge Function alerts  |
+--------------------------------------+--------------------------------------+
                                       |
                                       v
                        TRON Blockchain (`TronGrid` / USDT TRC-20)
```

---

## Supported Networks & On-Chain Scope

| Asset | Network Rail | Status | Execution Path |
| :--- | :--- | :--- | :--- |
| **USDT** | `TRC20` (TRON) | **Live On-Chain** | Monitored and broadcast on-chain by `ntps-tron-worker` via TronGrid / TronWeb. |
| **Any** | `NTPS_INTERNAL` | **Live Ledger** | Instant atomic double-entry settlement between terminals, invoices, and trading accounts inside PostgreSQL. |
| **USDT** | `ERC20` (Ethereum) | **Simulated / Ledger-Only** | Flagged as `(Sim)` in UI. No external chain watcher or broadcaster is connected. |
| **BTC** | `BTC` (Bitcoin SegWit) | **Simulated / Ledger-Only** | Flagged as `(Sim)` in UI. Recorded in the ledger without live Bitcoin node broadcast. |
| **ETH** | `ETH` (Ethereum Mainnet) | **Simulated / Ledger-Only** | Flagged as `(Sim)` in UI. Recorded in the ledger without live EVM watcher/broadcaster. |
| **ETH** | `ARBITRUM` (Arbitrum One) | **Simulated / Ledger-Only** | Flagged as `(Sim)` in UI. Recorded in the ledger without live L2 watcher/broadcaster. |

> **Important:** In Live Supabase mode, `ntps-tron-worker` only monitors deposits and broadcasts approved withdrawals on **`USDT (TRC-20)`**. All simulated rails are explicitly labeled in the UI and code (`src/lib/ledgerEngine.ts` -> `isSimulatedNetwork`).

---

## Runtime Modes

1. **Connected Supabase Mode (`Realtime: Live`)**
   - Activated when `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are configured and an operator signs in via Supabase Auth.
   - All financial writes flow through `SECURITY DEFINER` PostgreSQL RPCs with strict RLS isolation, deferred zero-sum double-entry verification, server-enforced daily/per-tx limits, and server-side TOTP 2FA verification.
2. **Local Demo Mode (`DEMO MODE — localStorage`)**
   - Activated automatically when Supabase environment variables are absent, or manually via the Session Modal override for demos and training.
   - Displays an explicit **`DEMO MODE — localStorage`** badge in the workspace header, persists sandboxed state strictly in browser `localStorage`, and uses a locally generated random session TOTP challenge rather than live credentials or on-chain execution.

---

## Local Setup Instructions

### Prerequisites
- Node.js `>= 20` and `npm`
- A Supabase project (optional — only required for Live Mode; Local Demo Mode runs with zero external dependencies)
- A TronGrid API key and TRON hot wallet (only required for `ntps-tron-worker` TRC-20 settlement)

### 1. Frontend Setup

```bash
# Install frontend dependencies
npm install

# Optional: configure live Supabase connection (leave unset for Local Demo Mode)
cp .env.example .env.local

# Typecheck & start development server on http://localhost:3000
npm run lint
npm run dev
```

### 2. Supabase Database & Migrations (Live Mode)

Execute the base schema and all numbered migrations **in exact order** inside the Supabase SQL Editor (or via `supabase db push`):

1. `supabase/schema.sql` — Base 11 tables, indexes, and core settlement functions.
2. `supabase/migrations/001_harden_rls.sql` — Least-privilege table grants, RLS hardening, atomic RPCs (`register_deposit_address`, `update_sub_terminal_policy`, `add_whitelist_address`, `create_invoice_atomic`), and non-PII `public_system_info`.
3. `supabase/migrations/002_real_2fa_totp.sql` — Per-user `public.user_totp_factors` (pgcrypto AES-256 encrypted secrets), `get_totp_status` / `enroll_user_totp` / `verify_user_totp` RPCs, and 5-attempt / 15-minute lockout enforcement.
4. `supabase/migrations/003_ledger_integrity_and_limits.sql` — Deferred zero-sum double-entry trigger (`SUM(amount) = 0`), append-only triggers on `journal_entries` & `ledger_postings`, non-negative wallet balance checks, `verify_ledger_invariant()`, server-side limit enforcement, and `public.asset_rates`.
5. `supabase/migrations/004_worker_reliability_and_aml.sql` — Withdrawal retry/duplicate-payout columns, `worker_checkpoints` & persisted `last_polled_timestamp_ms` cursors, and `public.aml_blocked_addresses`.
6. `supabase/migrations/005_admin_rbac.sql` — Admin role registry (`public.app_admins`), `is_ntps_admin()` / `get_my_admin_role()` helpers, admin read-only RLS policies, and RBAC-enforced `review_withdrawal_request` & `update_terminal_status_admin` RPCs.
7. `supabase/migrations/006_stage0_security_hardening.sql` — Stage-0 hardening (`SYS-1`, `SYS-2`, `SYS-4`, `SYS-9`, `W-04`), enforcing four-eyes withdrawal queueing, master-locked sub-terminal cap validation, `service_role` + ownership checks on `credit_crypto_deposit`, double-credit reversal locks, and atomic worker broadcast claim + policy/24h limit enforcement (`claim_approved_withdrawal_for_broadcast`).
8. `supabase/migrations/007_stage1_validation_hardening.sql` — Stage-1 validation & serialization hardening (`SYS-7`, `SYS-8`, `SYS-10`, `W-11`), enforcing Crockford Mod-37 terminal ID validation (`is_valid_ntps_terminal_id`), per-chain address validation (`is_valid_chain_address`), `aml_blocked_addresses` validation trigger, and advisory-locked `append_worker_audit_log` RPC.
9. `supabase/migrations/008_stage2_defensive_hardening.sql` — Stage-2 worker lease hardening (`W-21`), adding atomic PgBouncer-safe `acquire_worker_lease` and `release_worker_lease` RPCs (`service_role` only) backed by `public.worker_checkpoints.metadata`.

#### Admin Authorization & Live Asset Rates (Optional)
- **Provision Admin Operators:** Grant an operator access by inserting their Supabase Auth `user_id` into `public.app_admins` (via SQL Editor or `service_role`):
  ```sql
  INSERT INTO public.app_admins (user_id, role, is_active)
  VALUES ('<operator-auth-uid>', 'compliance', true);
  ```
  Roles: `ops`, `compliance`, `treasury` (read-only for freezes/approvals), and `super_admin`.
- **Live Asset Rates:** Configure `RATE_REFRESH_SECRET` in Supabase Edge Function secrets (mandatory bearer token checked with constant-time comparison) and deploy the CoinGecko rate updater Edge Function:
  ```bash
  supabase secrets set RATE_REFRESH_SECRET="<strong-random-secret>"
  supabase functions deploy refresh-asset-rates
  ```

### 3. TRON Worker Setup (`ntps-tron-worker`)

```bash
cd ntps-tron-worker
npm install
cp .env.example .env

# Encrypt your TRON hot wallet private key (AES-256-GCM envelope)
npm run encrypt-key

# Build and run the worker
npm run build
npm start
```

> Never store raw `HOT_WALLET_PRIVATE_KEY` in production `.env` files. Use `HOT_WALLET_PRIVATE_KEY_ENCRYPTED` paired with `HOT_WALLET_DECRYPTION_KEY` from your secrets manager.

---

## Environment Variable Reference

### Frontend (`.env.example`)
| Variable | Required | Description |
| :--- | :--- | :--- |
| `VITE_SUPABASE_URL` | Live Mode | Supabase project REST URL (`https://<ref>.supabase.co`). |
| `VITE_SUPABASE_ANON_KEY` | Live Mode | Public Supabase anonymous/publishable key (RLS-gated). |
| `APP_URL` | Optional | Public URL of the deployed frontend application. |

### Edge Function Secrets (Server-Only)
| Variable | Required | Description |
| :--- | :--- | :--- |
| `RATE_REFRESH_SECRET` | Yes (Live Rates) | Mandatory bearer secret for `supabase/functions/refresh-asset-rates` (`supabase secrets set RATE_REFRESH_SECRET="..."`). Never prefix with `VITE_`. |

### TRON Worker (`ntps-tron-worker/.env.example`)
| Variable | Required | Description |
| :--- | :--- | :--- |
| `SUPABASE_URL` | Yes | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key (**server-side only** — never expose to Vite/frontend). |
| `TRON_FULL_HOST` | Yes | Permitted TronGrid endpoint (`https://api.trongrid.io`, `https://api.shasta.trongrid.io`, or `https://nile.trongrid.io`). |
| `TRON_ALLOWED_HOSTS` | Optional | Comma-separated additional trusted HTTPS TRON node origins permitted beyond default TronGrid endpoints. |
| `TRONGRID_API_KEY` | Recommended | TronGrid API key (`TRON-PRO-API-KEY` header). |
| `USDT_CONTRACT_ADDRESS` | Yes | TRC-20 USDT contract (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` on mainnet). |
| `HOT_WALLET_PRIVATE_KEY_ENCRYPTED` | Prod Yes | AES-256-GCM encrypted hot wallet envelope (`ntps:v2:aes256gcm:<salt>:<iv>:<tag>:<ciphertext>`, scrypt `N=131072`; legacy `ntps:v1` readable for migration). Generate via masked prompt or `--key-file` (`npm run encrypt-key`). |
| `HOT_WALLET_DECRYPTION_KEY` | Prod Yes | Secret passphrase (min 32 chars required for `ntps:v2`) injected via secrets manager. |
| `HOT_WALLET_PRIVATE_KEY` | Dev Only | Plaintext private key fallback; blocked in `NODE_ENV=production` unless `ALLOW_PLAINTEXT_KEY=true`. |
| `ALLOW_PLAINTEXT_KEY` | Optional | Set `true` only as a temporary migration override for plaintext key fallback in production (default `false`). |
| `POLL_INTERVAL_MS` | Optional | Worker loop interval in ms (default `15000`). |
| `WITHDRAWAL_RETRY_BASE_MS` | Optional | Base delay in ms for 3-attempt exponential backoff (default `2000`). |
| `POLL_FAILURE_ALERT_THRESHOLD` | Optional | Consecutive TronGrid poll failures before alert (default `3`). |
| `STALE_BROADCAST_THRESHOLD_MS` | Optional | Timeout in ms before stranded `'broadcast'` withdrawals are reconciled automatically (default `600000`). |
| `MIN_HOT_WALLET_TRX` | Optional | Minimum hot wallet native TRX reserve required to start outbound withdrawal broadcasts (default `50` TRX). |
| `WORKER_LEASE_TTL_SECONDS` | Optional | Lease duration in seconds for `acquire_worker_lease` cycle lock (`20`–`300`, default `45`). |
| `AUDIT_FAILURE_ALERT_THRESHOLD` | Optional | Consecutive worker audit write failures before critical alert (default `3`). |
| `AUDIT_FALLBACK_FILE` | Optional | Append-only JSONL fallback path (`0o600`) for redacted audit entries if DB audit write fails. |
| `ALERT_WEBHOOK_URL` | Optional | JSON webhook endpoint (Slack/Discord/PagerDuty) for worker alerts. |
| `ALERT_EDGE_FUNCTION_URL` | Optional | Same-origin Supabase Edge Function endpoint (`https://<ref>.supabase.co/...`); cross-origin URLs are blocked. |
| `ALERT_EDGE_FUNCTION_TOKEN` | Recommended | Dedicated non-privileged bearer token for `ALERT_EDGE_FUNCTION_URL` (preferred over `SUPABASE_SERVICE_ROLE_KEY`). |
| `AML_BLOCKED_ADDRESSES` | Optional | Comma-separated TRON addresses blocked in addition to `aml_blocked_addresses` DB table. |

---

## Production Deployment Steps

1. **Database Hardening:** Apply `supabase/schema.sql` and migrations `001` through `008`. Verify `verify_ledger_invariant()` reports `ok = true` and `imbalancedCount = 0`.
2. **Secrets Audit:** Confirm no `service_role`, `HOT_WALLET_*`, `RATE_REFRESH_SECRET`, or TOTP keys exist in `VITE_*` variables or the compiled `dist/` bundle (`npm run build`).
3. **Edge Functions:** Set `RATE_REFRESH_SECRET`, deploy `supabase/functions/refresh-asset-rates`, and schedule periodic authenticated execution (e.g., via `pg_cron` or external scheduler) so `asset_rates` stays fresh.
4. **Frontend Hosting:** Run `npm run lint && npm run build` and serve `dist/` behind TLS (configured with `vercel.json` CSP, HSTS, `X-Frame-Options: DENY`, and `nosniff` security headers).
5. **Worker Daemon (Single Replica):** Build `ntps-tron-worker` (`npm --prefix ntps-tron-worker run build`) and run **exactly one active replica** (`node dist/index.js`) under a process supervisor (`systemd`, Docker, or PM2) with secrets injected at runtime (never rely on `.env` files in `NODE_ENV=production`), `ALERT_WEBHOOK_URL` configured, and a funded TRX/USDT hot wallet. Migration `008` enforces an atomic DB lease guard (`acquire_worker_lease`) as defense-in-depth against accidental replica overlap.
