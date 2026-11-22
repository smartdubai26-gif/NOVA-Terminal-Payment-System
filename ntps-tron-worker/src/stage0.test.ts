import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePrior24hOutflowUsd,
  evaluateBroadcastPolicy,
  resolveUsdRate,
  type TerminalPolicyRecord,
} from './policyGuard';
import { resolveAlertEdgeFunctionDispatch, sendWorkerAlert } from './alerts';

function makeTerminal(overrides: Partial<TerminalPolicyRecord> = {}): TerminalPolicyRecord {
  return {
    id: '11111111-1111-4111-8111-111111111100',
    terminal_id: 'NT-OMEGA-7K9P-3M2X',
    status: 'active',
    per_tx_limit_usd: 50000,
    daily_limit_usd: 150000,
    allowed_assets: ['USDT', 'BTC', 'ETH'],
    ...overrides,
  };
}

test('W-04: rejects suspended, locked, restricted, and missing terminals before broadcast', () => {
  for (const status of ['suspended', 'locked', 'restricted']) {
    const res = evaluateBroadcastPolicy({
      terminal: makeTerminal({ status }),
      asset: 'USDT',
      amount: 1000,
      usdRate: 1,
      prior24hOutflowUsd: 0,
    });
    assert.equal(res.allowed, false);
    assert.match(res.reason ?? '', /must be 'active'/i);
  }

  const missingRes = evaluateBroadcastPolicy({
    terminal: null,
    asset: 'USDT',
    amount: 1000,
    usdRate: 1,
    prior24hOutflowUsd: 0,
  });
  assert.equal(missingRes.allowed, false);
});

test('W-04: rejects disallowed assets and excessive per-tx or 24h daily limits', () => {
  const disallowedAsset = evaluateBroadcastPolicy({
    terminal: makeTerminal({ allowed_assets: ['BTC', 'ETH'] }),
    asset: 'USDT',
    amount: 500,
    usdRate: 1,
    prior24hOutflowUsd: 0,
  });
  assert.equal(disallowedAsset.allowed, false);
  assert.match(disallowedAsset.reason ?? '', /not permitted/i);

  const perTxExceeded = evaluateBroadcastPolicy({
    terminal: makeTerminal({ per_tx_limit_usd: 25000 }),
    asset: 'USDT',
    amount: 25001,
    usdRate: 1,
    prior24hOutflowUsd: 0,
  });
  assert.equal(perTxExceeded.allowed, false);
  assert.match(perTxExceeded.reason ?? '', /per-tx limit/i);

  const dailyExceeded = evaluateBroadcastPolicy({
    terminal: makeTerminal({ per_tx_limit_usd: 50000, daily_limit_usd: 100000 }),
    asset: 'USDT',
    amount: 25000,
    usdRate: 1,
    prior24hOutflowUsd: 80000,
  });
  assert.equal(dailyExceeded.allowed, false);
  assert.match(dailyExceeded.reason ?? '', /24h daily limit/i);
});

test('W-04: excludes current pending transaction_id and reversed/failed rows when summing 24h outflow', () => {
  const nowMs = Date.UTC(2026, 10, 22, 12, 0, 0);
  const recentIso = new Date(nowMs - 2 * 3600_000).toISOString();
  const staleIso = new Date(nowMs - 26 * 3600_000).toISOString();

  const priorUsd = computePrior24hOutflowUsd(
    [
      { id: 'tx-current', asset: 'USDT', amount: 40000, status: 'pending', created_at: recentIso },
      { id: 'tx-ok-1', asset: 'USDT', amount: 30000, status: 'completed', created_at: recentIso },
      { id: 'tx-reversed', asset: 'USDT', amount: 99000, status: 'reversed', created_at: recentIso },
      { id: 'tx-failed', asset: 'USDT', amount: 99000, status: 'failed', created_at: recentIso },
      { id: 'tx-stale', asset: 'USDT', amount: 99000, status: 'completed', created_at: staleIso },
    ],
    'tx-current',
    { USDT: 1 },
    nowMs
  );

  assert.equal(priorUsd, 30000);

  const allowedRes = evaluateBroadcastPolicy({
    terminal: makeTerminal({ per_tx_limit_usd: 50000, daily_limit_usd: 100000 }),
    asset: 'USDT',
    amount: 40000,
    usdRate: resolveUsdRate('USDT', { USDT: 1 }),
    prior24hOutflowUsd: priorUsd,
  });
  assert.equal(allowedRes.allowed, true);
  assert.equal(allowedRes.projectedDailyUsd, 70000);
});

