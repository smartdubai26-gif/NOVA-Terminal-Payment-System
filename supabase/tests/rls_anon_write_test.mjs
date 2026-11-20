/**
 * NTPS Phase 1.1 — RLS & Privilege Verification Script (anon key)
 *
 * Usage:
 *   SUPABASE_URL="https://<project>.supabase.co" \
 *   SUPABASE_ANON_KEY="<anon-jwt>" \
 *   node supabase/tests/rls_anon_write_test.mjs
 *
 * Or automatically reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from .env
 * if present. Run BEFORE and AFTER applying `supabase/migrations/001_harden_rls.sql`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnvFile();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    '[ABORT] Missing SUPABASE_URL / SUPABASE_ANON_KEY (or VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).'
  );
  console.error(
    'Example: SUPABASE_URL="https://xyz.supabase.co" SUPABASE_ANON_KEY="eyJ..." node supabase/tests/rls_anon_write_test.mjs'
  );
  process.exit(2);
}

const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DUMMY_UUID = '00000000-0000-4000-8000-000000000001';

const WRITE_PROBES = [
  {
    table: 'wallets',
    op: 'UPDATE',
    run: () =>
      anonClient.from('wallets').update({ available: 999999 }).eq('id', DUMMY_UUID),
  },
  {
    table: 'wallets',
    op: 'INSERT',
    run: () =>
      anonClient.from('wallets').insert({
        terminal_id: DUMMY_UUID,
        asset: 'USDT',
        network: 'TRC20',
        available: 1000,
      }),
  },
  {
    table: 'ledger_postings',
    op: 'INSERT',
    run: () =>
      anonClient.from('ledger_postings').insert({
        journal_id: DUMMY_UUID,
        account_ref: 'wallet:' + DUMMY_UUID,
        asset: 'USDT',
        amount: 5000,
      }),
  },
  {
    table: 'ledger_postings',
    op: 'DELETE',
    run: () => anonClient.from('ledger_postings').delete().eq('id', DUMMY_UUID),
  },
  {
    table: 'transactions',
    op: 'INSERT',
    run: () =>
      anonClient.from('transactions').insert({
        reference: 'NTPS-ANON-TEST',
        terminal_id: DUMMY_UUID,
        type: 'deposit',
        asset: 'USDT',
        network: 'TRC20',
        amount: 5000,
      }),
  },
  {
    table: 'journal_entries',
    op: 'INSERT',
    run: () =>
      anonClient.from('journal_entries').insert({
        kind: 'deposit',
        idempotency_key: 'anon_test_' + Date.now(),
      }),
  },
  {
    table: 'withdrawal_requests',
    op: 'INSERT',
    run: () =>
      anonClient.from('withdrawal_requests').insert({
        transaction_id: DUMMY_UUID,
        whitelist_address_id: DUMMY_UUID,
        state: 'approved',
      }),
  },
  {
    table: 'deposit_addresses',
    op: 'INSERT',
    run: () =>
      anonClient.from('deposit_addresses').insert({
        wallet_id: DUMMY_UUID,
        network: 'TRC20',
        address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
      }),
  },
  {
    table: 'terminals',
    op: 'UPDATE',
    run: () =>
      anonClient.from('terminals').update({ status: 'active' }).eq('id', DUMMY_UUID),
  },
  {
    table: 'trading_accounts',
    op: 'INSERT',
    run: () =>
      anonClient.from('trading_accounts').insert({
        terminal_id: DUMMY_UUID,
        account_type: 'nova_margin',
        account_login: 'ANON-FAKE-01',
        currency: 'USDT',
        balance: 100000,
        free_margin: 100000,
      }),
  },
  {
    table: 'whitelist_addresses',
    op: 'INSERT',
    run: () =>
      anonClient.from('whitelist_addresses').insert({
        terminal_id: DUMMY_UUID,
        label: 'Attacker Vault',
        asset: 'USDT',
        network: 'TRC20',
        address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
      }),
  },
  {
    table: 'invoices',
    op: 'INSERT',
    run: () =>
      anonClient.from('invoices').insert({
        invoice_number: 'INV-ANON-001',
        terminal_id: DUMMY_UUID,
        asset: 'USDT',
        amount: 100,
        description: 'Unauthorized',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        signed_uri: 'ntps://pay?invalid',
        signature: '0x00',
      }),
  },
  {
    table: 'audit_logs',
    op: 'INSERT',
    run: () =>
      anonClient.from('audit_logs').insert({
        event_type: 'ANON_TAMPER',
        actor: 'anon',
        details: 'Unauthorized insert',
        severity: 'critical',
        prev_hash: '0x0',
        row_hash: '0x1',
      }),
  },
];

async function runSuite() {
  console.log(`\n=== NTPS Phase 1.1 RLS Verification (role: anon) ===`);
  console.log(`Target: ${SUPABASE_URL}\n`);

  let failures = 0;

  // 1. Verify direct writes are rejected for anon
  for (const probe of WRITE_PROBES) {
    const { data, error } = await probe.run();
    const rejected = Boolean(error);
    const status = rejected ? 'PASS (REJECTED)' : 'FAIL (ALLOWED!)';
    if (!rejected) failures++;
    console.log(
      `[${status}] ${probe.op.padEnd(6)} ${probe.table.padEnd(22)} -> ${
        error ? `${error.code ?? 'ERR'}: ${error.message}` : JSON.stringify(data)
      }`
    );
  }

  // 2. Verify anon cannot execute privileged RPCs
  const rpcProbes = [
    {
      fn: 'bootstrap_user_terminal',
      args: { p_terminal_id: 'NT-OMEGA-7K9P-3M27', p_label: 'Anon' },
    },
    {
      fn: 'credit_crypto_deposit',
      args: {
        p_terminal_id: DUMMY_UUID,
        p_wallet_id: DUMMY_UUID,
        p_asset: 'USDT',
        p_network: 'TRC20',
        p_amount: 1000,
        p_tx_hash: '0xanon',
      },
    },
  ];

  console.log('\n--- RPC Execution Checks (role: anon) ---');
  for (const rpc of rpcProbes) {
    const { error } = await anonClient.rpc(rpc.fn, rpc.args);
    const rejected = Boolean(error);
    if (!rejected) failures++;
    console.log(
      `[${rejected ? 'PASS (REJECTED)' : 'FAIL (ALLOWED!)'}] RPC ${rpc.fn.padEnd(26)} -> ${
        error ? `${error.code ?? 'ERR'}: ${error.message}` : 'EXECUTED'
      }`
    );
  }

  // 3. Verify safe read surface (post-migration) & private table SELECT denial
  console.log('\n--- Read Surface Checks (role: anon) ---');
  const { data: pubInfo, error: pubErr } = await anonClient
    .from('public_system_info')
    .select('*');
  console.log(
    `[${!pubErr && Array.isArray(pubInfo) && pubInfo.length > 0 ? 'PASS (SAFE READ)' : 'INFO (PRE-MIGRATION OR BLOCKED)'}] SELECT public_system_info -> ${
      pubErr ? `${pubErr.code}: ${pubErr.message}` : `${pubInfo?.length ?? 0} row(s)`
    }`
  );

  const { data: walletRead, error: walletErr } = await anonClient
    .from('wallets')
    .select('*')
    .limit(1);
  const walletSafe = Boolean(walletErr) || (Array.isArray(walletRead) && walletRead.length === 0);
  if (!walletSafe) failures++;
  console.log(
    `[${walletSafe ? 'PASS (NO LEAK)' : 'FAIL (DATA LEAKED!)'}] SELECT wallets -> ${
      walletErr ? `${walletErr.code}: ${walletErr.message}` : `${walletRead?.length ?? 0} rows`
    }`
  );

  console.log(`\nSummary: ${failures === 0 ? 'ALL WRITE/LEAK CHECKS PASSED' : `${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

runSuite().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
