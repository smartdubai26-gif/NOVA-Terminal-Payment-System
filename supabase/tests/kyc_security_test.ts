import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Minimal localStorage + window shim so ledgerEngine runs deterministically in Node
const memoryStorage = new Map<string, string>();
(globalThis as unknown as { window: { localStorage: Storage } }).window = {
  localStorage: {
    get length() {
      return memoryStorage.size;
    },
    clear() {
      memoryStorage.clear();
    },
    getItem(key: string) {
      return memoryStorage.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(memoryStorage.keys())[index] ?? null;
    },
    removeItem(key: string) {
      memoryStorage.delete(key);
    },
    setItem(key: string, value: string) {
      memoryStorage.set(key, String(value));
    },
  },
};

const ledger = await import('../../src/lib/ledgerEngine.ts');

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');

function readMigration(filename: string): string {
  const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

function makeAgeDob(yearsAgo: number, offsetDays = 0): string {
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear() - yearsAgo, now.getUTCMonth(), now.getUTCDate() + offsetDays)
  );
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  memoryStorage.clear();
});

test('SQL migrations 010–012 enforce KYC-1..5 and Round-6 NEW-A/B/D invariants', () => {
  const m010 = readMigration('010_kyc_verification_system.sql');
  const m011 = readMigration('011_harden_kyc_verification.sql');
  const m012 = readMigration('012_kyc_audit_round6_hardening.sql');

  // 010: Private bucket + RPC + hard gates
  assert.match(m010, /'kyc-documents',\s*'kyc-documents',\s*false/i);
  assert.match(m010, /CREATE OR REPLACE FUNCTION public\.bootstrap_user_terminal[\s\S]*is_user_kyc_approved\(v_uid\)/);
  assert.match(m010, /CREATE OR REPLACE FUNCTION public\.provision_sub_terminal_atomic[\s\S]*is_user_kyc_approved\(v_uid\)/);
  assert.match(m010, /CREATE OR REPLACE FUNCTION public\.request_crypto_withdrawal[\s\S]*is_user_kyc_approved\(v_uid\)/);

  // 011: KYC-2 storage delete/update locks, KYC-4 SECURITY INVOKER without GUC bypass, KYC-5 revokes, NEW-B guard
  assert.match(m011, /CREATE POLICY "kyc_docs_owner_delete"[\s\S]*status IN \('pending_review', 'approved'\)/);
  assert.match(m011, /CREATE POLICY "kyc_docs_owner_update"[\s\S]*status IN \('pending_review', 'approved'\)/);
  assert.match(m011, /CREATE OR REPLACE FUNCTION public\.enforce_kyc_immutability_and_guard\(\)[\s\S]*SECURITY INVOKER/);
  assert.doesNotMatch(m011, /current_setting\('ntps\.kyc_rpc_bypass'/);
  assert.doesNotMatch(m011, /set_config\('ntps\.kyc_rpc_bypass'/);
  assert.match(m011, /REVOKE EXECUTE ON FUNCTION public\.is_user_kyc_approved\(UUID\) FROM authenticated;/);
  assert.match(m011, /CREATE OR REPLACE FUNCTION public\.is_my_kyc_approved\(\)/);
  assert.match(m011, /IF v_violating_count = 0 THEN[\s\S]*VALIDATE CONSTRAINT chk_kyc_dob_and_minimum_age/);

  // 012: NEW-A unique index on upper(trim(id_number)) alone, NEW-D ON DELETE RESTRICT
  assert.match(m012, /DROP INDEX IF EXISTS public\.idx_kyc_submissions_approved_id_unique;/);
  const idxMatch = m012.match(
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_kyc_submissions_approved_id_number_unique[\s\S]*?;/
  );
  assert.ok(idxMatch, 'Expected idx_kyc_submissions_approved_id_number_unique definition');
  assert.match(idxMatch[0], /ON public\.kyc_submissions \(upper\(trim\(id_number\)\)\)/);
  assert.doesNotMatch(idxMatch[0], /id_type/);
  const reviewDupMatch = m012.match(/IF EXISTS \(\s*SELECT 1\s*FROM public\.kyc_submissions other[\s\S]*?\) THEN/);
  assert.ok(reviewDupMatch, 'Expected review_kyc_submission duplicate identity query');
  assert.doesNotMatch(reviewDupMatch[0], /id_type/);
  assert.match(m012, /ON DELETE RESTRICT/);
  assert.match(m012, /ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ/);
});

test('SQL migrations 005, 008, 009 & preflight check enforce RBAC, worker leases, and NEW-F verified=false default', () => {
  const m005 = readMigration('005_admin_rbac.sql');
  const m008 = readMigration('008_stage2_defensive_hardening.sql');
  const m009 = readMigration('009_worker_destination_trust.sql');
  const preflight = fs.readFileSync(path.resolve(process.cwd(), 'supabase/tests/kyc_preflight_check.sql'), 'utf8');

  assert.match(m005, /CREATE TABLE IF NOT EXISTS public\.app_admins/);
  assert.match(m005, /CREATE OR REPLACE FUNCTION public\.is_ntps_admin/);
  assert.match(m008, /CREATE OR REPLACE FUNCTION public\.acquire_worker_lease/);
  assert.match(m008, /CREATE OR REPLACE FUNCTION public\.release_worker_lease/);
  assert.match(m009, /ALTER TABLE public\.whitelist_addresses\s+ALTER COLUMN verified SET DEFAULT FALSE;/);
  assert.match(m009, /ADD COLUMN IF NOT EXISTS destination_snapshot TEXT;/);
  assert.match(m009, /CREATE OR REPLACE FUNCTION public\.verify_whitelist_address_admin/);
  assert.match(preflight, /date_of_birth > \(CURRENT_DATE - INTERVAL '18 years'\)::date/);
  assert.match(preflight, /GROUP BY upper\(trim\(id_number\)\)/);
});

test('KYC-3: validateKycDateOfBirth allows nullable corporate DOB and enforces >= 18 for individuals', () => {
  // Corporate: empty / null allowed; valid past date allowed; future date rejected
  assert.equal(ledger.validateKycDateOfBirth('corporate', ''), null);
  assert.equal(ledger.validateKycDateOfBirth('corporate', null), null);
  assert.equal(ledger.validateKycDateOfBirth('corporate', '2019-06-15'), '2019-06-15');
  assert.throws(
    () => ledger.validateKycDateOfBirth('corporate', makeAgeDob(-1)),
    /Incorporation date cannot be in the future/
  );

  // Individual: empty rejected, underage rejected, invalid calendar rejected, >= 18 accepted
  assert.throws(
    () => ledger.validateKycDateOfBirth('individual', ''),
    /Date of birth is required/
  );
  assert.throws(
    () => ledger.validateKycDateOfBirth('individual', '2000-02-31'),
    /Invalid calendar date/
  );
  assert.throws(
    () => ledger.validateKycDateOfBirth('individual', makeAgeDob(17)),
    /at least 18 years old/
  );
  assert.throws(
    () => ledger.validateKycDateOfBirth('individual', makeAgeDob(18, 1)),
    /at least 18 years old/
  );
  const exactAdult = makeAgeDob(18, 0);
  assert.equal(ledger.validateKycDateOfBirth('individual', exactAdult), exactAdult);
});

test('KYC-2: validateKycDocumentFile restricts to PDF/JPG/PNG <= 10 MB', () => {
  const validPdf = new File([new Uint8Array(1024)], 'proof.pdf', { type: 'application/pdf' });
  assert.deepEqual(ledger.validateKycDocumentFile(validPdf), {
    mimeType: 'application/pdf',
    ext: 'pdf',
  });

  const badSvg = new File(['<svg></svg>'], 'xss.svg', { type: 'image/svg+xml' });
  assert.throws(() => ledger.validateKycDocumentFile(badSvg), /Unsupported file type/);

  const tooBig = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.png', {
    type: 'image/png',
  });
  assert.throws(() => ledger.validateKycDocumentFile(tooBig), /10 MB/);
});