test('W-05: refuses cross-origin ALERT_EDGE_FUNCTION_URL and never transmits service_role key', async () => {
  const mismatch = resolveAlertEdgeFunctionDispatch({
    edgeFnUrl: 'https://attacker.example.com/steal-key',
    supabaseUrl: 'https://project123.supabase.co',
    serviceRoleKey: 'super-secret-service-role-key',
  });
  assert.equal(mismatch.allowed, false);
  assert.match(mismatch.reason ?? '', /does not match SUPABASE_URL origin/i);

  const httpExternal = resolveAlertEdgeFunctionDispatch({
    edgeFnUrl: 'http://project123.supabase.co/functions/v1/alert',
    supabaseUrl: 'http://project123.supabase.co',
    serviceRoleKey: 'super-secret-service-role-key',
  });
  assert.equal(httpExternal.allowed, false);
  assert.match(httpExternal.reason ?? '', /https:\/\//i);

  // Verify sendWorkerAlert makes zero fetch calls when origins mismatch
  const prevEnv = {
    ALERT_EDGE_FUNCTION_URL: process.env.ALERT_EDGE_FUNCTION_URL,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL,
    ALERT_EDGE_FUNCTION_TOKEN: process.env.ALERT_EDGE_FUNCTION_TOKEN,
  };
  const originalFetch = globalThis.fetch;
  let fetchCalled = 0;

  try {
    process.env.ALERT_WEBHOOK_URL = '';
    process.env.ALERT_EDGE_FUNCTION_TOKEN = '';
    process.env.SUPABASE_URL = 'https://project123.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'super-secret-service-role-key';
    process.env.ALERT_EDGE_FUNCTION_URL = 'https://evil-exfil.example.net/hook';
    globalThis.fetch = (async () => {
      fetchCalled += 1;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    await sendWorkerAlert({
      severity: 'critical',
      eventType: 'TEST_ALERT',
      title: 'Test',
      message: 'Should block cross-origin alert target',
    });

    assert.equal(fetchCalled, 0);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.ALERT_EDGE_FUNCTION_URL = prevEnv.ALERT_EDGE_FUNCTION_URL;
    process.env.SUPABASE_URL = prevEnv.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = prevEnv.SUPABASE_SERVICE_ROLE_KEY;
    process.env.ALERT_WEBHOOK_URL = prevEnv.ALERT_WEBHOOK_URL;
    process.env.ALERT_EDGE_FUNCTION_TOKEN = prevEnv.ALERT_EDGE_FUNCTION_TOKEN;
  }
});

test('W-05: allows same-origin Edge Function URL and prefers dedicated non-privileged token', () => {
  const withDedicatedToken = resolveAlertEdgeFunctionDispatch({
    edgeFnUrl: 'https://project123.supabase.co/functions/v1/worker-alert',
    supabaseUrl: 'https://project123.supabase.co',
    dedicatedToken: 'scoped-alert-token',
    serviceRoleKey: 'super-secret-service-role-key',
  });
  assert.equal(withDedicatedToken.allowed, true);
  assert.equal(withDedicatedToken.bearerToken, 'scoped-alert-token');

  const withFallbackRoleKey = resolveAlertEdgeFunctionDispatch({
    edgeFnUrl: 'https://project123.supabase.co/functions/v1/worker-alert',
    supabaseUrl: 'https://project123.supabase.co',
    serviceRoleKey: 'super-secret-service-role-key',
  });
  assert.equal(withFallbackRoleKey.allowed, true);
  assert.equal(withFallbackRoleKey.bearerToken, 'super-secret-service-role-key');
});
