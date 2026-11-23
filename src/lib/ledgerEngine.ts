import {
  buildMasterTerminalIdFromSeed,
  deriveDepositAddress,
  generateMasterTerminalId,
  generateSubTerminalId,
  generateTxHash,
  validateTerminalId,
} from './terminalId';
import { isSupabaseConfigured, supabase } from './supabase';
import { clearDemoTwoFactorGuard } from './totp';
import type {
  AdminProfile,
  AdminRole,
  AssetRateMap,
  AssetSymbol,
  AuditLogRecord,
  CounterpartyInfo,
  DepositAddressRecord,
  InvoiceRecord,
  JournalEntry,
  KycAccountType,
  KycIdType,
  KycStatus,
  KycSubmissionInput,
  KycSubmissionRecord,
  LedgerInvariantResult,
  LedgerPosting,
  NetworkId,
  TerminalRecord,
  TerminalStatus,
  TradingAccount,
  TransactionRecord,
  TransactionType,
  WalletBalance,
  WhitelistAddress,
  WithdrawalRequestRecord,
} from '../types/ntps';

export type LedgerRuntimeMode = 'supabase' | 'local_demo';

function isLiveSupabaseMode(authMode?: LedgerRuntimeMode): boolean {
  return Boolean(authMode === 'supabase' && isSupabaseConfigured && supabase);
}

export const ASSET_USD_RATES: Record<AssetSymbol, number> = {
  USDT: 1.0,
  BTC: 91420.0,
  ETH: 3285.0,
};

export const ASSET_NETWORKS: Record<AssetSymbol, NetworkId[]> = {
  USDT: ['TRC20', 'ERC20'],
  BTC: ['BTC'],
  ETH: ['ETH', 'ARBITRUM'],
};

/**
 * Live on-chain integration scope:
 * Only `TRC20` (USDT) is monitored and broadcast on-chain by `ntps-tron-worker`.
 * All other external chain rails (`ERC20`, `BTC`, `ETH`, `ARBITRUM`) are simulated / ledger-only.
 */
export const LIVE_ONCHAIN_NETWORKS: ReadonlySet<NetworkId> = new Set<NetworkId>(['TRC20']);

export const SIMULATED_NETWORKS: ReadonlySet<NetworkId> = new Set<NetworkId>([
  'ERC20',
  'BTC',
  'ETH',
  'ARBITRUM',
]);

export function isSimulatedNetwork(network: NetworkId): boolean {
  return SIMULATED_NETWORKS.has(network);
}

export const NETWORK_LABELS: Record<NetworkId, string> = {
  TRC20: 'TRC-20',
  ERC20: 'ERC-20',
  BTC: 'Bitcoin SegWit',
  ETH: 'Ethereum Mainnet',
  ARBITRUM: 'Arbitrum One',
  NTPS_INTERNAL: 'NTPS Internal',
};

export function formatNetworkOptionLabel(asset: AssetSymbol, network: NetworkId): string {
  const baseLabel = NETWORK_LABELS[network] ?? network;
  return isSimulatedNetwork(network) ? `${asset} (${baseLabel} · Simulated)` : `${asset} (${baseLabel})`;
}

export const NETWORK_FEES: Record<NetworkId, { amount: number; asset: AssetSymbol; eta: string }> = {
  TRC20: { amount: 1.0, asset: 'USDT', eta: '~45 sec' },
  ERC20: { amount: 4.5, asset: 'USDT', eta: '~2 min' },
  BTC: { amount: 0.00018, asset: 'BTC', eta: '~15 min' },
  ETH: { amount: 0.0012, asset: 'ETH', eta: '~2 min' },
  ARBITRUM: { amount: 0.00015, asset: 'ETH', eta: '~12 sec' },
  NTPS_INTERNAL: { amount: 0, asset: 'USDT', eta: '< 250 ms' },
};

export interface NtpsLedgerState {
  terminals: TerminalRecord[];
  wallets: WalletBalance[];
  journalEntries: JournalEntry[];
  ledgerPostings: LedgerPosting[];
  transactions: TransactionRecord[];
  whitelistAddresses: WhitelistAddress[];
  invoices: InvoiceRecord[];
  tradingAccounts: TradingAccount[];
  auditLogs: AuditLogRecord[];
  depositAddresses: DepositAddressRecord[];
  withdrawalRequests: WithdrawalRequestRecord[];
  kycSubmission: KycSubmissionRecord | null;
  kycQueue: KycSubmissionRecord[];
  dailyWithdrawnUsd: number;
  assetRates: AssetRateMap;
  assetRatesSource?: string;
  assetRatesUpdatedAt?: string;
}

const STORAGE_KEY = 'ntps_ledger_state_v3';
const DEMO_KYC_DOCS_STORAGE_KEY = 'ntps_demo_kyc_docs_v1';

export const KYC_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
export const KYC_ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);

export const MASTER_TERMINAL_ID = buildMasterTerminalIdFromSeed('7K9P3M2');
export const CP_APEX_ID = buildMasterTerminalIdFromSeed('4R8V2N6');
export const CP_MERIDIAN_ID = buildMasterTerminalIdFromSeed('9W3H5T1');
export const CP_SOLSTICE_ID = buildMasterTerminalIdFromSeed('6C7J4Q8');
export const CP_VANGUARD_ID = buildMasterTerminalIdFromSeed('2F5G8B3');

export const COUNTERPARTY_DIRECTORY: CounterpartyInfo[] = [
  {
    terminalId: CP_APEX_ID,
    masked_name: 'A*** R***',
    entity_type: 'Apex Reserve Clearing',
    verified: true,
    tier: 'Institutional Tier I',
  },
  {
    terminalId: CP_MERIDIAN_ID,
    masked_name: 'M*** T***',
    entity_type: 'Meridian OTC Liquidity',
    verified: true,
    tier: 'Prime Desk',
  },
  {
    terminalId: CP_SOLSTICE_ID,
    masked_name: 'S*** H***',
    entity_type: 'Solstice Quant Fund',
    verified: true,
    tier: 'Gold Counterparty',
  },
  {
    terminalId: CP_VANGUARD_ID,
    masked_name: 'V*** K***',
    entity_type: 'Vanguard Prime Custody',
    verified: true,
    tier: 'Institutional Tier I',
  },
];

export function secureRandomInt(minInclusive: number, maxInclusive: number): number {
  if (
    typeof globalThis.crypto === 'undefined' ||
    typeof globalThis.crypto.getRandomValues !== 'function'
  ) {
    throw new Error('Cryptographic randomness (crypto.getRandomValues) is required.');
  }
  const range = maxInclusive - minInclusive + 1;
  if (!Number.isInteger(range) || range <= 0) {
    throw new Error('Invalid integer range for secureRandomInt.');
  }
  const arr = new Uint32Array(1);
  const maxValid = Math.floor(0x1_0000_0000 / range) * range;
  let value = 0;
  do {
    globalThis.crypto.getRandomValues(arr);
    value = arr[0];
  } while (value >= maxValid);
  return minInclusive + (value % range);
}

