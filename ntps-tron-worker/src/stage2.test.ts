import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getConsecutiveAuditFailures,
  recordWorkerAuditLog,
  resetAuditFailureStateForTests,
  sanitizeErrorMessage,
} from './auditLog';
import {
  evaluateHotWalletTrxBalance,
  generateWorkerInstanceId,
  resolveTrustedTronHost,
  validateAndParseTronGridDeposit,
} from './workerHelpers';

const USDT_MAINNET_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const DEPOSIT_ADDR = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

test('W-16 / SYS-16: redacts JWTs, Bearer tokens, URL credentials, env secrets, and 64-hex keys', () => {
  const fakeEnv = {
    HOT_WALLET_DECRYPTION_KEY: 'SuperSecretPassphraseWith32PlusChars!',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_live_example_value_123456',
    TRONGRID_API_KEY: 'trongrid-secret-api-key-9876',
  } as unknown as NodeJS.ProcessEnv;

  const sampleJwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signaturePayloadXYZ123';
  const rawHex64 = 'a'.repeat(64);
  const rawMessage = [
    `Auth failed Authorization: Bearer my-bearer-secret-999`,
    `jwt=${sampleJwt}`,
    `url=https://opsuser:topsecretpass@internal.proxy:8443/hook`,
    `env1=${fakeEnv.HOT_WALLET_DECRYPTION_KEY}`,
    `env2=${fakeEnv.TRONGRID_API_KEY}`,
    `privateKey=${rawHex64}`,
  ].join(' | ');

  const sanitized = sanitizeErrorMessage(new Error(rawMessage), undefined, fakeEnv);

  assert.equal(sanitized.includes(sampleJwt), false);
  assert.equal(sanitized.includes('my-bearer-secret-999'), false);
  assert.equal(sanitized.includes('topsecretpass'), false);
  assert.equal(sanitized.includes('SuperSecretPassphraseWith32PlusChars!'), false);
  assert.equal(sanitized.includes('trongrid-secret-api-key-9876'), false);
  assert.equal(sanitized.includes(rawHex64), false);
  assert.match(sanitized, /\[REDACTED_JWT\]/);
  assert.match(sanitized, /\[REDACTED_TOKEN\]/);
  assert.match(sanitized, /\[REDACTED_CREDENTIALS\]/);
  assert.match(sanitized, /\[REDACTED_SECRET\]/);
});

