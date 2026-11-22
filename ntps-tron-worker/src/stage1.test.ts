import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  HOT_WALLET_CRYPTO_SPEC,
  decryptHotWalletPrivateKey,
  detectEnvelopeVersion,
  encryptHotWalletPrivateKey,
  resolveHotWalletPrivateKey,
} from './cryptoKey';
import { computeAuditRowHash, recordWorkerAuditLog } from './auditLog';
import {
  advanceDepositCursor,
  classifyApprovedWithdrawal,
  preserveGlobalCursorOnError,
  resolveStaleBroadcastAction,
} from './workerHelpers';

const SAMPLE_TRON_PRIV_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const STRONG_PASSPHRASE_V2 = 'N7ps!Strong-Prod-Passphrase-2026-KeyVault-32PlusChars';
const LEGACY_PASSPHRASE_V1 = 'legacy-16-char-pw';

function buildLegacyV1Envelope(plainKey: string, secret: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const aesKey = crypto.scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 });
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plainKey, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      'ntps',
      'v1',
      'aes256gcm',
      salt.toString('hex'),
      iv.toString('hex'),
      authTag.toString('hex'),
      ciphertext.toString('hex'),
    ].join(':');
  } finally {
    aesKey.fill(0);
  }
}

test('W-07: classifies unsupported networks and missing relations for review instead of starving TRC20 items', () => {
  const unsupportedErc20 = classifyApprovedWithdrawal(
    {
      terminal_id: 'term-1',
      asset: 'USDT',
      amount: 500,
      fee: 5,
      status: 'pending',
      tx_hash: null,
    },
    { address: '0x1111111111111111111111111111111111111111', network: 'ERC20' }
  );
  assert.equal(unsupportedErc20.kind, 'requeue_review');
  if (unsupportedErc20.kind === 'requeue_review') {
    assert.equal(unsupportedErc20.code, 'UNSUPPORTED_NETWORK_FOR_WORKER');
    assert.match(unsupportedErc20.reason, /UNSUPPORTED_NETWORK_FOR_WORKER/);
  }

  const missingRel = classifyApprovedWithdrawal(null, null);
  assert.equal(missingRel.kind, 'requeue_review');
  if (missingRel.kind === 'requeue_review') {
    assert.equal(missingRel.code, 'MISSING_RELATION');
  }

  const validTrc20 = classifyApprovedWithdrawal(
    {
      terminal_id: 'term-1',
      asset: 'USDT',
      amount: 125.5,
      fee: 1,
      status: 'pending',
      tx_hash: null,
    },
    { address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', network: 'TRC20' }
  );
  assert.equal(validTrc20.kind, 'executable');
  if (validTrc20.kind === 'executable') {
    assert.equal(validTrc20.amountInUnits, 125_500_000);
  }
});

test('W-08 & W-13: advances deposit cursor safely on unlinked wallets and never resets checkpoint to 0 on poll failure', () => {
  // Advances past valid / unlinked tx when no credit error occurred
  assert.equal(advanceDepositCursor(1_700_000_000_000, 1_700_000_500_000, false), 1_700_000_500_000);
  // Halts advancement if an RPC credit error occurred for the address
  assert.equal(advanceDepositCursor(1_700_000_000_000, 1_700_000_500_000, true), 1_700_000_000_000);
  // Never moves backwards
  assert.equal(advanceDepositCursor(1_700_000_500_000, 1_700_000_100_000, false), 1_700_000_500_000);

  // Preserves prior persisted cursor on transient poll errors
  assert.equal(preserveGlobalCursorOnError(1_760_000_123_456, 0), 1_760_000_123_456);
  assert.equal(preserveGlobalCursorOnError(1_760_000_123_456, 1_760_000_999_000), 1_760_000_999_000);
});

test('W-09: encrypts with ntps:v2 (scrypt N=131072, min 32 chars) and preserves ntps:v1 backward compatibility', () => {
  assert.equal(HOT_WALLET_CRYPTO_SPEC.scryptNV2, 131072);
  assert.equal(HOT_WALLET_CRYPTO_SPEC.minPassphraseLengthV2, 32);

  assert.throws(
    () => encryptHotWalletPrivateKey(SAMPLE_TRON_PRIV_KEY, 'short-passphrase-under-32'),
    /at least 32 characters/i
  );

  const v2Envelope = encryptHotWalletPrivateKey(SAMPLE_TRON_PRIV_KEY, STRONG_PASSPHRASE_V2);
  assert.equal(detectEnvelopeVersion(v2Envelope), 'v2');
  assert.ok(v2Envelope.startsWith('ntps:v2:aes256gcm:'));
  assert.equal(decryptHotWalletPrivateKey(v2Envelope, STRONG_PASSPHRASE_V2), SAMPLE_TRON_PRIV_KEY);

  // Wrong passphrase fails cleanly without leaking key material
  assert.throws(() => {
    try {
      decryptHotWalletPrivateKey(v2Envelope, 'wrong-' + STRONG_PASSPHRASE_V2);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert.equal(msg.includes(SAMPLE_TRON_PRIV_KEY), false);
      throw err;
    }
  }, /Failed to decrypt/);

  // Legacy v1 payload still decrypts cleanly for zero-downtime key rotation
  const v1Envelope = buildLegacyV1Envelope(SAMPLE_TRON_PRIV_KEY, LEGACY_PASSPHRASE_V1);
  assert.equal(detectEnvelopeVersion(v1Envelope), 'v1');
  assert.equal(decryptHotWalletPrivateKey(v1Envelope, LEGACY_PASSPHRASE_V1), SAMPLE_TRON_PRIV_KEY);
});

test('W-10: refuses plaintext HOT_WALLET_PRIVATE_KEY in NODE_ENV=production unless ALLOW_PLAINTEXT_KEY=true', () => {
  assert.throws(
    () =>
      resolveHotWalletPrivateKey({
        NODE_ENV: 'production',
        HOT_WALLET_PRIVATE_KEY: SAMPLE_TRON_PRIV_KEY,
      }),
    /Refusing unencrypted HOT_WALLET_PRIVATE_KEY in production/i
  );

  const prodOverride = resolveHotWalletPrivateKey({
    NODE_ENV: 'production',
    HOT_WALLET_PRIVATE_KEY: SAMPLE_TRON_PRIV_KEY,
    ALLOW_PLAINTEXT_KEY: 'true',
  });
  assert.equal(prodOverride.source, 'plaintext_fallback');
  assert.equal(prodOverride.privateKey, SAMPLE_TRON_PRIV_KEY);

  const devFallback = resolveHotWalletPrivateKey({
    NODE_ENV: 'development',
    HOT_WALLET_PRIVATE_KEY: SAMPLE_TRON_PRIV_KEY,
  });
  assert.equal(devFallback.source, 'plaintext_fallback');

  const v2Envelope = encryptHotWalletPrivateKey(SAMPLE_TRON_PRIV_KEY, STRONG_PASSPHRASE_V2);
  const encryptedProd = resolveHotWalletPrivateKey({
    NODE_ENV: 'production',
    HOT_WALLET_PRIVATE_KEY_ENCRYPTED: v2Envelope,
    HOT_WALLET_DECRYPTION_KEY: STRONG_PASSPHRASE_V2,
  });
  assert.equal(encryptedProd.source, 'encrypted');
  assert.equal(encryptedProd.envelopeVersion, 'v2');
  assert.equal(encryptedProd.privateKey, SAMPLE_TRON_PRIV_KEY);
});

test('W-11: uses serialized append_worker_audit_log RPC and falls back cleanly if RPC is absent', async () => {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const insertedRows: Array<Record<string, unknown>> = [];

  const rpcSupportedMock = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: 'audit-uuid-1', error: null };
    },
  } as unknown as SupabaseClient;

  await recordWorkerAuditLog(rpcSupportedMock, {
    eventType: 'WITHDRAWAL_BROADCAST_STARTED',
    terminalId: 'term-uuid-1',
    details: 'Test serialized audit',
    severity: 'info',
  });

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].fn, 'append_worker_audit_log');
  assert.equal(rpcCalls[0].args.p_event_type, 'WITHDRAWAL_BROADCAST_STARTED');

  const fallbackMock = {
    rpc: async () => ({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find function public.append_worker_audit_log' },
    }),
    from: () => ({
      select: () => ({
        order: () => ({
          limit: () => ({
            maybeSingle: async () => ({
              data: { row_hash: '0xabc123' },
              error: null,
            }),
          }),
        }),
      }),
      insert: async (row: Record<string, unknown>) => {
        insertedRows.push(row);
        return { error: null };
      },
    }),
  } as unknown as SupabaseClient;

  await recordWorkerAuditLog(fallbackMock, {
    eventType: 'WITHDRAWAL_STALE_BROADCAST_RECONCILED',
    terminalId: 'term-uuid-2',
    details: 'Fallback chain test',
    severity: 'warn',
  });

  assert.equal(insertedRows.length, 1);
  assert.equal(insertedRows[0].prev_hash, '0xabc123');
  assert.match(String(insertedRows[0].row_hash), /^0x[0-9a-f]{64}$/);
  assert.match(
    computeAuditRowHash(
      '0xabc123',
      { eventType: 'TEST', terminalId: null, details: 'd', severity: 'info' },
      '2026-11-22T00:00:00.000Z'
    ),
    /^0x[0-9a-f]{64}$/
  );
});

test('W-12: reconciles stale broadcast rows with tx_hash cleanly and returns unhashed rows to review', () => {
  const withHash = resolveStaleBroadcastAction({
    txHash: null,
    txHashCandidate: 'abcd'.repeat(16),
    broadcastAtIso: '2026-11-22T10:00:00.000Z',
  });
  assert.equal(withHash.action, 'finalize_with_hash');
  if (withHash.action === 'finalize_with_hash') {
    assert.equal(withHash.txHash, 'abcd'.repeat(16));
  }

  const withoutHash = resolveStaleBroadcastAction({
    txHash: null,
    txHashCandidate: null,
    broadcastAtIso: '2026-11-22T10:00:00.000Z',
  });
  assert.equal(withoutHash.action, 'requeue_review');
  if (withoutHash.action === 'requeue_review') {
    assert.match(withoutHash.reason, /STALE_BROADCAST_RECONCILED/);
  }
});