export function createUuid(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  if (
    typeof globalThis.crypto === 'undefined' ||
    typeof globalThis.crypto.getRandomValues !== 'function'
  ) {
    throw new Error('Cryptographic randomness (crypto.getRandomValues) is required.');
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function resolveTerminalCode(
  terminals: TerminalRecord[],
  terminalUuid?: string | null
): string {
  if (!terminalUuid) return '—';
  const match = terminals.find((t) => t.id === terminalUuid);
  return match ? match.terminalId : terminalUuid;
}

export function resolveCounterpartyPreview(
  terminalId: string,
  terminals: TerminalRecord[]
): CounterpartyInfo | null {
  const validation = validateTerminalId(terminalId);
  if (!validation.isValid) return null;
  const norm = validation.normalized;

  const owned = terminals.find((t) => t.terminalId === norm);
  if (owned) {
    const words = owned.label.split(' ').filter(Boolean);
    const masked =
      words.length >= 2
        ? `${words[0][0]}*** ${words[1][0]}***`
        : `${owned.label[0] ?? 'N'}*** T***`;
    return {
      terminalId: owned.terminalId,
      masked_name: masked,
      entity_type: `Internal ${owned.type === 'master' ? 'Master' : 'Sub-Terminal'} · ${owned.label}`,
      verified: true,
      tier: owned.tier,
    };
  }

  const known = COUNTERPARTY_DIRECTORY.find((c) => c.terminalId === norm);
  if (known) return known;

  const code = norm.replace('NT-OMEGA-', '').slice(0, 4);
  const firstLetter = String.fromCharCode(65 + (code.charCodeAt(0) % 26));
  const secondLetter = String.fromCharCode(65 + (code.charCodeAt(2) % 26));
  return {
    terminalId: norm,
    masked_name: `${firstLetter}*** ${secondLetter}***`,
    entity_type:
      validation.type === 'sub' ? 'Verified External Sub-Terminal' : 'Verified NTPS Counterparty',
    verified: true,
    tier: 'Verified Terminal',
  };
}

function createSeedState(): NtpsLedgerState {
  const now = Date.now();
  const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();

  const ownerUuid = '99999999-9999-4999-8999-999999999901';
  const masterUuid = '11111111-1111-4111-8111-111111111100';
  const sub1Uuid = '11111111-1111-4111-8111-111111111101';
  const sub2Uuid = '11111111-1111-4111-8111-111111111102';
  const sub3Uuid = '11111111-1111-4111-8111-111111111103';

  const sub1Id = generateSubTerminalId(MASTER_TERMINAL_ID, 1);
  const sub2Id = generateSubTerminalId(MASTER_TERMINAL_ID, 2);
  const sub3Id = generateSubTerminalId(MASTER_TERMINAL_ID, 3);

  const terminals: TerminalRecord[] = [
    {
      id: masterUuid,
      terminalId: MASTER_TERMINAL_ID,
      type: 'master',
      parent_id: null,
      owner_user_id: ownerUuid,
      label: 'NOVA Treasury Master',
      tier: 'Gold',
      status: 'active',
      daily_limit_usd: 500000,
      per_tx_limit_usd: 250000,
      allowed_assets: ['USDT', 'BTC', 'ETH'],
      created_at: iso(60 * 24 * 90),
    },
    {
      id: sub1Uuid,
      terminalId: sub1Id,
      type: 'sub',
      parent_id: masterUuid,
      owner_user_id: ownerUuid,
      label: 'Spot Market Making Desk',
      tier: 'Desk',
      status: 'active',
      daily_limit_usd: 200000,
      per_tx_limit_usd: 75000,
      allowed_assets: ['USDT', 'BTC', 'ETH'],
      created_at: iso(60 * 24 * 62),
    },
    {
      id: sub2Uuid,
      terminalId: sub2Id,
      type: 'sub',
      parent_id: masterUuid,
      owner_user_id: ownerUuid,
      label: 'Quant Arbitrage Bot 04',
      tier: 'Desk',
      status: 'active',
      daily_limit_usd: 120000,
      per_tx_limit_usd: 35000,
      allowed_assets: ['USDT', 'ETH'],
      created_at: iso(60 * 24 * 38),
    },
    {
      id: sub3Uuid,
      terminalId: sub3Id,
      type: 'sub',
      parent_id: masterUuid,
      owner_user_id: ownerUuid,
      label: 'Cold Treasury Reserve',
      tier: 'Institutional',
      status: 'active',
      daily_limit_usd: 400000,
      per_tx_limit_usd: 200000,
      allowed_assets: ['USDT', 'BTC'],
      created_at: iso(60 * 24 * 25),
    },
  ];

  const wMasterUsdtTrc = '22222222-2222-4222-8222-222222222201';
  const wMasterUsdtErc = '22222222-2222-4222-8222-222222222202';
  const wMasterBtc = '22222222-2222-4222-8222-222222222203';
  const wMasterEth = '22222222-2222-4222-8222-222222222204';
  const wSub1Usdt = '22222222-2222-4222-8222-222222222205';

  const wallets: WalletBalance[] = [
    {
      id: wMasterUsdtTrc,
      terminalUuid: masterUuid,
      asset: 'USDT',
      network: 'TRC20',
      available: 642500.0,
      pending: 15000.0,
      locked: 25000.0,
      version: 14,
      updated_at: iso(12),
    },
    {
      id: wMasterUsdtErc,
      terminalUuid: masterUuid,
      asset: 'USDT',
      network: 'ERC20',
      available: 284920.5,
      pending: 0,
      locked: 10000.0,
      version: 8,
      updated_at: iso(35),
    },
    {
      id: wMasterBtc,
      terminalUuid: masterUuid,
      asset: 'BTC',
      network: 'BTC',
      available: 11.482,
      pending: 0.25,
      locked: 0.75,
      version: 5,
      updated_at: iso(44),
    },
    {
      id: wMasterEth,
      terminalUuid: masterUuid,
      asset: 'ETH',
      network: 'ETH',
      available: 118.65,
      pending: 4.5,
      locked: 8.0,
      version: 9,
      updated_at: iso(18),
    },
    {
      id: wSub1Usdt,
      terminalUuid: sub1Uuid,
      asset: 'USDT',
      network: 'TRC20',
      available: 145000.0,
      pending: 0,
      locked: 12000.0,
      version: 6,
      updated_at: iso(25),
    },
    {
      id: '22222222-2222-4222-8222-222222222206',
      terminalUuid: sub1Uuid,
      asset: 'BTC',
      network: 'BTC',
      available: 1.85,
      pending: 0,
      locked: 0.15,
      version: 2,
      updated_at: iso(55),
    },
    {
      id: '22222222-2222-4222-8222-222222222207',
      terminalUuid: sub1Uuid,
      asset: 'ETH',
      network: 'ARBITRUM',
      available: 32.4,
      pending: 0,
      locked: 0,
      version: 3,
      updated_at: iso(62),
    },
    {
      id: '22222222-2222-4222-8222-222222222208',
      terminalUuid: sub2Uuid,
      asset: 'USDT',
      network: 'ERC20',
      available: 82400.0,
      pending: 0,
      locked: 5000.0,
      version: 4,
      updated_at: iso(9),
    },
    {
      id: '22222222-2222-4222-8222-222222222209',
      terminalUuid: sub2Uuid,
      asset: 'ETH',
      network: 'ARBITRUM',
      available: 24.8,
      pending: 0,
      locked: 2.2,
      version: 3,
      updated_at: iso(15),
    },
    {
      id: '22222222-2222-4222-8222-222222222210',
      terminalUuid: sub3Uuid,
      asset: 'USDT',
      network: 'TRC20',
      available: 310000.0,
      pending: 0,
      locked: 0,
      version: 2,
      updated_at: iso(180),
    },
    {
      id: '22222222-2222-4222-8222-222222222211',
      terminalUuid: sub3Uuid,
      asset: 'BTC',
      network: 'BTC',
      available: 4.5,
      pending: 0,
      locked: 0,
      version: 1,
      updated_at: iso(240),
    },
  ];

  const je1 = '33333333-3333-4333-8333-333333333301';
  const je2 = '33333333-3333-4333-8333-333333333302';
  const je3 = '33333333-3333-4333-8333-333333333303';
  const je4 = '33333333-3333-4333-8333-333333333304';

  const journalEntries: JournalEntry[] = [
    {
      id: je1,
      kind: 'internal_transfer',
      idempotency_key: 'xfer_NTPS-261118-8841',
      memo: 'Q4 clearing settlement batch',
      created_by: ownerUuid,
      created_at: iso(18),
    },
    {
      id: je2,
      kind: 'sub_allocation',
      idempotency_key: 'sub_NTPS-261118-8839',
      memo: 'Desk Alpha liquidity top-up',
      created_by: ownerUuid,
      created_at: iso(74),
    },
    {
      id: je3,
      kind: 'deposit',
      idempotency_key: 'dep_0x71e8c409ab31f552d98e0144c3a277f90d11e25a6b8c49102d7381f5a9e04128',
      memo: 'Prime custody sweep in',
      created_by: ownerUuid,
      created_at: iso(190),
    },
    {
      id: je4,
      kind: 'withdrawal',
      idempotency_key: 'wd_NTPS-261118-8827',
      memo: 'Fireblocks warm vault rebalance',
      created_by: ownerUuid,
      created_at: iso(410),
    },
  ];

  // Strictly balanced double-entry postings: SUM(amount) === 0 per journal_id
  const ledgerPostings: LedgerPosting[] = [
    {
      id: '44444444-4444-4444-8444-444444444401',
      journal_id: je1,
      account_ref: `wallet:${wMasterUsdtTrc}`,
      asset: 'USDT',
      amount: -125000.0,
      created_at: iso(18),
    },
    {
      id: '44444444-4444-4444-8444-444444444402',
      journal_id: je1,
      account_ref: `counterparty:${CP_APEX_ID}`,
      asset: 'USDT',
      amount: 125000.0,
      created_at: iso(18),
    },
    {
      id: '44444444-4444-4444-8444-444444444403',
      journal_id: je2,
      account_ref: `wallet:${wMasterUsdtTrc}`,
      asset: 'USDT',
      amount: -45000.0,
      created_at: iso(74),
    },
    {
      id: '44444444-4444-4444-8444-444444444404',
      journal_id: je2,
      account_ref: `wallet:${wSub1Usdt}`,
      asset: 'USDT',
      amount: 45000.0,
      created_at: iso(74),
    },
    {
      id: '44444444-4444-4444-8444-444444444405',
      journal_id: je3,
      account_ref: 'system:hot_btc_btc',
      asset: 'BTC',
      amount: -1.25,
      created_at: iso(190),
    },
    {
      id: '44444444-4444-4444-8444-444444444406',
      journal_id: je3,
      account_ref: `wallet:${wMasterBtc}`,
      asset: 'BTC',
      amount: 1.25,
      created_at: iso(190),
    },
    {
      id: '44444444-4444-4444-8444-444444444407',
      journal_id: je4,
      account_ref: `wallet:${wMasterEth}`,
      asset: 'ETH',
      amount: -14.5012,
      created_at: iso(410),
    },
    {
      id: '44444444-4444-4444-8444-444444444408',
      journal_id: je4,
      account_ref: 'system:hot_eth_eth',
      asset: 'ETH',
      amount: 14.5,
      created_at: iso(410),
    },
    {
      id: '44444444-4444-4444-8444-444444444409',
      journal_id: je4,
      account_ref: 'system:fee_revenue_eth',
      asset: 'ETH',
      amount: 0.0012,
      created_at: iso(410),
    },
  ];

  const transactions: TransactionRecord[] = [
    {
      id: '55555555-5555-4555-8555-555555555501',
      reference: 'NTPS-261118-8841',
      terminalUuid: masterUuid,
      counterparty_terminal: CP_APEX_ID,
      type: 'internal_transfer',
      asset: 'USDT',
      network: 'NTPS_INTERNAL',
      amount: 125000.0,
      fee: 0,
      status: 'completed',
      tx_hash: '0x9a4f8c1e72b60d4a883f12e01c79b5a8e41f2d984c12f3081a0b6c7d9e2f3011',
      journal_id: je1,
      memo: 'Q4 clearing settlement batch',
      risk_score: 'Low',
      created_at: iso(18),
    },
    {
      id: '55555555-5555-4555-8555-555555555502',
      reference: 'NTPS-261118-8839',
      terminalUuid: masterUuid,
      counterparty_terminal: sub1Id,
      type: 'sub_allocation',
      asset: 'USDT',
      network: 'NTPS_INTERNAL',
      amount: 45000.0,
      fee: 0,
      status: 'completed',
      tx_hash: '0x4b12e90d31c84a2291f077e3d6c89a1455201bf9e28c3a7109d44f6211c8a004',
      journal_id: je2,
      memo: 'Desk Alpha liquidity top-up',
      risk_score: 'Low',
      created_at: iso(74),
    },
    {
      id: '55555555-5555-4555-8555-555555555503',
      reference: 'NTPS-261118-8832',
      terminalUuid: masterUuid,
      counterparty_terminal: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
      type: 'deposit',
      asset: 'BTC',
      network: 'BTC',
      amount: 1.25,
      fee: 0,
      status: 'completed',
      tx_hash: '0x71e8c409ab31f552d98e0144c3a277f90d11e25a6b8c49102d7381f5a9e04128',
      journal_id: je3,
      memo: 'Prime custody sweep in',
      risk_score: 'Low',
      created_at: iso(190),
    },
    {
      id: '55555555-5555-4555-8555-555555555504',
      reference: 'NTPS-261118-8827',
      terminalUuid: masterUuid,
      counterparty_terminal: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
      type: 'withdrawal',
      asset: 'ETH',
      network: 'ETH',
      amount: 14.5,
      fee: 0.0012,
      status: 'completed',
      tx_hash: '0x33d9f1a77e6c4b0021e88a9d5f4120c3b6a98e14d20f7c8a5b3e1d904c2f881a',
      journal_id: je4,
      memo: 'Fireblocks warm vault rebalance',
      risk_score: 'Medium',
      created_at: iso(410),
    },
    {
      id: '55555555-5555-4555-8555-555555555505',
      reference: 'NTPS-261118-8819',
      terminalUuid: masterUuid,
      counterparty_terminal: CP_MERIDIAN_ID,
      type: 'internal_transfer',
      asset: 'USDT',
      network: 'NTPS_INTERNAL',
      amount: 15000.0,
      fee: 0,
      status: 'pending',
      tx_hash: '0x55c0a81b92e4d70f31a829c0d4e5b6781f902a3b4c5d6e7f8091a2b3c4d5e6f7',
      memo: 'Escrow margin hold release',
      risk_score: 'Low',
      created_at: iso(540),
    },
    {
      id: '55555555-5555-4555-8555-555555555507',
      reference: 'NTPS-261117-8765',
      terminalUuid: masterUuid,
      counterparty_terminal: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      type: 'withdrawal',
      asset: 'USDT',
      network: 'TRC20',
      amount: 42000.0,
      fee: 1.0,
      status: 'pending',
      tx_hash: '0x10b9e4c3d2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5',
      memo: 'Flagged by compliance velocity check: destination awaiting four-eyes review',
      risk_score: 'High',
      created_at: iso(2100),
    },
  ];

  const whitelistAddresses: WhitelistAddress[] = [
    {
      id: '66666666-6666-4666-8666-666666666601',
      terminalUuid: masterUuid,
      label: 'Zurich Cold Custody (TRC-20)',
      asset: 'USDT',
      network: 'TRC20',
      address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
      verified: true,
      created_at: iso(60 * 24 * 30),
    },
    {
      id: '66666666-6666-4666-8666-666666666602',
      terminalUuid: masterUuid,
      label: 'Fireblocks Treasury Vault (ERC-20)',
      asset: 'USDT',
      network: 'ERC20',
      address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
      verified: true,
      created_at: iso(60 * 24 * 20),
    },
  ];

  const invoices: InvoiceRecord[] = [
    {
      id: '77777777-7777-4777-8777-777777777701',
      invoice_number: 'INV-2026-000184',
      terminalUuid: masterUuid,
      payer_terminal_id: CP_APEX_ID,
      asset: 'USDT',
      amount: 75000.0,
      description: 'Institutional liquidity tranche settlement',
      expires_at: new Date(now + 24 * 3600_1000).toISOString(),
      status: 'open',
      signed_uri: `ntps://pay?tid=${MASTER_TERMINAL_ID}&asset=USDT&amount=75000&ref=INV-2026-000184&sig=0x9f81a7b`,
      signature: '0x9f81a7b8e2c4d1109a82b3c4d5e6f7a8b9c0d1e2',
      created_at: iso(120),
    },
    {
      id: '77777777-7777-4777-8777-777777777702',
      invoice_number: 'INV-2026-000183',
      terminalUuid: masterUuid,
      payer_terminal_id: CP_MERIDIAN_ID,
      asset: 'BTC',
      amount: 2.5,
      description: 'OTC Arbitrage margin collateral',
      expires_at: new Date(now - 3600_1000).toISOString(),
      status: 'paid',
      signed_uri: `ntps://pay?tid=${MASTER_TERMINAL_ID}&asset=BTC&amount=2.5&ref=INV-2026-000183&sig=0x4b2c89f`,
      signature: '0x4b2c89f1e2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7',
      created_at: iso(1440),
    },
  ];

  const tradingAccounts: TradingAccount[] = [
    {
      id: '88888888-8888-4888-8888-888888888801',
      terminalUuid: masterUuid,
      account_type: 'nova_margin',
      account_login: 'NOVA-MGIN-98421',
      currency: 'USDT',
      balance: 150000.0,
      free_margin: 142000.0,
      leverage: '1:50',
      status: 'active',
    },
    {
      id: '88888888-8888-4888-8888-888888888802',
      terminalUuid: sub1Uuid,
      account_type: 'mt5_omnibus',
      account_login: 'MT5-OMNI-77210',
      currency: 'USDT',
      balance: 85000.0,
      free_margin: 78500.0,
      leverage: '1:100',
      status: 'active',
    },
  ];

  const auditLogs: AuditLogRecord[] = [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01',
      event_type: 'TERMINAL_PROVISIONED',
      actor: ownerUuid,
      terminalUuid: masterUuid,
      terminalId: MASTER_TERMINAL_ID,
      details: 'Master treasury vault initialized with Crockford Mod-37 check key.',
      severity: 'info',
      prev_hash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      row_hash: '0xa1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
      created_at: iso(60 * 24 * 90),
    },
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02',
      event_type: 'COMPLIANCE_FLAG_RAISED',
      actor: 'system-risk-sentinel',
      terminalUuid: masterUuid,
      terminalId: MASTER_TERMINAL_ID,
      details: 'Outbound withdrawal of 42,000 USDT queued for four-eyes compliance review.',
      severity: 'warn',
      prev_hash: '0xa1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
      row_hash: '0xb2c3d4e5f6a7890123456789abcdef0123456789abcdef0123456789abcdef01',
      created_at: iso(2100),
    },
  ];

  const depositAddresses: DepositAddressRecord[] = [
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01',
      wallet_id: wMasterUsdtTrc,
      network: 'TRC20',
      address: deriveDepositAddress(MASTER_TERMINAL_ID, 'USDT', 'TRC20'),
      created_at: iso(60 * 24 * 80),
    },
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02',
      wallet_id: wMasterUsdtErc,
      network: 'ERC20',
      address: deriveDepositAddress(MASTER_TERMINAL_ID, 'USDT', 'ERC20'),
      created_at: iso(60 * 24 * 80),
    },
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb03',
      wallet_id: wMasterBtc,
      network: 'BTC',
      address: deriveDepositAddress(MASTER_TERMINAL_ID, 'BTC', 'BTC'),
      created_at: iso(60 * 24 * 80),
    },
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb04',
      wallet_id: wMasterEth,
      network: 'ETH',
      address: deriveDepositAddress(MASTER_TERMINAL_ID, 'ETH', 'ETH'),
      created_at: iso(60 * 24 * 80),
    },
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb05',
      wallet_id: wSub1Usdt,
      network: 'TRC20',
      address: deriveDepositAddress(sub1Id, 'USDT', 'TRC20'),
      created_at: iso(60 * 24 * 60),
    },
  ];

  const withdrawalRequests: WithdrawalRequestRecord[] = [
    {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc01',
      transaction_id: '55555555-5555-4555-8555-555555555507',
      whitelist_address_id: '66666666-6666-4666-8666-666666666601',
      state: 'review',
      broadcast_at: null,
      created_at: iso(2100),
    },
  ];

  const sampleDemoKybQueue: KycSubmissionRecord[] = [
    {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
      user_id: '88888888-8888-4888-8888-888888888899',
      account_type: 'corporate',
      full_legal_name: 'Meridian Digital Clearing Ltd.',
      date_of_birth: '1986-04-14',
      nationality: 'Switzerland',
      country_of_residence: 'Switzerland',
      id_type: 'commercial_registry',
      id_number: 'CHE-419.802.311',
      tax_or_reg_number: 'CHE-419.802.311-MWST',
      phone_number: '+41 44 580 22 90',
      address_line: 'Bahnhofstrasse 42, 8001 Zurich, Switzerland',
      id_front_path: '88888888-8888-4888-8888-888888888899/id_front-sample.png',
      id_back_path: '88888888-8888-4888-8888-888888888899/id_back-sample.png',
      selfie_path: '88888888-8888-4888-8888-888888888899/selfie-sample.jpg',
      proof_of_address_path: '88888888-8888-4888-8888-888888888899/proof_of_address-sample.pdf',
      status: 'pending_review',
      rejection_reason: null,
      reviewed_by: null,
      reviewed_at: null,
      created_at: iso(320),
      updated_at: iso(320),
    },
  ];

  return {
    terminals,
    wallets,
    journalEntries,
    ledgerPostings,
    transactions,
    whitelistAddresses,
    invoices,
    tradingAccounts,
    auditLogs,
    depositAddresses,
    withdrawalRequests,
    kycSubmission: null,
    kycQueue: sampleDemoKybQueue,
    dailyWithdrawnUsd: 138450,
    assetRates: { ...ASSET_USD_RATES },
    assetRatesSource: 'local_demo',
  };
}

