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
|  - `useSupabaseAuth` -> Live Session vs. Sandboxed `DEMO MODE — local data` |
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
2. **Local Demo Mode (`DEMO MODE — local data`)**
   - Activated automatically when Supabase environment variables are absent, or manually via the Session Modal override for demos and training.
   - Displays an explicit **`DEMO MODE — local data`** badge in the workspace header, persists sandboxed state in `localStorage`, and uses a locally generated random session TOTP challenge rather than live credentials.

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

#### Admin Authorization & Live Asset Rates (Optional)
- **Provision Admin Operators:** Grant an operator access by inserting their Supabase Auth `user_id` into `public.app_admins` (via SQL Editor or `service_role`):
  ```sql
  INSERT INTO public.app_admins (user_id, role, is_active)
  VALUES ('<operator-auth-uid>', 'compliance', true);
  ```
  Roles: `ops`, `compliance`, `treasury` (read-only for freezes/approvals), and `super_admin`.
- **Live Asset Rates:** Deploy the CoinGecko rate updater Edge Function:
  ```bash
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

### TRON Worker (`ntps-tron-worker/.env.example`)
| Variable | Required | Description |
| :--- | :--- | :--- |
| `SUPABASE_URL` | Yes | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key (**server-side only** — never expose to Vite/frontend). |
| `TRON_FULL_HOST` | Yes | TronGrid endpoint (`https://api.trongrid.io` or `https://nile.trongrid.io` for testnet). |
| `TRONGRID_API_KEY` | Recommended | TronGrid API key (`TRON-PRO-API-KEY` header). |
| `USDT_CONTRACT_ADDRESS` | Yes | TRC-20 USDT contract (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` on mainnet). |
| `HOT_WALLET_PRIVATE_KEY_ENCRYPTED` | Prod Yes | AES-256-GCM encrypted hot wallet envelope (`v1:<salt>:<iv>:<tag>:<ciphertext>`). |
| `HOT_WALLET_DECRYPTION_KEY` | Prod Yes | Secret passphrase (min 16 chars; 32+ recommended) injected via secrets manager. |
| `HOT_WALLET_PRIVATE_KEY` | Dev Only | Plaintext private key fallback (logs startup security warning; omit in prod). |
| `POLL_INTERVAL_MS` | Optional | Worker loop interval in ms (default `15000`). |
| `WITHDRAWAL_RETRY_BASE_MS` | Optional | Base delay in ms for 3-attempt exponential backoff (default `2000`). |
| `POLL_FAILURE_ALERT_THRESHOLD` | Optional | Consecutive TronGrid poll failures before alert (default `3`). |
| `ALERT_WEBHOOK_URL` | Optional | JSON webhook endpoint (Slack/Discord/PagerDuty) for worker alerts. |
| `ALERT_EDGE_FUNCTION_URL` | Optional | Supabase Edge Function endpoint invoked with `SUPABASE_SERVICE_ROLE_KEY`. |
| `AML_BLOCKED_ADDRESSES` | Optional | Comma-separated TRON addresses blocked in addition to `aml_blocked_addresses` DB table. |

---

## Production Deployment Steps

1. **Database Hardening:** Apply `supabase/schema.sql` and migrations `001` through `004`. Verify `verify_ledger_invariant()` reports `ok = true` and `imbalancedCount = 0`.
2. **Secrets Audit:** Confirm no `service_role`, `HOT_WALLET_*`, or TOTP keys exist in `VITE_*` variables or the compiled `dist/` bundle (`npm run build`).
3. **Edge Functions:** Deploy `supabase/functions/refresh-asset-rates` and schedule periodic execution (e.g., via `pg_cron` or external scheduler) so `asset_rates` stays fresh.
4. **Frontend Hosting:** Run `npm run lint && npm run build` and serve `dist/` behind TLS on a static CDN/reverse proxy.
5. **Worker Daemon:** Build `ntps-tron-worker` (`npm --prefix ntps-tron-worker run build`) and run `node dist/index.js` under a process supervisor (`systemd`, Docker, or PM2) with secrets injected at runtime, `ALERT_WEBHOOK_URL` configured, and a funded TRX/USDT hot wallet.
