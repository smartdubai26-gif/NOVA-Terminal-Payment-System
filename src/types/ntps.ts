export type AssetSymbol = 'USDT' | 'BTC' | 'ETH';

export type AssetRateMap = Record<AssetSymbol, number>;

export interface AssetRateRecord {
  asset: AssetSymbol;
  usd_rate: number;
  change_24h_pct?: number;
  source: string;
  fetched_at: string;
}

/**
 * Settlement network identifiers.
 * - Live on-chain worker coverage (`ntps-tron-worker`): 'TRC20' (USDT only)
 * - Internal double-entry settlement: 'NTPS_INTERNAL'
 * - Simulated / ledger-only rails (no live chain watcher/broadcaster): 'ERC20', 'BTC', 'ETH', 'ARBITRUM'
 */
export type NetworkId =
  | 'TRC20'
  | 'ERC20'
  | 'BTC'
  | 'ETH'
  | 'ARBITRUM'
  | 'NTPS_INTERNAL';

export type TerminalType = 'master' | 'sub';
export type TerminalStatus = 'active' | 'suspended' | 'locked' | 'restricted';
export type TransactionType =
  | 'internal_transfer'
  | 'deposit'
  | 'withdrawal'
  | 'sub_allocation'
  | 'invoice_payment'
  | 'trading_funding';
export type TransactionStatus =
  | 'detected'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'reversed';
export type PostingDirection = 'DEBIT' | 'CREDIT';

export interface TerminalRecord {
  id: string; // UUID primary key (terminals.id)
  terminalId: string; // Crockford Base32 code NT-OMEGA-... (terminals.terminal_id)
  type: TerminalType;
  parent_id: string | null; // UUID FK referencing terminals.id
  owner_user_id: string;
  label: string;
  tier: 'Gold' | 'Institutional' | 'Desk';
  status: TerminalStatus;
  daily_limit_usd: number;
  per_tx_limit_usd: number;
  allowed_assets: AssetSymbol[];
  created_at: string;
}

export interface WalletBalance {
  id: string; // UUID primary key (wallets.id)
  terminalUuid: string; // UUID FK referencing terminals.id
  asset: AssetSymbol;
  network: NetworkId;
  available: number;
  pending: number;
  locked: number;
  version: number;
  updated_at: string;
}

export interface JournalEntry {
  id: string; // UUID primary key (journal_entries.id)
  kind: TransactionType | 'fee_settlement';
  idempotency_key: string;
  memo?: string;
  created_by?: string;
  created_at: string;
}

export interface LedgerPosting {
  id: string; // UUID primary key (ledger_postings.id)
  journal_id: string; // UUID FK referencing journal_entries.id
  account_ref: string; // e.g. 'wallet:<uuid>' | 'system:hot_usdt_trc20' | 'trading:<login>'
  asset: AssetSymbol;
  amount: number; // > 0 = CREDIT, < 0 = DEBIT; SUM(amount) = 0 per journal_id
  created_at: string;
}

export interface TransactionRecord {
  id: string; // UUID primary key (transactions.id)
  reference: string;
  terminalUuid: string; // UUID FK referencing terminals.id
  counterparty_terminal: string; // Human-readable NT-OMEGA-... or external chain address
  type: TransactionType;
  asset: AssetSymbol;
  network: NetworkId;
  amount: number;
  fee: number;
  status: TransactionStatus;
  tx_hash: string;
  journal_id?: string; // UUID FK referencing journal_entries.id
  memo?: string;
  risk_score?: 'Low' | 'Medium' | 'High';
  created_at: string;
}

export interface WhitelistAddress {
  id: string; // UUID primary key (whitelist_addresses.id)
  terminalUuid: string; // UUID FK referencing terminals.id
  label: string;
  asset: AssetSymbol;
  network: NetworkId;
  address: string;
  verified: boolean;
  created_at: string;
}