function computeDailyWithdrawnUsd(
  transactions: TransactionRecord[],
  rates: AssetRateMap = ASSET_USD_RATES
): number {
  const cutoff = Date.now() - 24 * 3600_000;
  return transactions
    .filter(
      (tx) =>
        tx.type === 'withdrawal' &&
        tx.status !== 'reversed' &&
        tx.status !== 'failed' &&
        new Date(tx.created_at).getTime() >= cutoff
    )
    .reduce((sum, tx) => sum + tx.amount * (rates[tx.asset] ?? 0), 0);
}

function mapKycSubmissionRow(row: Record<string, unknown>): KycSubmissionRecord {
  const rawType = String(row.account_type ?? 'individual');
  const accountType: KycAccountType = rawType === 'corporate' ? 'corporate' : 'individual';
  const rawIdType = String(row.id_type ?? 'passport');
  const idType: KycIdType =
    rawIdType === 'national_id' || rawIdType === 'commercial_registry' ? rawIdType : 'passport';
  const rawStatus = String(row.status ?? 'unverified');
  const status: KycStatus =
    rawStatus === 'pending_review' || rawStatus === 'approved' || rawStatus === 'rejected'
      ? rawStatus
      : 'unverified';

  return {
    id: String(row.id),
    user_id: String(row.user_id),
    account_type: accountType,
    full_legal_name: String(row.full_legal_name ?? ''),
    date_of_birth: row.date_of_birth ? String(row.date_of_birth) : null,
    nationality: String(row.nationality ?? ''),
    country_of_residence: String(row.country_of_residence ?? ''),
    id_type: idType,
    id_number: String(row.id_number ?? ''),
    tax_or_reg_number: row.tax_or_reg_number ? String(row.tax_or_reg_number) : null,
    phone_number: String(row.phone_number ?? ''),
    address_line: String(row.address_line ?? ''),
    id_front_path: String(row.id_front_path ?? ''),
    id_back_path: row.id_back_path ? String(row.id_back_path) : null,
    selfie_path: String(row.selfie_path ?? ''),
    proof_of_address_path: String(row.proof_of_address_path ?? ''),
    status,
    rejection_reason: row.rejection_reason ? String(row.rejection_reason) : null,
    reviewed_by: row.reviewed_by ? String(row.reviewed_by) : null,
    reviewed_at: row.reviewed_at ? String(row.reviewed_at) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function isMissingKycTableError(errMessage?: string): boolean {
  if (!errMessage) return false;
  const lower = errMessage.toLowerCase();
  return lower.includes('kyc_submissions') && (lower.includes('does not exist') || lower.includes('schema cache'));
}

async function loadLiveSupabaseLedgerState(userId?: string): Promise<NtpsLedgerState> {
  if (!supabase) {
    throw new Error('Supabase client is not initialized.');
  }

  let effectiveUserId = userId;
  if (!effectiveUserId) {
    const { data: userData } = await supabase.auth.getUser();
    effectiveUserId = userData.user?.id;
  }

  let kycSubmission: KycSubmissionRecord | null = null;
  if (effectiveUserId) {
    const { data: kycRow, error: kycErr } = await supabase
      .from('kyc_submissions')
      .select('*')
      .eq('user_id', effectiveUserId)
      .maybeSingle();

    if (kycErr) {
      if (!isMissingKycTableError(kycErr.message)) {
        throw new Error(`Failed to query KYC verification status: ${kycErr.message}`);
      }
    } else if (kycRow) {
      kycSubmission = mapKycSubmissionRow(kycRow as Record<string, unknown>);
    }
  }

  let { data: terminalRows, error: termErr } = await supabase
    .from('terminals')
    .select('*')
    .order('created_at', { ascending: true });

  if (termErr) {
    throw new Error(`Failed to query terminals: ${termErr.message}`);
  }

  const hasOwnMaster = effectiveUserId
    ? (terminalRows ?? []).some(
        (row) => String(row.owner_user_id) === effectiveUserId && row.type === 'master'
      )
    : (terminalRows ?? []).length > 0;

  // Provision Master Terminal automatically only after KYC/KYB approval
  if (!hasOwnMaster && kycSubmission?.status === 'approved') {
    const candidateCode = generateMasterTerminalId();
    const { error: bootErr } = await supabase.rpc('bootstrap_user_terminal', {
      p_terminal_id: candidateCode,
      p_label: 'NOVA Treasury Master',
    });
    if (bootErr && !bootErr.message.toLowerCase().includes('kyc')) {
      throw new Error(`Failed to bootstrap master terminal: ${bootErr.message}`);
    }

    const refreshed = await supabase
      .from('terminals')
      .select('*')
      .order('created_at', { ascending: true });
    if (refreshed.error) {
      throw new Error(`Failed to reload terminals: ${refreshed.error.message}`);
    }
    terminalRows = refreshed.data ?? [];
  }

  const [
    walletsRes,
    txRes,
    postingsRes,
    journalsRes,
    whitelistRes,
    invoicesRes,
    tradingRes,
    depositAddrRes,
    wdReqRes,
    auditRes,
    ratesRes,
    kycQueueRes,
  ] = await Promise.all([
    supabase.from('wallets').select('*').order('asset', { ascending: true }),
    supabase.from('transactions').select('*').order('created_at', { ascending: false }).limit(250),
    supabase.from('ledger_postings').select('*').order('created_at', { ascending: false }).limit(500),
    supabase.from('journal_entries').select('*').order('created_at', { ascending: false }).limit(250),
    supabase.from('whitelist_addresses').select('*').order('created_at', { ascending: false }),
    supabase.from('invoices').select('*').order('created_at', { ascending: false }),
    supabase.from('trading_accounts').select('*'),
    supabase.from('deposit_addresses').select('*').order('created_at', { ascending: false }),
    supabase.from('withdrawal_requests').select('*').order('created_at', { ascending: false }),
    supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(150),
    supabase.from('asset_rates').select('asset, usd_rate, source, fetched_at'),
    supabase.from('kyc_submissions').select('*').order('updated_at', { ascending: false }).limit(150),
  ]);

  const firstError =
    walletsRes.error ||
    txRes.error ||
    postingsRes.error ||
    journalsRes.error ||
    whitelistRes.error ||
    invoicesRes.error ||
    tradingRes.error ||
    depositAddrRes.error ||
    wdReqRes.error ||
    auditRes.error;

  if (firstError) {
    throw new Error(`Failed to synchronize Supabase ledger state: ${firstError.message}`);
  }

  const liveRates: AssetRateMap = { ...ASSET_USD_RATES };
  let assetRatesSource = 'fallback';
  let assetRatesUpdatedAt: string | undefined;
  if (!ratesRes.error && Array.isArray(ratesRes.data) && ratesRes.data.length > 0) {
    for (const r of ratesRes.data) {
      const sym = r.asset as AssetSymbol;
      const num = Number(r.usd_rate);
      if ((sym === 'USDT' || sym === 'BTC' || sym === 'ETH') && Number.isFinite(num) && num > 0) {
        liveRates[sym] = num;
      }
      if (r.source) assetRatesSource = String(r.source);
      if (r.fetched_at && (!assetRatesUpdatedAt || String(r.fetched_at) > assetRatesUpdatedAt)) {
        assetRatesUpdatedAt = String(r.fetched_at);
      }
    }
  }

  const terminals: TerminalRecord[] = (terminalRows ?? []).map((row) => ({
    id: String(row.id),
    terminalId: String(row.terminal_id),
    type: row.type,
    parent_id: row.parent_id ? String(row.parent_id) : null,
    owner_user_id: String(row.owner_user_id),
    label: String(row.label),
    tier: row.tier,
    status: row.status,
    daily_limit_usd: Number(row.daily_limit_usd),
    per_tx_limit_usd: Number(row.per_tx_limit_usd),
    allowed_assets: Array.isArray(row.allowed_assets) ? row.allowed_assets : ['USDT', 'BTC', 'ETH'],
    created_at: String(row.created_at),
  }));

  const wallets: WalletBalance[] = (walletsRes.data ?? []).map((row) => ({
    id: String(row.id),
    terminalUuid: String(row.terminal_id),
    asset: row.asset,
    network: row.network,
    available: Number(row.available),
    pending: Number(row.pending),
    locked: Number(row.locked),
    version: Number(row.version),
    updated_at: String(row.updated_at),
  }));

  const transactions: TransactionRecord[] = (txRes.data ?? []).map((row) => ({
    id: String(row.id),
    reference: String(row.reference),
    terminalUuid: String(row.terminal_id),
    counterparty_terminal: row.counterparty_terminal ? String(row.counterparty_terminal) : '—',
    type: row.type,
    asset: row.asset,
    network: row.network,
    amount: Number(row.amount),
    fee: Number(row.fee ?? 0),
    status: row.status,
    tx_hash: row.tx_hash ? String(row.tx_hash) : '',
    journal_id: row.journal_id ? String(row.journal_id) : undefined,
    memo: row.memo ? String(row.memo) : undefined,
    risk_score:
      row.type === 'withdrawal' && Number(row.amount) * (liveRates[row.asset as AssetSymbol] ?? 1) >= 25000
        ? 'High'
        : row.type === 'withdrawal'
          ? 'Medium'
          : 'Low',
    created_at: String(row.created_at),
  }));

  const journalEntries: JournalEntry[] = (journalsRes.data ?? []).map((row) => ({
    id: String(row.id),
    kind: row.kind,
    idempotency_key: String(row.idempotency_key),
    memo: row.memo ? String(row.memo) : undefined,
    created_by: row.created_by ? String(row.created_by) : undefined,
    created_at: String(row.created_at),
  }));

  const ledgerPostings: LedgerPosting[] = (postingsRes.data ?? []).map((row) => ({
    id: String(row.id),
    journal_id: String(row.journal_id),
    account_ref: String(row.account_ref),
    asset: row.asset,
    amount: Number(row.amount),
    created_at: String(row.created_at),
  }));

  const whitelistAddresses: WhitelistAddress[] = (whitelistRes.data ?? []).map((row) => ({
    id: String(row.id),
    terminalUuid: String(row.terminal_id),
    label: String(row.label),
    asset: row.asset,
    network: row.network,
    address: String(row.address),
    verified: Boolean(row.verified),
    created_at: String(row.created_at),
  }));

  const invoices: InvoiceRecord[] = (invoicesRes.data ?? []).map((row) => ({
    id: String(row.id),
    invoice_number: String(row.invoice_number),
    terminalUuid: String(row.terminal_id),
    payer_terminal_id: row.payer_terminal_id ? String(row.payer_terminal_id) : undefined,
    asset: row.asset,
    amount: Number(row.amount),
    description: String(row.description),
    expires_at: String(row.expires_at),
    status: row.status,
    signed_uri: String(row.signed_uri),
    signature: String(row.signature),
    created_at: String(row.created_at),
  }));

  const tradingAccounts: TradingAccount[] = (tradingRes.data ?? []).map((row) => ({
    id: String(row.id),
    terminalUuid: String(row.terminal_id),
    account_type: row.account_type,
    account_login: String(row.account_login),
    currency: row.currency,
    balance: Number(row.balance),
    free_margin: Number(row.free_margin),
    leverage: String(row.leverage),
    status: row.status,
  }));

  const depositAddresses: DepositAddressRecord[] = (depositAddrRes.data ?? []).map((row) => ({
    id: String(row.id),
    wallet_id: String(row.wallet_id),
    network: row.network,
    address: String(row.address),
    created_at: String(row.created_at),
  }));

  const withdrawalRequests: WithdrawalRequestRecord[] = (wdReqRes.data ?? []).map((row) => ({
    id: String(row.id),
    transaction_id: String(row.transaction_id),
    whitelist_address_id: String(row.whitelist_address_id),
    state: row.state,
    broadcast_at: row.broadcast_at ? String(row.broadcast_at) : null,
    created_at: String(row.created_at),
  }));

  const auditLogs: AuditLogRecord[] = (auditRes.data ?? []).map((row) => ({
    id: String(row.id),
    event_type: String(row.event_type),
    actor: String(row.actor),
    terminalUuid: row.terminal_id ? String(row.terminal_id) : undefined,
    terminalId: row.terminal_id ? resolveTerminalCode(terminals, String(row.terminal_id)) : undefined,
    details: String(row.details),
    severity: row.severity,
    prev_hash: String(row.prev_hash),
    row_hash: String(row.row_hash),
    created_at: String(row.created_at),
  }));

  const kycQueue: KycSubmissionRecord[] =
    !kycQueueRes.error && Array.isArray(kycQueueRes.data)
      ? kycQueueRes.data.map((row) => mapKycSubmissionRow(row as Record<string, unknown>))
      : kycSubmission
        ? [kycSubmission]
        : [];

  return {
    terminals,
    wallets,
    journalEntries,
    ledgerPostings,
    transactions,
    whitelistAddresses,
    invoices,
    tradingAccounts,
    auditLogs,
    depositAddresses,
    withdrawalRequests,
    kycSubmission,
    kycQueue,
    dailyWithdrawnUsd: Math.round(computeDailyWithdrawnUsd(transactions, liveRates)),
    assetRates: liveRates,
    assetRatesSource,
    assetRatesUpdatedAt,
  };
}

export async function loadLedgerState(options?: {
  authMode?: LedgerRuntimeMode;
  userId?: string;
}): Promise<NtpsLedgerState> {
  if (isLiveSupabaseMode(options?.authMode)) {
    return loadLiveSupabaseLedgerState(options?.userId);
  }

  if (typeof window !== 'undefined') {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<NtpsLedgerState>;
        const seed = createSeedState();
        return {
          ...seed,
          ...parsed,
          depositAddresses: parsed.depositAddresses ?? seed.depositAddresses,
          withdrawalRequests: parsed.withdrawalRequests ?? seed.withdrawalRequests,
          kycSubmission: parsed.kycSubmission !== undefined ? parsed.kycSubmission : seed.kycSubmission,
          kycQueue: Array.isArray(parsed.kycQueue) ? parsed.kycQueue : seed.kycQueue,
          assetRates: parsed.assetRates ?? seed.assetRates,
        };
      } catch {
        // ignore malformed cache
      }
    }
  }
  const seed = createSeedState();
  saveLocalLedgerState(seed);
  return seed;
}

