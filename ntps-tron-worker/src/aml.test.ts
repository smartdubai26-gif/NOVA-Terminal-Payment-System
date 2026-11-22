/**
 * اختبارات W-03 — بوابة الـ AML نفسها (screenWithdrawalDestination).
 * تشغيل: node dist/aml.test.js
 *
 * الفكرة: نمرّر SupabaseClient مزيّف بيرجّع أخطاء مختلفة، ونتأكد إن
 * **أي** خطأ = منع البث (fail-closed)، إلا حالة واحدة صريحة.
 */
import assert from 'node:assert';
import { screenWithdrawalDestination } from './aml';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void>): Promise<void> {
  return fn().then(
    () => {
      passed += 1;
      console.log(`  PASS  ${name}`);
    },
    (err) => {
      failed += 1;
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err instanceof Error ? err.message : String(err)}`);
    }
  );
}

const VALID_ADDR = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const BURN_ADDR = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

// TronWeb مزيّف — تحقق شكلي فقط
const fakeTronWeb = {
  isAddress: (a: string) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a),
} as never;

/**
 * Supabase مزيّف. `outcome` بيحدد نتيجة الاستعلام:
 *   { data, error } أو { throws: Error }
 */
function fakeSupabase(outcome: {
  data?: Record<string, unknown> | null;
  error?: unknown;
  throws?: unknown;
}): never {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = chain;
  builder.eq = chain;
  builder.maybeSingle = async () => {
    if (outcome.throws) throw outcome.throws;
    return { data: outcome.data ?? null, error: outcome.error ?? null };
  };
  return { from: () => builder } as never;
}

async function main(): Promise<void> {
  console.log('\n=== screenWithdrawalDestination — W-03 (fail-closed) ===');

  // ---------- الحالات اللي لازم تمنع ----------

  await test('خطأ شبكة عابر (ETIMEDOUT) → ممنوع + degraded', async () => {
    const r = await screenWithdrawalDestination(
      fakeSupabase({ error: { code: 'ETIMEDOUT', message: 'timeout' } }),
      fakeTronWeb,
      VALID_ADDR,
      'TRC20'
    );
    assert.strictEqual(r.allowed, false, 'لازم يمنع البث وقت عطل الشبكة');
    assert.strictEqual(r.degraded, true);
    assert.strictEqual(r.riskLevel, 'unavailable');
  });

  await test('fetch failed → ممنوع + degraded', async () => {
    const r = await screenWithdrawalDestination(
      fakeSupabase({ error: new Error('TypeError: fetch failed') }),
      fakeTronWeb,
      VALID_ADDR,
      'TRC20'
    );
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.degraded, true);
  });

  await test('استثناء متزامن (throw) → ممنوع + degraded', async () => {
    const r = await screenWithdrawalDestination(
      fakeSupabase({ throws: new Error('socket hang up') }),
      fakeTronWeb,
      VALID_ADDR,
      'TRC20'
    );
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.degraded, true);
  });

  await test('خطأ مجهول (XX000) → ممنوع + degraded', async () => {
    const r = await screenWithdrawalDestination(
      fakeSupabase({ error: { code: 'XX000', message: 'internal error' } }),
      fakeTronWeb,
      VALID_ADDR,
      'TRC20'
    );
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.degraded, true);
  });

  await test('PGRST116 (أكتر من صف) → ممنوع (مش بنفترض إن مفيش تطابق)', async () => {
    const r = await screenWithdrawalDestination(
      fakeSupabase({
        error: { code: 'PGRST116', message: 'JSON object requested, multiple rows returned' },
      }),
      fakeTronWeb,
      VALID_ADDR,
      'TRC20'
    );
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.degraded, true);
  });

  await test('جدول ناقص (42P01) بدون تفعيل degraded → ممنوع', async () => {
    delete process.env.AML_ALLOW_DEGRADED_MODE;
    const r = await screenWithdrawalDestination(
      fakeSupabase({
        error: { code: '42P01', message: 'relation "public.aml_blocked_addresses" does not exist' },
      }),
      fakeTronWeb,
      VALID_ADDR,
      'TRC20'
    );
    assert.strictEqual(r.allowed, false, 'غياب الجدول مش مبرر للسماح');
    assert.strictEqual(r.degraded, true);
    assert.match(String(r.reason), /migration 004/);
  });

  await test('عنوان محظور في السجل → ممنوع (blocked، مش degraded)', async () => {
    const r = await screenWithdrawalDestination(
      fakeSupabase({
        data: { address: VALID_ADDR, reason: 'OFAC SDN', risk_level: 'sanctioned', source: 'ofac' },
      }),
      fakeTronWeb,
      VALID_ADDR,
      'TRC20'
    );
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.degraded, undefined, 'ده قرار امتثال نهائي مش عطل');
    assert.strictEqual(r.riskLevel, 'sanctioned');
  });

  await test('عنوان حرق مدمج → ممنوع', async () => {
    const r = await screenWithdrawalDestination(
      fakeSupabase({ data: null }),
      fakeTronWeb,
      BURN_ADDR,
      'TRC20'
    );
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.source, 'builtin_policy');
  });

  await test('عنوان غير صالح → ممنوع', async () => {
    const r = await screenWithdrawalDestination(
      fakeSupabase({ data: null }),
      fakeTronWeb,
      'not-an-address',
      'TRC20'
    );
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.riskLevel, 'invalid');
  });

  await test('قائمة البيئة AML_BLOCKED_ADDRESSES → ممنوع', async () => {
    process.env.AML_BLOCKED_ADDRESSES = VALID_ADDR;
    const r = await screenWithdrawalDestination(
      fakeSupabase({ data: null }),
      fakeTronWeb,
      VALID_ADDR,
      'TRC20'
    );
    delete process.env.AML_BLOCKED_ADDRESSES;
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.source, 'env_aml_list');
  });

  // ---------- الحالة الوحيدة المسموح فيها ----------

  await test('فحص ناجح ومفيش تطابق → مسموح', async () => {
    const r = await screenWithdrawalDestination(
      fakeSupabase({ data: null }),
      fakeTronWeb,
      VALID_ADDR,
      'TRC20'
    );
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.degraded, undefined);
    assert.strictEqual(r.source, 'aml_registry_clear');
  });

  await test('جدول ناقص + AML_ALLOW_DEGRADED_MODE=true صراحةً → مسموح + degraded', async () => {
    process.env.AML_ALLOW_DEGRADED_MODE = 'true';
    const r = await screenWithdrawalDestination(
      fakeSupabase({
        error: { code: '42P01', message: 'relation "public.aml_blocked_addresses" does not exist' },
      }),
      fakeTronWeb,
      VALID_ADDR,
      'TRC20'
    );
    delete process.env.AML_ALLOW_DEGRADED_MODE;
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.degraded, true);
    assert.strictEqual(r.source, 'degraded_no_registry');
  });

  await test('degraded=true لا يسمح بتجاوز عطل شبكة (فقط غياب الجدول)', async () => {
    process.env.AML_ALLOW_DEGRADED_MODE = 'true';
    const r = await screenWithdrawalDestination(
      fakeSupabase({ error: { code: 'ETIMEDOUT', message: 'timeout' } }),
      fakeTronWeb,
      VALID_ADDR,
      'TRC20'
    );
    delete process.env.AML_ALLOW_DEGRADED_MODE;
    assert.strictEqual(r.allowed, false, 'العطل العابر لازم يفضل ممنوع حتى في degraded mode');
  });

  console.log(`\n=== النتيجة: ${passed} نجح، ${failed} فشل ===\n`);
  if (failed > 0) process.exit(1);
}

void main();
