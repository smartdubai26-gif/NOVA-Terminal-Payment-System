import assert from 'node:assert';
import {
  toTokenUnits,
  extractTxIdFromError,
  assessDestinationTrust,
  classifyAmlDbError,
} from './guards';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

const VALID_ADDR = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const OTHER_ADDR = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const isAddr = (a: string) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);

console.log('\n=== toTokenUnits ===');

test('1 USDT -> 1000000', () => {
  assert.strictEqual(toTokenUnits(1), 1_000_000);
});

test('1.5 USDT -> 1500000', () => {
  assert.strictEqual(toTokenUnits(1.5), 1_500_000);
});

test('0.000001 USDT -> 1', () => {
  assert.strictEqual(toTokenUnits(0.000001), 1);
});

test('0 -> 0 (rejected)', () => {
  assert.strictEqual(toTokenUnits(0), 0);
});

test('negative -> 0 (rejected)', () => {
  assert.strictEqual(toTokenUnits(-5), 0);
});

test('NaN -> 0 (rejected)', () => {
  assert.strictEqual(toTokenUnits(NaN), 0);
});

test('Infinity -> 0 (rejected)', () => {
  assert.strictEqual(toTokenUnits(Infinity), 0);
});

test('sub-unit 1.0000005 -> 0 (rejected without truncation)', () => {
  assert.strictEqual(toTokenUnits(1.0000005), 0);
});

test('sub-unit 1.0000009 -> 0 (rejected without rounding)', () => {
  assert.strictEqual(toTokenUnits(1.0000009), 0);
});

test('0.1 + 0.2 float precision -> 300000', () => {
  assert.strictEqual(toTokenUnits(0.1 + 0.2), 300_000);
});

test('1,000,000 USDT -> 1e12', () => {
  assert.strictEqual(toTokenUnits(1_000_000), 1_000_000_000_000);
});

test('exceeds MAX_SAFE_INTEGER -> 0 (rejected)', () => {
  assert.strictEqual(toTokenUnits(1e15), 0);
});

console.log('\n=== extractTxIdFromError ===');

const TXID = 'a'.repeat(64);

test('err.txid', () => {
  assert.strictEqual(extractTxIdFromError({ txid: TXID }), TXID);
});

test('err.txId', () => {
  assert.strictEqual(extractTxIdFromError({ txId: TXID }), TXID);
});

test('err.transaction.txID', () => {
  assert.strictEqual(extractTxIdFromError({ transaction: { txID: TXID } }), TXID);
});

test('err.response.txid', () => {
  assert.strictEqual(extractTxIdFromError({ response: { txid: TXID } }), TXID);
});

test('txid in Error message', () => {
  assert.strictEqual(
    extractTxIdFromError(new Error(`broadcast failed for ${TXID}`)),
    TXID
  );
});

test('no txid -> null', () => {
  assert.strictEqual(extractTxIdFromError(new Error('network timeout')), null);
});

test('non-64 hex -> null', () => {
  assert.strictEqual(extractTxIdFromError({ txid: 'abc123' }), null);
});

console.log('\n=== assessDestinationTrust (W-01) ===');

test('verified=true valid address without snapshot -> trusted', () => {
  const v = assessDestinationTrust(
    { address: VALID_ADDR, network: 'TRC20', verified: true },
    null,
    isAddr
  );
  assert.strictEqual(v.trusted, true);
});

test('verified=false -> untrusted', () => {
  const v = assessDestinationTrust(
    { address: VALID_ADDR, network: 'TRC20', verified: false },
    null,
    isAddr
  );
  assert.strictEqual(v.trusted, false);
  assert.match(String(v.reason), /not explicitly verified/);
});

test('verified=null -> untrusted (no default assumption)', () => {
  const v = assessDestinationTrust(
    { address: VALID_ADDR, network: 'TRC20', verified: null },
    null,
    isAddr
  );
  assert.strictEqual(v.trusted, false);
});

test('verified=undefined -> untrusted (missing column fails closed)', () => {
  const v = assessDestinationTrust(
    { address: VALID_ADDR, network: 'TRC20' },
    null,
    isAddr
  );
  assert.strictEqual(v.trusted, false);
});

test('blank address -> untrusted', () => {
  const v = assessDestinationTrust(
    { address: '   ', network: 'TRC20', verified: true },
    null,
    isAddr
  );
  assert.strictEqual(v.trusted, false);
});

test('invalid Base58Check address -> untrusted', () => {
  const v = assessDestinationTrust(
    { address: 'not-a-tron-address', network: 'TRC20', verified: true },
    null,
    isAddr
  );
  assert.strictEqual(v.trusted, false);
  assert.match(String(v.reason), /Base58Check/);
});

test('TOCTOU mismatch against destination_snapshot -> untrusted', () => {
  const v = assessDestinationTrust(
    { address: OTHER_ADDR, network: 'TRC20', verified: true },
    VALID_ADDR,
    isAddr
  );
  assert.strictEqual(v.trusted, false);
  assert.match(String(v.reason), /changed after approval/);
});

test('matching destination_snapshot -> trusted', () => {
  const v = assessDestinationTrust(
    { address: VALID_ADDR, network: 'TRC20', verified: true },
    VALID_ADDR,
    isAddr
  );
  assert.strictEqual(v.trusted, true);
});

test('blank destination_snapshot -> trusted for legacy backfill compatibility', () => {
  const v = assessDestinationTrust(
    { address: VALID_ADDR, network: 'TRC20', verified: true },
    '   ',
    isAddr
  );
  assert.strictEqual(v.trusted, true);
});

console.log('\n=== classifyAmlDbError (W-03) ===');

test('42P01 (undefined_table) -> table_missing', () => {
  assert.strictEqual(
    classifyAmlDbError({ code: '42P01', message: 'relation "public.aml_blocked_addresses" does not exist' }),
    'table_missing'
  );
});

test('PGRST205 (schema cache) -> table_missing', () => {
  assert.strictEqual(
    classifyAmlDbError({ code: 'PGRST205', message: "Could not find the table 'public.aml_blocked_addresses'" }),
    'table_missing'
  );
});

test('does not exist message without code -> table_missing', () => {
  assert.strictEqual(
    classifyAmlDbError(new Error('relation "aml_blocked_addresses" does not exist')),
    'table_missing'
  );
});

test('ETIMEDOUT -> transient', () => {
  assert.strictEqual(classifyAmlDbError({ code: 'ETIMEDOUT', message: 'timeout' }), 'transient');
});

test('ECONNRESET -> transient', () => {
  assert.strictEqual(classifyAmlDbError({ code: 'ECONNRESET', message: 'socket hang up' }), 'transient');
});

test('fetch failed -> transient', () => {
  assert.strictEqual(classifyAmlDbError(new Error('TypeError: fetch failed')), 'transient');
});

test('PGRST301 -> transient', () => {
  assert.strictEqual(classifyAmlDbError({ code: 'PGRST301', message: 'JWT expired' }), 'transient');
});

test('PGRST116 -> unknown (fail-closed)', () => {
  assert.strictEqual(
    classifyAmlDbError({ code: 'PGRST116', message: 'JSON object requested, multiple rows returned' }),
    'unknown'
  );
});

test('XX000 -> unknown (fail-closed)', () => {
  assert.strictEqual(classifyAmlDbError({ code: 'XX000', message: 'internal error' }), 'unknown');
});

test('null -> unknown (fail-closed)', () => {
  assert.strictEqual(classifyAmlDbError(null), 'unknown');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