export function saveLocalLedgerState(state: NtpsLedgerState): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

export function resetLocalLedgerState(): NtpsLedgerState {
  clearDemoTwoFactorGuard();
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(DEMO_KYC_DOCS_STORAGE_KEY);
  }
  const seed = createSeedState();
  saveLocalLedgerState(seed);
  return seed;
}

function makeReference(): string {
  const num = secureRandomInt(1000, 9999);
  return `NTPS-261118-${num}`;
}

export function getTerminalAssetTotal(
  wallets: WalletBalance[],
  terminalUuid: string,
  asset: AssetSymbol
): { available: number; pending: number; locked: number } {
  return wallets
    .filter((w) => w.terminalUuid === terminalUuid && w.asset === asset)
    .reduce(
      (acc, w) => ({
        available: acc.available + w.available,
        pending: acc.pending + w.pending,
        locked: acc.locked + w.locked,
      }),
      { available: 0, pending: 0, locked: 0 }
    );
}

export function computePortfolioUsd(
  wallets: WalletBalance[],
  terminalUuids?: string[],
  rates: AssetRateMap = ASSET_USD_RATES
): number {
  return wallets
    .filter((w) => !terminalUuids || terminalUuids.includes(w.terminalUuid))
    .reduce((sum, w) => {
      const totalAsset = w.available + w.pending + w.locked;
      return sum + totalAsset * (rates[w.asset] ?? ASSET_USD_RATES[w.asset]);
    }, 0);
}

export async function ensureDepositAddress(params: {
  terminalUuid: string;
  asset: AssetSymbol;
  network: NetworkId;
  customAddress?: string;
  authMode?: LedgerRuntimeMode;
}): Promise<{ state: NtpsLedgerState; addressRecord: DepositAddressRecord }> {
  const state = await loadLedgerState({ authMode: params.authMode });
  const term = state.terminals.find((t) => t.id === params.terminalUuid);
  if (!term) {
    throw new Error('Target terminal not found.');
  }

  const wallet = state.wallets.find(
    (w) =>
      w.terminalUuid === term.id &&
      w.asset === params.asset &&
      w.network === params.network
  );

  const fallbackWallet =
    wallet ??
    state.wallets.find((w) => w.terminalUuid === term.id && w.asset === params.asset);

  const nextAddress =
    params.customAddress?.trim() ||
    deriveDepositAddress(term.terminalId, params.asset, params.network);

  if (isLiveSupabaseMode(params.authMode) && supabase) {
    if (!fallbackWallet) {
      throw new Error(`No ${params.asset} wallet provisioned on ${term.terminalId}.`);
    }

    const existing = state.depositAddresses.find(
      (d) => d.wallet_id === fallbackWallet.id && d.network === params.network
    );

    if (existing && !params.customAddress) {
      return { state, addressRecord: existing };
    }

    const { error } = await supabase.rpc('register_deposit_address', {
      p_wallet_id: fallbackWallet.id,
      p_network: params.network,
      p_address: nextAddress,
    });
    if (error) {
      throw new Error(`Failed to register deposit address: ${error.message}`);
    }

    const nextState = await loadLedgerState({ authMode: params.authMode });
    const saved =
      nextState.depositAddresses.find(
        (d) => d.wallet_id === fallbackWallet.id && d.network === params.network
      ) ?? {
        id: createUuid(),
        wallet_id: fallbackWallet.id,
        network: params.network,
        address: nextAddress,
        created_at: new Date().toISOString(),
      };
    return { state: nextState, addressRecord: saved };
  }

  const walletId = fallbackWallet?.id ?? createUuid();
  const existingLocal = state.depositAddresses.find(
    (d) => d.wallet_id === walletId && d.network === params.network
  );

  if (existingLocal && !params.customAddress) {
    return { state, addressRecord: existingLocal };
  }

  const record: DepositAddressRecord = existingLocal
    ? { ...existingLocal, address: nextAddress }
    : {
        id: createUuid(),
        wallet_id: walletId,
        network: params.network,
        address: nextAddress,
        created_at: new Date().toISOString(),
      };

  const nextAddresses = existingLocal
    ? state.depositAddresses.map((d) => (d.id === existingLocal.id ? record : d))
    : [record, ...state.depositAddresses];

  const nextState: NtpsLedgerState = {
    ...state,
    depositAddresses: nextAddresses,
  };
  saveLocalLedgerState(nextState);
  return { state: nextState, addressRecord: record };
}

export async function performInternalTransfer(params: {
  sourceTerminalUuid: string;
  recipientTerminalId: string;
  asset: AssetSymbol;
  amount: number;
  memo: string;
  kind?: TransactionType;
  authMode?: LedgerRuntimeMode;
}): Promise<{ state: NtpsLedgerState; transaction: TransactionRecord }> {
  const validation = validateTerminalId(params.recipientTerminalId);
  if (!validation.isValid) {
    throw new Error(validation.error ?? 'Invalid recipient Terminal ID checksum.');
  }
  const recipientCode = validation.normalized;

  if (isLiveSupabaseMode(params.authMode) && supabase) {
    const idempotencyKey = `xfer_${createUuid()}`;
    const { data: txId, error } = await supabase.rpc('execute_internal_transfer', {
      p_source_terminal_id: params.sourceTerminalUuid,
      p_recipient_terminal_code: recipientCode,
      p_asset: params.asset,
      p_amount: params.amount,
      p_memo: params.memo || 'NTPS instant settlement',
      p_idempotency_key: idempotencyKey,
      p_kind: params.kind ?? 'internal_transfer',
    });

    if (error) {
      throw new Error(error.message);
    }

    const nextState = await loadLedgerState({ authMode: params.authMode });
    const tx =
      nextState.transactions.find((t) => t.id === txId) ?? nextState.transactions[0];
    if (!tx) {
      throw new Error('Transfer committed but transaction record was not returned.');
    }
    return { state: nextState, transaction: tx };
  }

  const state = await loadLedgerState({ authMode: params.authMode });
  const sourceTerm = state.terminals.find((t) => t.id === params.sourceTerminalUuid);
  if (!sourceTerm) throw new Error('Source terminal not found.');
  if (recipientCode === sourceTerm.terminalId) {
    throw new Error('Source and recipient Terminal IDs cannot be identical.');
  }
  if (sourceTerm.status === 'suspended' || sourceTerm.status === 'locked') {
    throw new Error(`Source terminal is currently ${sourceTerm.status}.`);
  }

  const matchingWallets = state.wallets.filter(
    (w) => w.terminalUuid === sourceTerm.id && w.asset === params.asset
  );
  const totalAvailable = matchingWallets.reduce((s, w) => s + w.available, 0);
  if (params.amount > totalAvailable) {
    throw new Error(`Insufficient available ${params.asset} balance.`);
  }

  let remainingToDebit = params.amount;
  const nowIso = new Date().toISOString();
  const debitLegs: { walletId: string; amount: number }[] = [];

  const nextWallets = state.wallets.map((w) => {
    if (w.terminalUuid === sourceTerm.id && w.asset === params.asset && remainingToDebit > 0) {
      const take = Math.min(w.available, remainingToDebit);
      if (take > 0) {
        remainingToDebit = Number((remainingToDebit - take).toFixed(8));
        debitLegs.push({ walletId: w.id, amount: Number(take.toFixed(8)) });
        return {
          ...w,
          available: Number((w.available - take).toFixed(8)),
          version: w.version + 1,
          updated_at: nowIso,
        };
      }
    }
    return w;
  });

  const ownedRecipient = state.terminals.find((t) => t.terminalId === recipientCode);
  let updatedWallets = nextWallets;
  let creditAccountRef = `counterparty:${recipientCode}`;

  if (ownedRecipient) {
    const existingRec = nextWallets.find(
      (w) => w.terminalUuid === ownedRecipient.id && w.asset === params.asset
    );
    if (existingRec) {
      creditAccountRef = `wallet:${existingRec.id}`;
      updatedWallets = nextWallets.map((w) =>
        w.id === existingRec.id
          ? {
              ...w,
              available: Number((existingRec.available + params.amount).toFixed(8)),
              version: w.version + 1,
              updated_at: nowIso,
            }
          : w
      );
    } else {
      const newWalletId = createUuid();
      creditAccountRef = `wallet:${newWalletId}`;
      updatedWallets = [
        ...nextWallets,
        {
          id: newWalletId,
          terminalUuid: ownedRecipient.id,
          asset: params.asset,
          network: ASSET_NETWORKS[params.asset][0],
          available: params.amount,
          pending: 0,
          locked: 0,
          version: 1,
          updated_at: nowIso,
        },
      ];
    }
  }

  const reference = makeReference();
  const txHash = generateTxHash();
  const journalId = createUuid();
  const txKind: TransactionType =
    params.kind ?? (ownedRecipient?.type === 'sub' ? 'sub_allocation' : 'internal_transfer');

  const newJournal: JournalEntry = {
    id: journalId,
    kind: txKind,
    idempotency_key: `xfer_${reference}_${txHash.slice(2, 10)}`,
    memo: params.memo || 'NTPS instant settlement',
    created_by: sourceTerm.owner_user_id,
    created_at: nowIso,
  };

  const debitPostings: LedgerPosting[] = debitLegs.map((leg) => ({
    id: createUuid(),
    journal_id: journalId,
    account_ref: `wallet:${leg.walletId}`,
    asset: params.asset,
    amount: -leg.amount,
    created_at: nowIso,
  }));

  const creditPosting: LedgerPosting = {
    id: createUuid(),
    journal_id: journalId,
    account_ref: creditAccountRef,
    asset: params.asset,
    amount: Number(params.amount.toFixed(8)),
    created_at: nowIso,
  };

  const newTx: TransactionRecord = {
    id: createUuid(),
    reference,
    terminalUuid: sourceTerm.id,
    counterparty_terminal: recipientCode,
    type: txKind,
    asset: params.asset,
    network: 'NTPS_INTERNAL',
    amount: params.amount,
    fee: 0,
    status: 'completed',
    tx_hash: txHash,
    journal_id: journalId,
    memo: params.memo,
    risk_score: 'Low',
    created_at: nowIso,
  };

  const nextState: NtpsLedgerState = {
    ...state,
    wallets: updatedWallets,
    journalEntries: [newJournal, ...state.journalEntries],
    ledgerPostings: [...debitPostings, creditPosting, ...state.ledgerPostings],
    transactions: [newTx, ...state.transactions],
  };

  saveLocalLedgerState(nextState);
  return { state: nextState, transaction: newTx };
}