test('KYC-1 & NEW-A: blocks approving duplicate id_number even with a different id_type, allows rejected resubmission', async () => {
  const userId = '99999999-9999-4999-8999-999999999901';
  const adultDob = makeAgeDob(26);

  // Seeded corporate KYB in demo queue has id_number 'CHE-419.802.311' (pending_review).
  // Approve it first.
  const initialState = await ledger.loadLedgerState({ authMode: 'local_demo', userId });
  const seededId = initialState.kycQueue[0]!.id;
  await ledger.reviewKycSubmission({
    submissionId: seededId,
    decision: 'approved',
    reason: 'Corporate KYB verified',
    authMode: 'local_demo',
    userId,
  });

  // Now operator submits Individual KYC using the SAME id_number under 'passport' instead of 'commercial_registry'
  const { submission: subAttempt1 } = await ledger.submitKycSubmission({
    userId,
    authMode: 'local_demo',
    input: {
      account_type: 'individual',
      full_legal_name: 'Nadia Mansour',
      date_of_birth: adultDob,
      nationality: 'Switzerland',
      country_of_residence: 'United Arab Emirates',
      id_type: 'passport',
      id_number: '  che-419.802.311 ',
      phone_number: '+971504128890',
      address_line: 'DIFC Gate Village 4, Dubai',
      id_front_path: `${userId}/id_front-1.png`,
      selfie_path: `${userId}/selfie-1.jpg`,
      proof_of_address_path: `${userId}/poa-1.pdf`,
    },
  });

  // NEW-A: Approval MUST fail even though id_type changed ('passport' vs 'commercial_registry')!
  await assert.rejects(
    () =>
      ledger.reviewKycSubmission({
        submissionId: subAttempt1.id,
        decision: 'approved',
        reason: 'Attempted bypass via id_type switch',
        authMode: 'local_demo',
        userId,
      }),
    /Duplicate identity conflict/
  );

  // Reject attempt 1 with a unique rejection reason, then resubmit with a unique ID and approve
  await ledger.reviewKycSubmission({
    submissionId: subAttempt1.id,
    decision: 'rejected',
    reason: 'Provide personal passport number instead of corporate registry',
    authMode: 'local_demo',
    userId,
  });

  const { submission: subAttempt2 } = await ledger.submitKycSubmission({
    userId,
    authMode: 'local_demo',
    input: {
      account_type: 'individual',
      full_legal_name: 'Nadia Mansour',
      date_of_birth: adultDob,
      nationality: 'Switzerland',
      country_of_residence: 'United Arab Emirates',
      id_type: 'passport',
      id_number: 'P84920144',
      phone_number: '+971504128890',
      address_line: 'DIFC Gate Village 4, Dubai',
      id_front_path: `${userId}/id_front-2.png`,
      selfie_path: `${userId}/selfie-2.jpg`,
      proof_of_address_path: `${userId}/poa-2.pdf`,
    },
  });

  const approvedState = await ledger.reviewKycSubmission({
    submissionId: subAttempt2.id,
    decision: 'approved',
    reason: 'Unique passport verified',
    authMode: 'local_demo',
    userId,
  });
  assert.equal(approvedState.kycSubmission?.status, 'approved');
});