export interface InvoiceRecord {
  id: string; // UUID primary key (invoices.id)
  invoice_number: string;
  terminalUuid: string; // UUID FK referencing terminals.id
  payer_terminal_id?: string; // Human-readable NT-OMEGA-... code
  asset: AssetSymbol;
  amount: number;
  description: string;
  expires_at: string;
  status: 'open' | 'paid' | 'expired' | 'cancelled';
  signed_uri: string;
  signature: string;
  created_at: string;
}

export interface TradingAccount {
  id: string; // UUID primary key (trading_accounts.id)
  terminalUuid: string; // UUID FK referencing terminals.id
  account_type: 'nova_margin' | 'mt5_omnibus';
  account_login: string;
  currency: AssetSymbol;
  balance: number;
  free_margin: number;
  leverage: string;
  status: 'active' | 'suspended';
}

export interface AuditLogRecord {
  id: string; // UUID primary key (audit_logs.id)
  event_type: string;
  actor: string;
  terminalUuid?: string;
  terminalId?: string;
  details: string;
  severity: 'info' | 'warn' | 'critical';
  prev_hash: string;
  row_hash: string;
  created_at: string;
}

export interface CounterpartyInfo {
  terminalId: string;
  masked_name: string;
  entity_type: string;
  verified: boolean;
  tier: string;
}

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant: 'success' | 'error' | 'info';
}

export type WithdrawalRequestState =
  | 'review'
  | 'approved'
  | 'broadcast'
  | 'confirmed'
  | 'rejected';

export interface DepositAddressRecord {
  id: string; // UUID primary key (deposit_addresses.id)
  wallet_id: string; // UUID FK referencing wallets.id
  network: NetworkId;
  address: string;
  created_at: string;
}

export interface WithdrawalRequestRecord {
  id: string; // UUID primary key (withdrawal_requests.id)
  transaction_id: string; // UUID FK referencing transactions.id
  whitelist_address_id: string; // UUID FK referencing whitelist_addresses.id
  state: WithdrawalRequestState;
  broadcast_at?: string | null;
  created_at: string;
}

export interface LedgerInvariantResult {
  journalCount: number;
  postingCount: number;
  imbalancedCount: number;
  ok: boolean;
}

export type AdminRole = 'ops' | 'compliance' | 'treasury' | 'super_admin';

export interface AdminProfile {
  isAdmin: boolean;
  role: AdminRole | null;
  isActive: boolean;
  source: 'supabase' | 'local_demo';
}

export type KycAccountType = 'individual' | 'corporate';

export type KycIdType = 'national_id' | 'passport' | 'commercial_registry';

export type KycStatus = 'unverified' | 'pending_review' | 'approved' | 'rejected';

export interface KycSubmissionRecord {
  id: string;
  user_id: string;
  account_type: KycAccountType;
  full_legal_name: string;
  date_of_birth: string | null;
  nationality: string;
  country_of_residence: string;
  id_type: KycIdType;
  id_number: string;
  tax_or_reg_number?: string | null;
  phone_number: string;
  address_line: string;
  id_front_path: string;
  id_back_path?: string | null;
  selfie_path: string;
  proof_of_address_path: string;
  status: KycStatus;
  rejection_reason?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface KycSubmissionInput {
  account_type: KycAccountType;
  full_legal_name: string;
  date_of_birth?: string | null;
  nationality: string;
  country_of_residence: string;
  id_type: KycIdType;
  id_number: string;
  tax_or_reg_number?: string;
  phone_number: string;
  address_line: string;
  id_front_path: string;
  id_back_path?: string;
  selfie_path: string;
  proof_of_address_path: string;
}

export type ActiveView =
  | 'dashboard'
  | 'transfer'
  | 'deposit_withdraw'
  | 'sub_terminals'
  | 'invoices'
  | 'trading_funding'
  | 'kyc_verification'
  | 'admin_panel'
  | 'ledger';