export async function performSimulatedDeposit(params: {
  terminalUuid: string;
  asset: AssetSymbol;
  network: NetworkId;
  amount: number;
  sourceAddress: string;
  authMode?: LedgerRuntimeMode;
}): Promise<{ state: NtpsLedgerState; transaction: TransactionRecord }> {
  if (isLiveSupabaseMode(params.authMode)) {
    throw new Error(
      'Simulated deposits are disabled in live Supabase mode. Confirmed on-chain deposits are credited by ntps-tron-worker via credit_crypto_deposit.'
    );
  }

  const state = await loadLedgerState({ authMode: params.authMode });
  const targetTerm = state.terminals.find((t) => t.id === params.terminalUuid);
  if (!targetTerm) throw new Error('Target terminal not found.');

  const nowIso = new Date().toISOString();
  const existingWallet = state.wallets.find(
    (w) =>
      w.terminalUuid === targetTerm.id &&
      w.asset === params.asset &&
      w.network === params.network
  );

  let updatedWallets: WalletBalance[];
  let walletId: string;

  if (existingWallet) {
    walletId = existingWallet.id;
    const balanceAfter = Number((existingWallet.available + params.amount).toFixed(8));
    updatedWallets = state.wallets.map((w) =>
      w.id === existingWallet.id
        ? { ...w, available: balanceAfter, version: w.version + 1, updated_at: nowIso }
        : w
    );
  } else {
    walletId = createUuid();
    updatedWallets = [
      ...state.wallets,
      {
        id: walletId,
        terminalUuid: targetTerm.id,
        asset: params.asset,
        network: params.network,
        available: params.amount,
        pending: 0,
        locked: 0,
        version: 1,
        updated_at: nowIso,
      },
    ];
  }

  const txHash = generateTxHash();
  const reference = makeReference();
  const journalId = createUuid();

  const newJournal: JournalEntry = {
    id: journalId,
    kind: 'deposit',
    idempotency_key: `dep_${txHash}`,
    memo: `Inbound deposit (${params.network})`,
    created_by: targetTerm.owner_user_id,
    created_at: nowIso,
  };

  const debitHotWallet: LedgerPosting = {
    id: createUuid(),
    journal_id: journalId,
    account_ref: `system:hot_${params.asset.toLowerCase()}_${params.network.toLowerCase()}`,
    asset: params.asset,
    amount: -Number(params.amount.toFixed(8)),
    created_at: nowIso,
  };

  const creditClientWallet: LedgerPosting = {
    id: createUuid(),
    journal_id: journalId,
    account_ref: `wallet:${walletId}`,
    asset: params.asset,
    amount: Number(params.amount.toFixed(8)),
    created_at: nowIso,
  };

  const newTx: TransactionRecord = {
    id: createUuid(),
    reference,
    terminalUuid: targetTerm.id,
    counterparty_terminal: params.sourceAddress,
    type: 'deposit',
    asset: params.asset,
    network: params.network,
    amount: params.amount,
    fee: 0,
    status: 'completed',
    tx_hash: txHash,
    journal_id: journalId,
    memo: 'On-chain deposit',
    risk_score: 'Low',
    created_at: nowIso,
  };

  const nextState: NtpsLedgerState = {
    ...state,
    wallets: updatedWallets,
    journalEntries: [newJournal, ...state.journalEntries],
    ledgerPostings: [debitHotWallet, creditClientWallet, ...state.ledgerPostings],
    transactions: [newTx, ...state.transactions],
  };

  saveLocalLedgerState(nextState);
  return { state: nextState, transaction: newTx };
}

export async function performWithdrawal(params: {
  terminalUuid: string;
  asset: AssetSymbol;
  network: NetworkId;
  destinationAddress: string;
  whitelistAddressId?: string;
  amount: number;
  memo?: string;
  autoApprove?: boolean;
  authMode?: LedgerRuntimeMode;
}): Promise<{
  state: NtpsLedgerState;
  transaction: TransactionRecord;
  withdrawalRequest?: WithdrawalRequestRecord;
}> {
  const feeInfo = NETWORK_FEES[params.network];
  const fee = feeInfo.amount;

  if (isLiveSupabaseMode(params.authMode) && supabase) {
    const preState = await loadLedgerState({ authMode: params.authMode });
    const wl =
      (params.whitelistAddressId
        ? preState.whitelistAddresses.find((w) => w.id === params.whitelistAddressId)
        : undefined) ??
      preState.whitelistAddresses.find(
        (w) =>
          w.terminalUuid === params.terminalUuid &&
          w.asset === params.asset &&
          w.network === params.network &&
          w.address === params.destinationAddress
      );

    if (!wl) {
      throw new Error('Whitelisted destination address record not found.');
    }

    const idempotencyKey = `wd_${createUuid()}`;
    const { data: txId, error } = await supabase.rpc('request_crypto_withdrawal', {
      p_terminal_id: params.terminalUuid,
      p_asset: params.asset,
      p_network: params.network,
      p_whitelist_address_id: wl.id,
      p_amount: params.amount,
      p_fee: fee,
      p_memo: params.memo || `Custody withdrawal (${wl.label})`,
      p_idempotency_key: idempotencyKey,
      p_auto_approve: false,
    });

    if (error) {
      throw new Error(error.message);
    }

    const nextState = await loadLedgerState({ authMode: params.authMode });
    const tx =
      nextState.transactions.find((t) => t.id === txId) ?? nextState.transactions[0];
    if (!tx) {
      throw new Error('Withdrawal queued but transaction record was not returned.');
    }
    const req = nextState.withdrawalRequests.find((r) => r.transaction_id === tx.id);
    return { state: nextState, transaction: tx, withdrawalRequest: req };
  }

  const state = await loadLedgerState({ authMode: params.authMode });
  if (state.kycSubmission?.status !== 'approved') {
    throw new Error('KYC/KYB approval is required before initiating external withdrawals.');
  }
  const sourceTerm = state.terminals.find((t) => t.id === params.terminalUuid);
  if (!sourceTerm) throw new Error('Source terminal not found.');

  const totalRequired = Number((params.amount + fee).toFixed(8));

  const walletsForAsset = state.wallets.filter(
    (w) => w.terminalUuid === sourceTerm.id && w.asset === params.asset
  );
  const availableTotal = walletsForAsset.reduce((s, w) => s + w.available, 0);
  if (totalRequired > availableTotal) {
    throw new Error('Insufficient available balance for withdrawal + fee.');
  }

  const nowIso = new Date().toISOString();
  let remaining = totalRequired;
  const debitMap = new Map<string, number>();

  for (const w of walletsForAsset) {
    if (remaining <= 0) break;
    const take = Math.min(w.available, remaining);
    if (take > 0) {
      debitMap.set(w.id, Number(take.toFixed(8)));
      remaining = Number((remaining - take).toFixed(8));
    }
  }

  const updatedWallets = state.wallets.map((w) => {
    const take = debitMap.get(w.id);
    if (!take) return w;
    return {
      ...w,
      available: Number((w.available - take).toFixed(8)),
      version: w.version + 1,
      updated_at: nowIso,
    };
  });

  const reference = makeReference();
  const journalId = createUuid();
  const txId = createUuid();
  const wlMatch =
    (params.whitelistAddressId
      ? state.whitelistAddresses.find((w) => w.id === params.whitelistAddressId)
      : undefined) ??
    state.whitelistAddresses.find((w) => w.address === params.destinationAddress);

  const newJournal: JournalEntry = {
    id: journalId,
    kind: 'withdrawal',
    idempotency_key: `wd_${reference}_${txId.slice(0, 8)}`,
    memo: params.memo || 'Custody withdrawal',
    created_by: sourceTerm.owner_user_id,
    created_at: nowIso,
  };

  const debitPostings: LedgerPosting[] = Array.from(debitMap.entries()).map(([walletId, take]) => ({
    id: createUuid(),
    journal_id: journalId,
    account_ref: `wallet:${walletId}`,
    asset: params.asset,
    amount: -take,
    created_at: nowIso,
  }));

  const creditEscrowWallet: LedgerPosting = {
    id: createUuid(),
    journal_id: journalId,
    account_ref: `system:withdrawal_escrow_${params.asset.toLowerCase()}_${params.network.toLowerCase()}`,
    asset: params.asset,
    amount: Number(params.amount.toFixed(8)),
    created_at: nowIso,
  };

  const feePosting: LedgerPosting[] =
    fee > 0
      ? [
          {
            id: createUuid(),
            journal_id: journalId,
            account_ref: `system:fee_revenue_${params.asset.toLowerCase()}`,
            asset: params.asset,
            amount: Number(fee.toFixed(8)),
            created_at: nowIso,
          },
        ]
      : [];

  const newTx: TransactionRecord = {
    id: txId,
    reference,
    terminalUuid: sourceTerm.id,
    counterparty_terminal: params.destinationAddress,
    type: 'withdrawal',
    asset: params.asset,
    network: params.network,
    amount: params.amount,
    fee,
    status: 'pending',
    tx_hash: '',
    journal_id: journalId,
    memo: params.memo,
    risk_score: params.amount * ASSET_USD_RATES[params.asset] >= 25000 ? 'High' : 'Medium',
    created_at: nowIso,
  };

  const newReq: WithdrawalRequestRecord = {
    id: createUuid(),
    transaction_id: txId,
    whitelist_address_id: wlMatch?.id ?? createUuid(),
    state: 'review',
    broadcast_at: null,
    created_at: nowIso,
  };

  const nextState: NtpsLedgerState = {
    ...state,
    wallets: updatedWallets,
    journalEntries: [newJournal, ...state.journalEntries],
    ledgerPostings: [...debitPostings, creditEscrowWallet, ...feePosting, ...state.ledgerPostings],
    transactions: [newTx, ...state.transactions],
    withdrawalRequests: [newReq, ...state.withdrawalRequests],
    dailyWithdrawnUsd: Math.round(
      state.dailyWithdrawnUsd + params.amount * ASSET_USD_RATES[params.asset]
    ),
  };

  saveLocalLedgerState(nextState);
  return { state: nextState, transaction: newTx, withdrawalRequest: newReq };
}

export async function provisionSubTerminal(params: {
  label: string;
  dailyLimitUsd: number;
  perTxLimitUsd: number;
  allowedAssets: AssetSymbol[];
  authMode?: LedgerRuntimeMode;
}): Promise<{ state: NtpsLedgerState; terminal: TerminalRecord }> {
  const state = await loadLedgerState({ authMode: params.authMode });
  if (!isLiveSupabaseMode(params.authMode) && state.kycSubmission?.status !== 'approved') {
    throw new Error('KYC/KYB approval is required before provisioning Sub-Terminals.');
  }
  const master = state.terminals.find((t) => t.type === 'master');
  if (!master) throw new Error('Master terminal not found.');

  const cleanLabel = params.label.trim();
  if (!cleanLabel) {
    throw new Error('Sub-terminal label is required.');
  }
  if (
    !Number.isFinite(params.dailyLimitUsd) ||
    params.dailyLimitUsd <= 0 ||
    !Number.isFinite(params.perTxLimitUsd) ||
    params.perTxLimitUsd <= 0
  ) {
    throw new Error('Sub-terminal daily and per-transaction limits must be strictly positive.');
  }
  if (params.perTxLimitUsd > params.dailyLimitUsd) {
    throw new Error('Per-transaction limit cannot exceed daily limit.');
  }
  if (params.dailyLimitUsd > master.daily_limit_usd) {
    throw new Error(
      `Sub-terminal daily limit ($${params.dailyLimitUsd.toLocaleString()}) cannot exceed Master Terminal cap ($${master.daily_limit_usd.toLocaleString()}).`
    );
  }
  if (!Array.isArray(params.allowedAssets) || params.allowedAssets.length === 0) {
    throw new Error('At least one allowed asset is required.');
  }

  const subCount = state.terminals.filter((t) => t.type === 'sub').length;
  const subCode = generateSubTerminalId(master.terminalId, subCount + 1);
  const label = cleanLabel;

  if (isLiveSupabaseMode(params.authMode) && supabase) {
    const { data: subId, error } = await supabase.rpc('provision_sub_terminal_atomic', {
      p_terminal_code: subCode,
      p_label: label,
      p_daily_limit: params.dailyLimitUsd,
      p_per_tx_limit: params.perTxLimitUsd,
      p_allowed_assets: params.allowedAssets,
    });
    if (error) {
      throw new Error(error.message);
    }
    const nextState = await loadLedgerState({ authMode: params.authMode });
    const terminal =
      nextState.terminals.find((t) => t.id === subId) ??
      nextState.terminals[nextState.terminals.length - 1];
    return { state: nextState, terminal };
  }

  const subUuid = createUuid();
  const nowIso = new Date().toISOString();

  const newTerm: TerminalRecord = {
    id: subUuid,
    terminalId: subCode,
    type: 'sub',
    parent_id: master.id,
    owner_user_id: master.owner_user_id,
    label,
    tier: 'Desk',
    status: 'active',
    daily_limit_usd: params.dailyLimitUsd,
    per_tx_limit_usd: params.perTxLimitUsd,
    allowed_assets: params.allowedAssets,
    created_at: nowIso,
  };

  const initialWallets: WalletBalance[] = newTerm.allowed_assets.map((asset) => ({
    id: createUuid(),
    terminalUuid: subUuid,
    asset,
    network: ASSET_NETWORKS[asset][0],
    available: 0,
    pending: 0,
    locked: 0,
    version: 1,
    updated_at: nowIso,
  }));

  const nextState: NtpsLedgerState = {
    ...state,
    terminals: [...state.terminals, newTerm],
    wallets: [...state.wallets, ...initialWallets],
  };

  saveLocalLedgerState(nextState);
  return { state: nextState, terminal: newTerm };
}