test('KYC Gate Parity: unverified user is blocked from sub-terminals and withdrawals until approved', async () => {
  const userId = '99999999-9999-4999-8999-999999999901';
  const seed = await ledger.loadLedgerState({ authMode: 'local_demo', userId });
  const master = seed.terminals.find((t) => t.type === 'master')!;
  const wl = seed.whitelistAddresses[0]!;

  // Blocked while unverified
  await assert.rejects(
    () =>
      ledger.provisionSubTerminal({
        label: 'Blocked Desk',
        dailyLimitUsd: 50000,
        perTxLimitUsd: 10000,
        allowedAssets: ['USDT'],
        authMode: 'local_demo',
      }),
    /KYC\/KYB approval is required/
  );

  await assert.rejects(
    () =>
      ledger.performWithdrawal({
        terminalUuid: master.id,
        asset: wl.asset,
        network: wl.network,
        destinationAddress: wl.address,
        whitelistAddressId: wl.id,
        amount: 100,
        memo: 'Blocked unverified test',
        authMode: 'local_demo',
      }),
    /KYC\/KYB approval is required/
  );

  // Submit Corporate KYB WITHOUT date_of_birth (testing KYC-3 corporate optional DOB + approval unlock)
  const { submission } = await ledger.submitKycSubmission({
    userId,
    authMode: 'local_demo',
    input: {
      account_type: 'corporate',
      full_legal_name: 'Apex Clearing AG',
      date_of_birth: null,
      nationality: 'Switzerland',
      country_of_residence: 'Switzerland',
      id_type: 'commercial_registry',
      id_number: 'CHE-991.220.440',
      tax_or_reg_number: 'CHE-991.220.440-MWST',
      phone_number: '+41445800001',
      address_line: 'Paradeplatz 8, 8001 Zurich',
      id_front_path: `${userId}/id_front-corp.pdf`,
      id_back_path: `${userId}/id_back-corp.pdf`,
      selfie_path: `${userId}/selfie-corp.jpg`,
      proof_of_address_path: `${userId}/poa-corp.pdf`,
    },
  });

  await ledger.reviewKycSubmission({
    submissionId: submission.id,
    decision: 'approved',
    reason: 'Corporate KYB approved',
    authMode: 'local_demo',
    userId,
  });

  const subRes = await ledger.provisionSubTerminal({
    label: 'Approved KYB Desk',
    dailyLimitUsd: 50000,
    perTxLimitUsd: 10000,
    allowedAssets: ['USDT'],
    authMode: 'local_demo',
  });
  assert.ok(subRes.terminal.terminalId.startsWith(master.terminalId));

  const wdRes = await ledger.performWithdrawal({
    terminalUuid: master.id,
    asset: wl.asset,
    network: wl.network,
    destinationAddress: wl.address,
    whitelistAddressId: wl.id,
    amount: 100,
    memo: 'Approved KYB withdrawal test',
    authMode: 'local_demo',
  });
  assert.equal(wdRes.transaction.type, 'withdrawal');
});