test('W-17: tracks consecutive audit failures, writes redacted local JSONL fallback, and resets on recovery', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntps-audit-test-'));
  const fallbackFile = path.join(tempDir, 'audit-fallback.jsonl');
  const prevFallback = process.env.AUDIT_FALLBACK_FILE;
  const prevThreshold = process.env.AUDIT_FAILURE_ALERT_THRESHOLD;
  process.env.AUDIT_FALLBACK_FILE = fallbackFile;
  process.env.AUDIT_FAILURE_ALERT_THRESHOLD = '2';

  resetAuditFailureStateForTests();

  try {
    const failingSupabase = {
      rpc: async () => ({
        data: null,
        error: { code: '500', message: 'db write failure Authorization: Bearer leak-token-1234' },
      }),
    } as unknown as SupabaseClient;

    const ok1 = await recordWorkerAuditLog(failingSupabase, {
      eventType: 'WITHDRAWAL_BROADCAST_STARTED',
      terminalId: 'term-1',
      details: 'Attempt 1 details',
      severity: 'warn',
    });
    assert.equal(ok1, false);
    assert.equal(getConsecutiveAuditFailures(), 1);

    const ok2 = await recordWorkerAuditLog(failingSupabase, {
      eventType: 'WITHDRAWAL_BROADCAST_FAILED',
      terminalId: 'term-1',
      details: 'Attempt 2 details',
      severity: 'critical',
    });
    assert.equal(ok2, false);
    assert.equal(getConsecutiveAuditFailures(), 2);

    assert.equal(fs.existsSync(fallbackFile), true);
    const lines = fs.readFileSync(fallbackFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const parsedLine = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(parsedLine.eventType, 'WITHDRAWAL_BROADCAST_STARTED');
    assert.equal(String(parsedLine.auditWriteError).includes('leak-token-1234'), false);

    const recoveringSupabase = {
      rpc: async () => ({ data: 'audit-uuid-ok', error: null }),
    } as unknown as SupabaseClient;

    const ok3 = await recordWorkerAuditLog(recoveringSupabase, {
      eventType: 'WITHDRAWAL_BROADCAST_CONFIRMED',
      terminalId: 'term-1',
      details: 'Recovered write',
      severity: 'info',
    });
    assert.equal(ok3, true);
    assert.equal(getConsecutiveAuditFailures(), 0);
  } finally {
    resetAuditFailureStateForTests();
    if (prevFallback === undefined) {
      delete process.env.AUDIT_FALLBACK_FILE;
    } else {
      process.env.AUDIT_FALLBACK_FILE = prevFallback;
    }
    if (prevThreshold === undefined) {
      delete process.env.AUDIT_FAILURE_ALERT_THRESHOLD;
    } else {
      process.env.AUDIT_FAILURE_ALERT_THRESHOLD = prevThreshold;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('W-18: validates TronGrid TRC-20 contract, recipient `to`, decimals, and raw amount', () => {
  const valid = validateAndParseTronGridDeposit(
    {
      transaction_id: 'tx-valid-1',
      value: '250500000',
      block_timestamp: 1_760_000_000_000,
      to: DEPOSIT_ADDR,
      token_info: { address: USDT_MAINNET_CONTRACT, decimals: 6, symbol: 'USDT' },
    },
    DEPOSIT_ADDR,
    USDT_MAINNET_CONTRACT
  );
  assert.equal(valid.valid, true);
  if (valid.valid) {
    assert.equal(valid.amount, 250.5);
    assert.equal(valid.decimals, 6);
  }

  // Respects non-6 decimals cleanly
  const customDecimals = validateAndParseTronGridDeposit(
    {
      transaction_id: 'tx-dec-8',
      value: '1250000000',
      block_timestamp: 1_760_000_000_100,
      to: DEPOSIT_ADDR,
      token_info: { address: USDT_MAINNET_CONTRACT, decimals: 8 },
    },
    DEPOSIT_ADDR,
    USDT_MAINNET_CONTRACT
  );
  assert.equal(customDecimals.valid, true);
  if (customDecimals.valid) {
    assert.equal(customDecimals.amount, 12.5);
  }

  // Rejects spoofed token contract address
  const spoofedContract = validateAndParseTronGridDeposit(
    {
      transaction_id: 'tx-spoof-contract',
      value: '999000000',
      block_timestamp: 1_760_000_000_200,
      to: DEPOSIT_ADDR,
      token_info: { address: 'TFakeContractAddress11111111111111111', decimals: 6 },
    },
    DEPOSIT_ADDR,
    USDT_MAINNET_CONTRACT
  );
  assert.equal(spoofedContract.valid, false);
  if (!spoofedContract.valid) {
    assert.equal(spoofedContract.suspicious, true);
    assert.match(spoofedContract.reason, /Contract address mismatch/i);
  }

  // Rejects mismatched recipient `to` address
  const wrongRecipient = validateAndParseTronGridDeposit(
    {
      transaction_id: 'tx-wrong-to',
      value: '50000000',
      block_timestamp: 1_760_000_000_300,
      to: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      token_info: { address: USDT_MAINNET_CONTRACT, decimals: 6 },
    },
    DEPOSIT_ADDR,
    USDT_MAINNET_CONTRACT
  );
  assert.equal(wrongRecipient.valid, false);
  if (!wrongRecipient.valid) {
    assert.equal(wrongRecipient.suspicious, true);
    assert.match(wrongRecipient.reason, /Recipient address mismatch/i);
  }
});

test('W-19: enforces permitted TRON_FULL_HOST origin allowlist', () => {
  assert.equal(resolveTrustedTronHost(undefined), 'https://api.trongrid.io');
  assert.equal(resolveTrustedTronHost('https://nile.trongrid.io/v1/extra'), 'https://nile.trongrid.io');
  assert.equal(
    resolveTrustedTronHost('https://custom-tron-node.example.com', 'https://custom-tron-node.example.com'),
    'https://custom-tron-node.example.com'
  );

  assert.throws(
    () => resolveTrustedTronHost('https://evil-attacker.example.com'),
    /Untrusted TRON_FULL_HOST origin/i
  );
  assert.throws(
    () => resolveTrustedTronHost('http://api.trongrid.io'),
    /Untrusted TRON_FULL_HOST protocol/i
  );
  assert.throws(
    () => resolveTrustedTronHost('https://user:pass@api.trongrid.io'),
    /must not embed URL credentials/i
  );
});

test('W-20: pauses broadcasts when hot wallet TRX fee reserve is below threshold', () => {
  const lowRes = evaluateHotWalletTrxBalance(12_500_000, 50_000_000);
  assert.equal(lowRes.ok, false);
  assert.equal(lowRes.balanceTrx, 12.5);
  assert.equal(lowRes.minReserveTrx, 50);
  assert.match(lowRes.reason ?? '', /too low/i);

  const okRes = evaluateHotWalletTrxBalance(75_000_000, 50_000_000);
  assert.equal(okRes.ok, true);
  assert.equal(okRes.balanceTrx, 75);
});

test('W-21, W-22, W-23, W-24 & W-25: static worker hardening invariants hold', () => {
  const instanceId = generateWorkerInstanceId();
  assert.match(
    instanceId,
    /^ntps-worker-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );

  const indexSrc = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
  assert.equal(indexSrc.includes('Math.random('), false, 'index.ts must not use Math.random');
  assert.equal(indexSrc.includes('.catch(() => undefined)'), false, 'index.ts must not swallow reconcile errors');
  assert.match(indexSrc, /NODE_ENV[\s\S]*!==\s*'production'[\s\S]*dotenv\.config\(\)/);
  assert.match(indexSrc, /crypto\.randomInt\(0,\s*250\)/);

  // W-22: AML screening occurs strictly before claim_approved_withdrawal_for_broadcast
  const amlPos = indexSrc.indexOf('screenWithdrawalDestination(');
  const claimPos = indexSrc.indexOf("rpc('claim_approved_withdrawal_for_broadcast'");
  assert.ok(amlPos > 0 && claimPos > 0 && amlPos < claimPos);

  // W-25: encryptKey.ts explicitly forbids PLAIN_HOT_WALLET_PRIVATE_KEY env var
  const encryptSrc = fs.readFileSync(path.resolve(__dirname, '../src/encryptKey.ts'), 'utf8');
  assert.match(encryptSrc, /PLAIN_HOT_WALLET_PRIVATE_KEY env var is disabled/);
});