export async function updateSubTerminalPolicy(params: {
  terminalUuid: string;
  status?: TerminalStatus;
  dailyLimitUsd?: number;
  perTxLimitUsd?: number;
  allowedAssets?: AssetSymbol[];
  authMode?: LedgerRuntimeMode;
}): Promise<NtpsLedgerState> {
  if (isLiveSupabaseMode(params.authMode) && supabase) {
    const { error } = await supabase.rpc('update_sub_terminal_policy', {
      p_terminal_id: params.terminalUuid,
      p_status: params.status ?? null,
      p_daily_limit_usd: params.dailyLimitUsd ?? null,
      p_per_tx_limit_usd: params.perTxLimitUsd ?? null,
      p_allowed_assets: params.allowedAssets ?? null,
    });
    if (error) {
      throw new Error(error.message);
    }
    return loadLedgerState({ authMode: params.authMode });
  }

  const state = await loadLedgerState({ authMode: params.authMode });
  const master = state.terminals.find((t) => t.type === 'master');
  const existing = state.terminals.find((t) => t.id === params.terminalUuid);
  if (!existing) throw new Error('Sub-terminal not found.');

  const nextDaily = params.dailyLimitUsd ?? existing.daily_limit_usd;
  const nextPerTx = params.perTxLimitUsd ?? existing.per_tx_limit_usd;
  const nextAssets = params.allowedAssets ?? existing.allowed_assets;

  if (!Number.isFinite(nextDaily) || nextDaily <= 0 || !Number.isFinite(nextPerTx) || nextPerTx <= 0) {
    throw new Error('Limits must be strictly positive.');
  }
  if (nextPerTx > nextDaily) {
    throw new Error('Per-transaction limit cannot exceed daily limit.');
  }
  if (master && existing.type === 'sub' && nextDaily > master.daily_limit_usd) {
    throw new Error(
      `Sub-terminal daily limit cannot exceed Master Terminal cap ($${master.daily_limit_usd.toLocaleString()}).`
    );
  }
  if (nextAssets.length === 0) {
    throw new Error('At least one allowed asset is required.');
  }

  const nextTerminals = state.terminals.map((t) => {
    if (t.id !== params.terminalUuid) return t;
    return {
      ...t,
      status: params.status ?? t.status,
      daily_limit_usd: nextDaily,
      per_tx_limit_usd: nextPerTx,
      allowed_assets: nextAssets,
    };
  });

  const nextState: NtpsLedgerState = { ...state, terminals: nextTerminals };
  saveLocalLedgerState(nextState);
  return nextState;
}

export async function addWhitelistDestination(params: {
  terminalUuid: string;
  label: string;
  asset: AssetSymbol;
  network: NetworkId;
  address: string;
  authMode?: LedgerRuntimeMode;
}): Promise<NtpsLedgerState> {
  if (isLiveSupabaseMode(params.authMode) && supabase) {
    const { error } = await supabase.rpc('add_whitelist_address', {
      p_terminal_id: params.terminalUuid,
      p_label: params.label.trim(),
      p_asset: params.asset,
      p_network: params.network,
      p_address: params.address.trim(),
    });
    if (error) {
      throw new Error(error.message);
    }
    return loadLedgerState({ authMode: params.authMode });
  }

  const state = await loadLedgerState({ authMode: params.authMode });
  const entry: WhitelistAddress = {
    id: createUuid(),
    terminalUuid: params.terminalUuid,
    label: params.label.trim(),
    asset: params.asset,
    network: params.network,
    address: params.address.trim(),
    verified: true,
    created_at: new Date().toISOString(),
  };

  const nextState: NtpsLedgerState = {
    ...state,
    whitelistAddresses: [entry, ...state.whitelistAddresses],
  };
  saveLocalLedgerState(nextState);
  return nextState;
}

// --- Phase 2 Actions ---

export async function createInvoice(params: {
  terminalUuid: string;
  payerTerminalId?: string;
  asset: AssetSymbol;
  amount: number;
  description: string;
  expiryHours?: number;
  authMode?: LedgerRuntimeMode;
}): Promise<{ state: NtpsLedgerState; invoice: InvoiceRecord }> {
  const state = await loadLedgerState({ authMode: params.authMode });
  const term = state.terminals.find((t) => t.id === params.terminalUuid);
  if (!term) throw new Error('Recipient terminal not found.');

  const now = Date.now();
  const expMs = (params.expiryHours ?? 24) * 3600_000;
  const invNumber = `INV-2026-${secureRandomInt(100000, 999999)}`;
  const sig = generateTxHash('0x').slice(0, 24);
  const signedUri = `ntps://pay?tid=${term.terminalId}&asset=${params.asset}&amount=${params.amount}&ref=${invNumber}&sig=${sig}`;
  const expiresAt = new Date(now + expMs).toISOString();
  const description = params.description.trim() || 'NTPS Payment Request';

  if (isLiveSupabaseMode(params.authMode) && supabase) {
    const { data: invoiceId, error } = await supabase.rpc('create_invoice_atomic', {
      p_terminal_id: term.id,
      p_payer_terminal_id: params.payerTerminalId || null,
      p_asset: params.asset,
      p_amount: params.amount,
      p_description: description,
      p_expires_at: expiresAt,
      p_invoice_number: invNumber,
      p_signed_uri: signedUri,
      p_signature: sig,
    });

    if (error) {
      throw new Error(error.message);
    }

    const nextState = await loadLedgerState({ authMode: params.authMode });
    const created =
      nextState.invoices.find((i) => i.id === invoiceId) ?? nextState.invoices[0];
    return { state: nextState, invoice: created };
  }

  const newInvoice: InvoiceRecord = {
    id: createUuid(),
    invoice_number: invNumber,
    terminalUuid: term.id,
    payer_terminal_id: params.payerTerminalId,
    asset: params.asset,
    amount: params.amount,
    description,
    expires_at: expiresAt,
    status: 'open',
    signed_uri: signedUri,
    signature: sig,
    created_at: new Date(now).toISOString(),
  };

  const nextState: NtpsLedgerState = {
    ...state,
    invoices: [newInvoice, ...state.invoices],
  };
  saveLocalLedgerState(nextState);
  return { state: nextState, invoice: newInvoice };
}

export async function payInvoice(params: {
  invoiceId: string;
  payerTerminalUuid: string;
  authMode?: LedgerRuntimeMode;
}): Promise<{ state: NtpsLedgerState; transaction: TransactionRecord }> {
  if (isLiveSupabaseMode(params.authMode) && supabase) {
    const idempotencyKey = `invpay_${createUuid()}`;
    const { data: txId, error } = await supabase.rpc('pay_invoice_atomic', {
      p_invoice_id: params.invoiceId,
      p_payer_terminal_id: params.payerTerminalUuid,
      p_idempotency_key: idempotencyKey,
    });
    if (error) {
      throw new Error(error.message);
    }
    const nextState = await loadLedgerState({ authMode: params.authMode });
    const tx =
      nextState.transactions.find((t) => t.id === txId) ?? nextState.transactions[0];
    if (!tx) {
      throw new Error('Invoice settled but transaction record was not returned.');
    }
    return { state: nextState, transaction: tx };
  }

  const state = await loadLedgerState({ authMode: params.authMode });
  const inv = state.invoices.find((i) => i.id === params.invoiceId);
  if (!inv) throw new Error('Invoice not found.');
  if (inv.status !== 'open') throw new Error(`Invoice is already ${inv.status}.`);

  const recipientTerm = state.terminals.find((t) => t.id === inv.terminalUuid);
  const payerTerm = state.terminals.find((t) => t.id === params.payerTerminalUuid);
  if (!recipientTerm) throw new Error('Invoice recipient terminal not found.');
  if (!payerTerm) throw new Error('Payer terminal not found.');

  if (payerTerm.id === recipientTerm.id) {
    throw new Error('Payer terminal cannot be the same as invoice recipient.');
  }

  const transferRes = await performInternalTransfer({
    sourceTerminalUuid: payerTerm.id,
    recipientTerminalId: recipientTerm.terminalId,
    asset: inv.asset,
    amount: inv.amount,
    memo: `Invoice settlement: ${inv.invoice_number} — ${inv.description}`,
    kind: 'invoice_payment',
    authMode: params.authMode,
  });

  const nextInvoices = transferRes.state.invoices.map((i) =>
    i.id === inv.id
      ? { ...i, status: 'paid' as const, payer_terminal_id: payerTerm.terminalId }
      : i
  );

  const nextState: NtpsLedgerState = {
    ...transferRes.state,
    invoices: nextInvoices,
  };
  saveLocalLedgerState(nextState);
  return { state: nextState, transaction: transferRes.transaction };
}

export async function transferToTrading(params: {
  terminalUuid: string;
  tradingAccountId: string;
  amount: number;
  authMode?: LedgerRuntimeMode;
}): Promise<NtpsLedgerState> {
  if (isLiveSupabaseMode(params.authMode) && supabase) {
    const { error } = await supabase.rpc('transfer_trading_bridge', {
      p_terminal_id: params.terminalUuid,
      p_trading_account_id: params.tradingAccountId,
      p_amount: params.amount,
      p_direction: 'to_trading',
      p_idempotency_key: `trf_to_${createUuid()}`,
    });
    if (error) {
      throw new Error(error.message);
    }
    return loadLedgerState({ authMode: params.authMode });
  }

  const state = await loadLedgerState({ authMode: params.authMode });
  const trAccount = state.tradingAccounts.find((t) => t.id === params.tradingAccountId);
  if (!trAccount) throw new Error('Trading account not found.');

  const term = state.terminals.find((t) => t.id === params.terminalUuid);
  if (!term) throw new Error('Bound terminal not found.');

  const wallet = state.wallets.find(
    (w) => w.terminalUuid === term.id && w.asset === trAccount.currency
  );
  if (!wallet || wallet.available < params.amount) {
    throw new Error(`Insufficient available ${trAccount.currency} in terminal wallet.`);
  }

  const nowIso = new Date().toISOString();
  const nextWallets = state.wallets.map((w) =>
    w.id === wallet.id
      ? {
          ...w,
          available: Number((w.available - params.amount).toFixed(8)),
          version: w.version + 1,
          updated_at: nowIso,
        }
      : w
  );

  const nextTrading = state.tradingAccounts.map((t) =>
    t.id === trAccount.id
      ? {
          ...t,
          balance: Number((t.balance + params.amount).toFixed(8)),
          free_margin: Number((t.free_margin + params.amount).toFixed(8)),
        }
      : t
  );

  const reference = makeReference();
  const journalId = createUuid();
  const newJournal: JournalEntry = {
    id: journalId,
    kind: 'trading_funding',
    idempotency_key: `trf_to_${reference}`,
    memo: `Margin transfer to ${trAccount.account_login}`,
    created_by: term.owner_user_id,
    created_at: nowIso,
  };

  const debitWalletPosting: LedgerPosting = {
    id: createUuid(),
    journal_id: journalId,
    account_ref: `wallet:${wallet.id}`,
    asset: trAccount.currency,
    amount: -Number(params.amount.toFixed(8)),
    created_at: nowIso,
  };

  const creditTradingPosting: LedgerPosting = {
    id: createUuid(),
    journal_id: journalId,
    account_ref: `trading:${trAccount.account_login}`,
    asset: trAccount.currency,
    amount: Number(params.amount.toFixed(8)),
    created_at: nowIso,
  };

  const newTx: TransactionRecord = {
    id: createUuid(),
    reference,
    terminalUuid: term.id,
    counterparty_terminal: trAccount.account_login,
    type: 'trading_funding',
    asset: trAccount.currency,
    network: 'NTPS_INTERNAL',
    amount: params.amount,
    fee: 0,
    status: 'completed',
    tx_hash: generateTxHash(),
    journal_id: journalId,
    memo: `Margin allocation to ${trAccount.account_login}`,
    risk_score: 'Low',
    created_at: nowIso,
  };

  const nextState: NtpsLedgerState = {
    ...state,
    wallets: nextWallets,
    tradingAccounts: nextTrading,
    journalEntries: [newJournal, ...state.journalEntries],
    ledgerPostings: [debitWalletPosting, creditTradingPosting, ...state.ledgerPostings],
    transactions: [newTx, ...state.transactions],
  };

  saveLocalLedgerState(nextState);
  return nextState;
}

export async function transferFromTrading(params: {
  terminalUuid: string;
  tradingAccountId: string;
  amount: number;
  authMode?: LedgerRuntimeMode;
}): Promise<NtpsLedgerState> {
  if (isLiveSupabaseMode(params.authMode) && supabase) {
    const { error } = await supabase.rpc('transfer_trading_bridge', {
      p_terminal_id: params.terminalUuid,
      p_trading_account_id: params.tradingAccountId,
      p_amount: params.amount,
      p_direction: 'from_trading',
      p_idempotency_key: `trf_from_${createUuid()}`,
    });
    if (error) {
      throw new Error(error.message);
    }
    return loadLedgerState({ authMode: params.authMode });
  }

  const state = await loadLedgerState({ authMode: params.authMode });
  const trAccount = state.tradingAccounts.find((t) => t.id === params.tradingAccountId);
  if (!trAccount) throw new Error('Trading account not found.');

  const term = state.terminals.find((t) => t.id === params.terminalUuid);
  if (!term) throw new Error('Bound terminal not found.');

  if (trAccount.free_margin < params.amount) {
    throw new Error('Insufficient free margin in trading account for withdrawal.');
  }

  const nowIso = new Date().toISOString();
  const nextTrading = state.tradingAccounts.map((t) =>
    t.id === trAccount.id
      ? {
          ...t,
          balance: Number((t.balance - params.amount).toFixed(8)),
          free_margin: Number((t.free_margin - params.amount).toFixed(8)),
        }
      : t
  );

  const targetWallet = state.wallets.find(
    (w) => w.terminalUuid === term.id && w.asset === trAccount.currency
  );
  let nextWallets: WalletBalance[];
  let walletId: string;

  if (targetWallet) {
    walletId = targetWallet.id;
    const balanceAfter = Number((targetWallet.available + params.amount).toFixed(8));
    nextWallets = state.wallets.map((w) =>
      w.id === targetWallet.id
        ? { ...w, available: balanceAfter, version: w.version + 1, updated_at: nowIso }
        : w
    );
  } else {
    walletId = createUuid();
    nextWallets = [
      ...state.wallets,
      {
        id: walletId,
        terminalUuid: term.id,
        asset: trAccount.currency,
        network: ASSET_NETWORKS[trAccount.currency][0],
        available: params.amount,
        pending: 0,
        locked: 0,
        version: 1,
        updated_at: nowIso,
      },
    ];
  }

  const reference = makeReference();
  const journalId = createUuid();
  const newJournal: JournalEntry = {
    id: journalId,
    kind: 'trading_funding',
    idempotency_key: `trf_from_${reference}`,
    memo: `Margin recall from ${trAccount.account_login}`,
    created_by: term.owner_user_id,
    created_at: nowIso,
  };

  const debitTradingPosting: LedgerPosting = {
    id: createUuid(),
    journal_id: journalId,
    account_ref: `trading:${trAccount.account_login}`,
    asset: trAccount.currency,
    amount: -Number(params.amount.toFixed(8)),
    created_at: nowIso,
  };

  const creditWalletPosting: LedgerPosting = {
    id: createUuid(),
    journal_id: journalId,
    account_ref: `wallet:${walletId}`,
    asset: trAccount.currency,
    amount: Number(params.amount.toFixed(8)),
    created_at: nowIso,
  };

  const newTx: TransactionRecord = {
    id: createUuid(),
    reference,
    terminalUuid: term.id,
    counterparty_terminal: trAccount.account_login,
    type: 'trading_funding',
    asset: trAccount.currency,
    network: 'NTPS_INTERNAL',
    amount: params.amount,
    fee: 0,
    status: 'completed',
    tx_hash: generateTxHash(),
    journal_id: journalId,
    memo: `Margin recall from ${trAccount.account_login}`,
    risk_score: 'Low',
    created_at: nowIso,
  };

  const nextState: NtpsLedgerState = {
    ...state,
    wallets: nextWallets,
    tradingAccounts: nextTrading,
    journalEntries: [newJournal, ...state.journalEntries],
    ledgerPostings: [debitTradingPosting, creditWalletPosting, ...state.ledgerPostings],
    transactions: [newTx, ...state.transactions],
  };

  saveLocalLedgerState(nextState);
  return nextState;
}

const VALID_ADMIN_ROLES: ReadonlySet<AdminRole> = new Set<AdminRole>([
  'ops',
  'compliance',
  'treasury',
  'super_admin',
]);

function normalizeAdminRole(value: unknown): AdminRole | null {
  if (typeof value !== 'string') return null;
  return VALID_ADMIN_ROLES.has(value as AdminRole) ? (value as AdminRole) : null;
}

function formatAdminPermissionError(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes('forbidden') ||
    lower.includes('app_admins') ||
    lower.includes('42501') ||
    lower.includes('permission denied')
  ) {
    return 'Permission denied: your account requires an active ops, compliance, or super_admin role in public.app_admins.';
  }
  return message;
}

export async function fetchAdminProfile(
  authMode?: LedgerRuntimeMode,
  userId?: string
): Promise<AdminProfile> {
  if (!isLiveSupabaseMode(authMode) || !supabase || !userId) {
    return {
      isAdmin: true,
      role: 'super_admin',
      isActive: true,
      source: 'local_demo',
    };
  }

  const { data, error } = await supabase.rpc('get_my_admin_role');
  if (!error && data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    const role = normalizeAdminRole(rec.role);
    const isActive = Boolean(rec.is_active);
    return {
      isAdmin: Boolean(rec.is_admin) && isActive && role !== null,
      role,
      isActive,
      source: 'supabase',
    };
  }

  // Fallback to direct RLS-scoped app_admins SELECT if RPC is absent
  const { data: row, error: tableErr } = await supabase
    .from('app_admins')
    .select('role, is_active')
    .eq('user_id', userId)
    .maybeSingle();

  if (tableErr || !row) {
    return {
      isAdmin: false,
      role: null,
      isActive: false,
      source: 'supabase',
    };
  }

  const role = normalizeAdminRole(row.role);
  const isActive = Boolean(row.is_active);
  return {
    isAdmin: isActive && role !== null,
    role,
    isActive,
    source: 'supabase',
  };
}

export async function updateTerminalStatusAdmin(params: {
  terminalUuid: string;
  status: TerminalStatus;
  reason: string;
  authMode?: LedgerRuntimeMode;
}): Promise<NtpsLedgerState> {
  const cleanReason = params.reason.trim();
  if (!cleanReason) {
    throw new Error('Mandatory compliance audit reason is required.');
  }

  if (isLiveSupabaseMode(params.authMode) && supabase) {
    const { error } = await supabase.rpc('update_terminal_status_admin', {
      p_terminal_id: params.terminalUuid,
      p_status: params.status,
      p_reason: cleanReason,
    });
    if (error) {
      throw new Error(formatAdminPermissionError(error.message));
    }
    return loadLedgerState({ authMode: params.authMode });
  }

  const state = await loadLedgerState({ authMode: params.authMode });
  const target = state.terminals.find((t) => t.id === params.terminalUuid);
  const nextTerminals = state.terminals.map((t) =>
    t.id === params.terminalUuid ? { ...t, status: params.status } : t
  );

  const nowIso = new Date().toISOString();
  const lastLog = state.auditLogs[0];
  const prevHash =
    lastLog?.row_hash ?? '0x0000000000000000000000000000000000000000000000000000000000000000';
  const rowHash = generateTxHash('0x');

  const newAudit: AuditLogRecord = {
    id: createUuid(),
    event_type: `TERMINAL_STATUS_${params.status.toUpperCase()}`,
    actor: 'admin-compliance-officer',
    terminalUuid: params.terminalUuid,
    terminalId: target?.terminalId,
    details: `Reason: ${cleanReason}`,
    severity: params.status === 'active' ? 'info' : 'warn',
    prev_hash: prevHash,
    row_hash: rowHash,
    created_at: nowIso,
  };

  const nextState: NtpsLedgerState = {
    ...state,
    terminals: nextTerminals,
    auditLogs: [newAudit, ...state.auditLogs],
  };
  saveLocalLedgerState(nextState);
  return nextState;
}

export async function reviewWithdrawalQueue(params: {
  transactionId: string;
  action: 'approve' | 'reject';
  reason: string;
  authMode?: LedgerRuntimeMode;
}): Promise<NtpsLedgerState> {
  const cleanReason = params.reason.trim();
  if (!cleanReason) {
    throw new Error('Mandatory compliance review reason is required.');
  }

  if (isLiveSupabaseMode(params.authMode) && supabase) {
    const { error } = await supabase.rpc('review_withdrawal_request', {
      p_transaction_id: params.transactionId,
      p_action: params.action,
      p_reason: cleanReason,
    });
    if (error) {
      throw new Error(formatAdminPermissionError(error.message));
    }
    return loadLedgerState({ authMode: params.authMode });
  }

  const state = await loadLedgerState({ authMode: params.authMode });
  const targetTx = state.transactions.find((t) => t.id === params.transactionId);
  const targetReq = state.withdrawalRequests.find((r) => r.transaction_id === params.transactionId);
  const nowIso = new Date().toISOString();

  if (params.action === 'reject') {
    if (
      targetReq?.state === 'broadcast' ||
      targetReq?.state === 'confirmed' ||
      Boolean(targetReq?.broadcast_at) ||
      Boolean(targetTx?.tx_hash) ||
      targetTx?.status === 'completed'
    ) {
      throw new Error(
        'Cannot automatically reject or reverse a withdrawal that has already broadcast or confirmed on-chain; manual reconciliation required.'
      );
    }
    if (targetTx && state.journalEntries.some((je) => je.idempotency_key === `rev_${targetTx.id}`)) {
      throw new Error('Withdrawal reversal already recorded.');
    }
  }

  let nextWallets = state.wallets;
  let nextJournals = state.journalEntries;
  let nextPostings = state.ledgerPostings;

  if (params.action === 'reject' && targetTx?.journal_id) {
    const origPostings = state.ledgerPostings.filter((p) => p.journal_id === targetTx.journal_id);
    if (origPostings.length > 0) {
      const revJournalId = createUuid();
      const revJournal: JournalEntry = {
        id: revJournalId,
        kind: 'withdrawal',
        idempotency_key: `rev_${targetTx.id}`,
        memo: `Compliance reversal of ${targetTx.reference} (${cleanReason})`,
        created_at: nowIso,
      };
      const revPostings: LedgerPosting[] = origPostings.map((p) => ({
        id: createUuid(),
        journal_id: revJournalId,
        account_ref: p.account_ref,
        asset: p.asset,
        amount: -p.amount,
        created_at: nowIso,
      }));
      nextJournals = [revJournal, ...nextJournals];
      nextPostings = [...revPostings, ...nextPostings];

      const refundMap = new Map<string, number>();
      for (const p of origPostings) {
        if (p.account_ref.startsWith('wallet:') && p.amount < 0) {
          const wid = p.account_ref.slice(7);
          refundMap.set(wid, (refundMap.get(wid) ?? 0) + Math.abs(p.amount));
        }
      }
      nextWallets = nextWallets.map((w) => {
        const refund = refundMap.get(w.id);
        if (!refund) return w;
        return {
          ...w,
          available: Number((w.available + refund).toFixed(8)),
          version: w.version + 1,
          updated_at: nowIso,
        };
      });
    }
  }

  const nextTxs = state.transactions.map((tx) => {
    if (tx.id !== params.transactionId) return tx;
    return {
      ...tx,
      status: params.action === 'approve' ? ('completed' as const) : ('reversed' as const),
    };
  });

  const nextRequests = state.withdrawalRequests.map((req) => {
    if (req.transaction_id !== params.transactionId) return req;
    return {
      ...req,
      state: params.action === 'approve' ? ('confirmed' as const) : ('rejected' as const),
    };
  });

  const lastLog = state.auditLogs[0];
  const prevHash =
    lastLog?.row_hash ?? '0x0000000000000000000000000000000000000000000000000000000000000000';

  const newAudit: AuditLogRecord = {
    id: createUuid(),
    event_type: `WITHDRAWAL_REVIEW_${params.action.toUpperCase()}`,
    actor: 'compliance-four-eyes',
    terminalUuid: targetTx?.terminalUuid,
    details: `Transaction ${targetTx?.reference ?? params.transactionId} was ${params.action}d by compliance officer. Reason: ${cleanReason}`,
    severity: params.action === 'approve' ? 'info' : 'warn',
    prev_hash: prevHash,
    row_hash: generateTxHash('0x'),
    created_at: nowIso,
  };

  const nextState: NtpsLedgerState = {
    ...state,
    wallets: nextWallets,
    journalEntries: nextJournals,
    ledgerPostings: nextPostings,
    transactions: nextTxs,
    withdrawalRequests: nextRequests,
    auditLogs: [newAudit, ...state.auditLogs],
  };
  saveLocalLedgerState(nextState);
  return nextState;
}

export async function verifyLedgerInvariant(
  authMode?: LedgerRuntimeMode,
  localPostings?: LedgerPosting[]
): Promise<LedgerInvariantResult> {
  if (isLiveSupabaseMode(authMode) && supabase) {
    const { data, error } = await supabase.rpc('verify_ledger_invariant');
    if (error) {
      throw new Error(`Ledger invariant check failed: ${error.message}`);
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      journalCount: Number(row?.journal_count ?? 0),
      postingCount: Number(row?.posting_count ?? 0),
      imbalancedCount: Number(row?.imbalanced_count ?? 0),
      ok: Boolean(row?.is_balanced ?? true),
    };
  }

  const postings = localPostings ?? (await loadLedgerState({ authMode })).ledgerPostings;
  const sums = new Map<string, number>();
  for (const p of postings) {
    const key = `${p.journal_id}::${p.asset}`;
    sums.set(key, (sums.get(key) ?? 0) + p.amount);
  }
  const imbalancedCount = Array.from(sums.values()).filter((v) => Math.abs(v) > 1e-6).length;
  return {
    journalCount: sums.size,
    postingCount: postings.length,
    imbalancedCount,
    ok: imbalancedCount === 0,
  };
}

export async function recordSimulatedTwoFactorAudit(params: {
  eventType: string;
  actor: string;
  details: string;
  severity: 'info' | 'warn' | 'critical';
  authMode?: LedgerRuntimeMode;
}): Promise<NtpsLedgerState> {
  const state = await loadLedgerState({ authMode: params.authMode });
  if (isLiveSupabaseMode(params.authMode)) {
    return state;
  }

  const master = state.terminals.find((t) => t.type === 'master') ?? state.terminals[0];
  const nowIso = new Date().toISOString();
  const lastLog = state.auditLogs[0];
  const prevHash =
    lastLog?.row_hash ?? '0x0000000000000000000000000000000000000000000000000000000000000000';

  const newAudit: AuditLogRecord = {
    id: createUuid(),
    event_type: params.eventType,
    actor: params.actor,
    terminalUuid: master?.id,
    terminalId: master?.terminalId,
    details: params.details,
    severity: params.severity,
    prev_hash: prevHash,
    row_hash: generateTxHash('0x'),
    created_at: nowIso,
  };

  const nextState: NtpsLedgerState = {
    ...state,
    auditLogs: [newAudit, ...state.auditLogs],
  };
  saveLocalLedgerState(nextState);
  return nextState;
}

// --- KYC / KYB Verification Engine ---

export type KycDocumentSlot = 'id_front' | 'id_back' | 'selfie' | 'proof_of_address';

const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

function readDemoDocsStore(): Record<string, { dataUrl: string; mimeType: string; name: string }> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(DEMO_KYC_DOCS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, { dataUrl: string; mimeType: string; name: string }>) : {};
  } catch {
    return {};
  }
}

function writeDemoDocEntry(
  path: string,
  entry: { dataUrl: string; mimeType: string; name: string }
): void {
  if (typeof window === 'undefined') return;
  try {
    const store = readDemoDocsStore();
    store[path] = entry;
    window.localStorage.setItem(DEMO_KYC_DOCS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore localStorage quota saturation in demo mode
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Unable to read uploaded document.'));
      }
    };
    reader.onerror = () => reject(new Error('Unable to read uploaded document.'));
    reader.readAsDataURL(file);
  });
}

function buildDemoSampleDocumentSvg(label: string, path: string): string {
  const safeLabel = label.replace(/[<>&"']/g, '');
  const safeFile = (path.split('/').pop() ?? 'document').replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="440" viewBox="0 0 760 440">
    <rect width="760" height="440" fill="#0B0F16" />
    <rect x="24" y="24" width="712" height="392" rx="12" fill="#05070A" stroke="#1E293B" stroke-width="2" />
    <text x="52" y="84" fill="#00E5FF" font-family="monospace" font-size="18" font-weight="700">NTPS COMPLIANCE VAULT · SANDBOX DOCUMENT PREVIEW</text>
    <text x="52" y="138" fill="#E2E8F0" font-family="sans-serif" font-size="24" font-weight="600">${safeLabel}</text>
    <text x="52" y="182" fill="#94A3B8" font-family="monospace" font-size="14">Object: ${safeFile}</text>
    <rect x="52" y="220" width="656" height="120" rx="8" fill="#0F172A" stroke="#334155" />
    <text x="76" y="268" fill="#CBD5E1" font-family="sans-serif" font-size="15">Pre-seeded Local Demo sample document placeholder.</text>
    <text x="76" y="298" fill="#64748B" font-family="sans-serif" font-size="13">Upload a real PDF, JPG, or PNG in KYC Verification to preview your own file here.</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function validateKycDocumentFile(file: File): { mimeType: string; ext: string } {
  const mimeType = file.type.toLowerCase();
  if (!KYC_ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new Error('Unsupported file type. Upload a PDF, JPG, or PNG document.');
  }
  if (file.size <= 0) {
    throw new Error('Selected document file is empty.');
  }
  if (file.size > KYC_MAX_FILE_BYTES) {
    throw new Error('Document exceeds the 10 MB maximum file size limit.');
  }
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) {
    throw new Error('Unsupported document format.');
  }
  return { mimeType, ext };
}

export async function uploadKycDocument(params: {
  file: File;
  slot: KycDocumentSlot;
  userId: string;
  authMode?: LedgerRuntimeMode;
}): Promise<string> {
  const { mimeType, ext } = validateKycDocumentFile(params.file);
  const ownerFolder = (params.userId || 'local-demo-operator').replace(/[^a-zA-Z0-9_-]/g, '');
  const storagePath = `${ownerFolder}/${params.slot}-${Date.now()}-${createUuid().slice(0, 8)}.${ext}`;

  if (isLiveSupabaseMode(params.authMode) && supabase) {
    const { data: userData } = await supabase.auth.getUser();
    const liveUid = userData.user?.id;
    if (!liveUid) {
      throw new Error('Authenticated Supabase session required to upload KYC documents.');
    }
    const livePath = `${liveUid}/${params.slot}-${Date.now()}-${createUuid().slice(0, 8)}.${ext}`;
    const { error } = await supabase.storage
      .from('kyc-documents')
      .upload(livePath, params.file, {
        contentType: mimeType,
        upsert: false,
      });

    if (error) {
      throw new Error(`Document upload failed: ${error.message}`);
    }
    return livePath;
  }

  const dataUrl = await fileToDataUrl(params.file);
  writeDemoDocEntry(storagePath, {
    dataUrl,
    mimeType,
    name: params.file.name,
  });
  return storagePath;
}

export function validateKycDateOfBirth(
  accountType: KycAccountType,
  dateOfBirth?: string | null
): string | null {
  const cleanDob = (dateOfBirth ?? '').trim();
  if (!cleanDob) {
    if (accountType === 'corporate') {
      return null;
    }
    throw new Error('Date of birth is required for individual KYC submissions.');
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleanDob);
  if (!match) {
    throw new Error('Enter a valid YYYY-MM-DD date.');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error('Invalid calendar date provided.');
  }

  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (parsed > todayUtc) {
    throw new Error(
      accountType === 'corporate'
        ? 'Incorporation date cannot be in the future.'
        : 'Date of birth cannot be in the future.'
    );
  }

  if (accountType !== 'corporate') {
    const minAdultCutoff = new Date(
      Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate())
    );
    if (parsed > minAdultCutoff) {
      throw new Error('Applicant must be at least 18 years old.');
    }
  }

  return cleanDob;
}

export async function submitKycSubmission(params: {
  input: KycSubmissionInput;
  userId?: string;
  authMode?: LedgerRuntimeMode;
}): Promise<{ state: NtpsLedgerState; submission: KycSubmissionRecord }> {
  const { input } = params;
  if (input.full_legal_name.trim().length < 2) {
    throw new Error('Full legal name or registered entity name is required.');
  }
  const normalizedDob = validateKycDateOfBirth(input.account_type, input.date_of_birth);
  if (!input.nationality.trim() || !input.country_of_residence.trim()) {
    throw new Error('Nationality and country of residence are required.');
  }
  if (input.id_number.trim().length < 3) {
    throw new Error('A valid government ID or registration number is required.');
  }
  if (input.account_type === 'corporate' && !input.tax_or_reg_number?.trim()) {
    throw new Error('Tax / commercial registration number is required for Corporate KYB.');
  }
  if (input.phone_number.trim().length < 5 || input.address_line.trim().length < 5) {
    throw new Error('Valid phone number and residential / registered address are required.');
  }
  if (!input.id_front_path || !input.selfie_path || !input.proof_of_address_path) {
    throw new Error('ID Front, Liveness Selfie, and Proof of Address documents are required.');
  }
  if (input.id_type !== 'passport' && !input.id_back_path) {
    throw new Error('ID Back document is required for National ID and Commercial Registry.');
  }

  if (isLiveSupabaseMode(params.authMode) && supabase) {
    const { data: userData } = await supabase.auth.getUser();
    const liveUid = userData.user?.id ?? params.userId;
    if (!liveUid) {
      throw new Error('Authenticated session required to submit KYC verification.');
    }

    const payload = {
      user_id: liveUid,
      account_type: input.account_type,
      full_legal_name: input.full_legal_name.trim(),
      date_of_birth: normalizedDob,
      nationality: input.nationality.trim(),
      country_of_residence: input.country_of_residence.trim(),
      id_type: input.id_type,
      id_number: input.id_number.trim(),
      tax_or_reg_number: input.tax_or_reg_number?.trim() || null,
      phone_number: input.phone_number.trim(),
      address_line: input.address_line.trim(),
      id_front_path: input.id_front_path.trim(),
      id_back_path: input.id_back_path?.trim() || null,
      selfie_path: input.selfie_path.trim(),
      proof_of_address_path: input.proof_of_address_path.trim(),
      status: 'pending_review',
    };

    const { data, error } = await supabase
      .from('kyc_submissions')
      .upsert(payload, { onConflict: 'user_id' })
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to submit KYC profile: ${error.message}`);
    }

    const nextState = await loadLedgerState({ authMode: params.authMode, userId: liveUid });
    const submission = mapKycSubmissionRow(data as Record<string, unknown>);
    return { state: nextState, submission };
  }

  const state = await loadLedgerState({ authMode: params.authMode, userId: params.userId });
  const nowIso = new Date().toISOString();
  const demoUserId = params.userId || '99999999-9999-4999-8999-999999999901';
  const existing = state.kycSubmission;

  if (existing?.status === 'approved') {
    throw new Error('Approved KYC/KYB records cannot be altered directly.');
  }

  const submission: KycSubmissionRecord = {
    id: existing?.id ?? createUuid(),
    user_id: demoUserId,
    account_type: input.account_type,
    full_legal_name: input.full_legal_name.trim(),
    date_of_birth: normalizedDob,
    nationality: input.nationality.trim(),
    country_of_residence: input.country_of_residence.trim(),
    id_type: input.id_type,
    id_number: input.id_number.trim(),
    tax_or_reg_number: input.tax_or_reg_number?.trim() || null,
    phone_number: input.phone_number.trim(),
    address_line: input.address_line.trim(),
    id_front_path: input.id_front_path.trim(),
    id_back_path: input.id_back_path?.trim() || null,
    selfie_path: input.selfie_path.trim(),
    proof_of_address_path: input.proof_of_address_path.trim(),
    status: 'pending_review',
    rejection_reason: null,
    reviewed_by: null,
    reviewed_at: null,
    created_at: existing?.created_at ?? nowIso,
    updated_at: nowIso,
  };

  const nextQueue = [
    submission,
    ...state.kycQueue.filter((item) => item.id !== submission.id && item.user_id !== submission.user_id),
  ];

  const lastLog = state.auditLogs[0];
  const prevHash =
    lastLog?.row_hash ?? '0x0000000000000000000000000000000000000000000000000000000000000000';
  const newAudit: AuditLogRecord = {
    id: createUuid(),
    event_type: 'KYC_SUBMISSION_RECEIVED',
    actor: demoUserId,
    details: `Submitted ${submission.account_type.toUpperCase()} verification package (${submission.id.slice(0, 8)}) for compliance review.`,
    severity: 'info',
    prev_hash: prevHash,
    row_hash: generateTxHash('0x'),
    created_at: nowIso,
  };

  const nextState: NtpsLedgerState = {
    ...state,
    kycSubmission: submission,
    kycQueue: nextQueue,
    auditLogs: [newAudit, ...state.auditLogs],
  };
  saveLocalLedgerState(nextState);
  return { state: nextState, submission };
}

export async function createKycDocumentSignedUrl(params: {
  path: string;
  label?: string;
  authMode?: LedgerRuntimeMode;
}): Promise<{ url: string; mimeType: string }> {
  const cleanPath = params.path.trim();
  if (!cleanPath || cleanPath.includes('..')) {
    throw new Error('Invalid KYC document storage path.');
  }

  if (isLiveSupabaseMode(params.authMode) && supabase) {
    const { data, error } = await supabase.storage
      .from('kyc-documents')
      .createSignedUrl(cleanPath, 120);

    if (error || !data?.signedUrl) {
      throw new Error(error?.message || 'Unable to generate temporary signed document URL.');
    }

    const parsed = new URL(data.signedUrl);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      throw new Error('Blocked non-HTTPS document preview URL.');
    }

    const lower = cleanPath.toLowerCase();
    const mimeType = lower.endsWith('.pdf')
      ? 'application/pdf'
      : lower.endsWith('.png')
        ? 'image/png'
        : 'image/jpeg';
    return { url: data.signedUrl, mimeType };
  }

  const demoStore = readDemoDocsStore();
  const stored = demoStore[cleanPath];
  if (stored?.dataUrl) {
    return { url: stored.dataUrl, mimeType: stored.mimeType };
  }

  return {
    url: buildDemoSampleDocumentSvg(params.label ?? 'KYC Supporting Document', cleanPath),
    mimeType: 'image/svg+xml',
  };
}

export async function reviewKycSubmission(params: {
  submissionId: string;
  decision: 'approved' | 'rejected';
  reason?: string;
  authMode?: LedgerRuntimeMode;
  userId?: string;
}): Promise<NtpsLedgerState> {
  const cleanReason = (params.reason ?? '').trim();
  if (params.decision === 'rejected' && !cleanReason) {
    throw new Error('Mandatory compliance rejection reason is required.');
  }

  if (isLiveSupabaseMode(params.authMode) && supabase) {
    const { error } = await supabase.rpc('review_kyc_submission', {
      p_submission_id: params.submissionId,
      p_decision: params.decision,
      p_reason: cleanReason || null,
    });
    if (error) {
      throw new Error(formatAdminPermissionError(error.message));
    }
    return loadLedgerState({ authMode: params.authMode, userId: params.userId });
  }

  const state = await loadLedgerState({ authMode: params.authMode, userId: params.userId });
  const target =
    state.kycQueue.find((k) => k.id === params.submissionId) ??
    (state.kycSubmission?.id === params.submissionId ? state.kycSubmission : undefined);
  if (!target) {
    throw new Error('KYC submission record not found.');
  }

  if (params.decision === 'approved') {
    validateKycDateOfBirth(target.account_type, target.date_of_birth);
    const targetIdNum = target.id_number.trim().toUpperCase();
    const targetIdType = target.id_type.trim().toLowerCase();
    const duplicate = state.kycQueue.find(
      (other) =>
        other.id !== target.id &&
        other.status === 'approved' &&
        other.id_number.trim().toUpperCase() === targetIdNum &&
        other.id_type.trim().toLowerCase() === targetIdType
    );
    if (duplicate) {
      throw new Error(
        'Duplicate identity conflict: another approved KYC/KYB account already uses this ID number and type.'
      );
    }
  }

  const nowIso = new Date().toISOString();
  const updated: KycSubmissionRecord = {
    ...target,
    status: params.decision,
    rejection_reason: params.decision === 'rejected' ? cleanReason : null,
    reviewed_by: 'admin-compliance-officer',
    reviewed_at: nowIso,
    updated_at: nowIso,
  };

  const nextQueue = state.kycQueue.map((item) => (item.id === updated.id ? updated : item));
  const nextOwn =
    state.kycSubmission?.id === updated.id ? updated : state.kycSubmission;

  const lastLog = state.auditLogs[0];
  const prevHash =
    lastLog?.row_hash ?? '0x0000000000000000000000000000000000000000000000000000000000000000';
  const newAudit: AuditLogRecord = {
    id: createUuid(),
    event_type: `KYC_SUBMISSION_${params.decision.toUpperCase()}`,
    actor: 'admin-compliance-officer',
    details: `KYC submission ${updated.id.slice(0, 8)} (${updated.account_type}) was ${params.decision} by compliance.${cleanReason ? ` Reason: ${cleanReason}` : ''}`,
    severity: params.decision === 'approved' ? 'info' : 'warn',
    prev_hash: prevHash,
    row_hash: generateTxHash('0x'),
    created_at: nowIso,
  };

  const nextState: NtpsLedgerState = {
    ...state,
    kycSubmission: nextOwn,
    kycQueue: nextQueue,
    auditLogs: [newAudit, ...state.auditLogs],
  };
  saveLocalLedgerState(nextState);
  return nextState;
}

