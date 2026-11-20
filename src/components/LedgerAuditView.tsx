import { useState, useMemo, useEffect, useCallback } from 'react';
import { Copy, Download, Search, RotateCcw, ShieldCheck, ShieldAlert, RefreshCcw } from 'lucide-react';
import type {
  AssetSymbol,
  LedgerInvariantResult,
  LedgerPosting,
  TerminalRecord,
  TransactionRecord,
  TransactionStatus,
  TransactionType,
} from '../types/ntps';
import {
  NETWORK_LABELS,
  resolveTerminalCode,
  verifyLedgerInvariant,
  type LedgerRuntimeMode,
} from '../lib/ledgerEngine';
import {
  exportRowsToCsv,
  formatAssetAmount,
  formatTimestamp,
  truncateHash,
} from '../lib/format';

interface LedgerAuditViewProps {
  terminals: TerminalRecord[];
  transactions: TransactionRecord[];
  ledgerPostings: LedgerPosting[];
  authMode?: LedgerRuntimeMode;
  onVerifyLedgerInvariant?: () => Promise<LedgerInvariantResult>;
  onCopy: (text: string, label: string) => void;
  onToast: (title: string, description?: string, variant?: 'success' | 'error' | 'info') => void;
}

export function LedgerAuditView({
  terminals,
  transactions,
  ledgerPostings,
  authMode = 'local_demo',
  onVerifyLedgerInvariant,
  onCopy,
  onToast,
}: LedgerAuditViewProps) {
  const [tab, setTab] = useState<'transactions' | 'postings'>('transactions');
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | TransactionType>('ALL');
  const [assetFilter, setAssetFilter] = useState<'ALL' | AssetSymbol>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | TransactionStatus>('ALL');
  const [dateRange, setDateRange] = useState<'ALL' | '24H' | '7D' | '30D'>('ALL');
  const [invariantResult, setInvariantResult] = useState<LedgerInvariantResult | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  const runInvariantVerification = useCallback(
    async (notifyOnComplete = false) => {
      setIsVerifying(true);
      try {
        const res = onVerifyLedgerInvariant
          ? await onVerifyLedgerInvariant()
          : await verifyLedgerInvariant(authMode, ledgerPostings);
        setInvariantResult(res);
        if (notifyOnComplete) {
          onToast(
            res.ok ? 'Double-Entry Invariant Verified' : 'Ledger Imbalance Detected',
            res.ok
              ? `SUM(amount) = 0 across ${res.journalCount} journal groups (${res.postingCount} postings).`
              : `${res.imbalancedCount} journal groups failed SUM(amount) = 0 invariant.`,
            res.ok ? 'success' : 'error'
          );
        }
      } catch (err) {
        if (notifyOnComplete) {
          onToast(
            'Invariant Check Failed',
            err instanceof Error ? err.message : 'Unable to verify ledger invariant.',
            'error'
          );
        }
      } finally {
        setIsVerifying(false);
      }
    },
    [authMode, ledgerPostings, onVerifyLedgerInvariant, onToast]
  );

  useEffect(() => {
    void runInvariantVerification(false);
    // Re-run verification whenever posting count or mode changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authMode, ledgerPostings.length]);

  const cutoffMs = useMemo(() => {
    const now = Date.now();
    if (dateRange === '24H') return now - 24 * 3600_000;
    if (dateRange === '7D') return now - 7 * 24 * 3600_000;
    if (dateRange === '30D') return now - 30 * 24 * 3600_000;
    return 0;
  }, [dateRange]);

  const filteredTransactions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return transactions.filter((tx) => {
      if (typeFilter !== 'ALL' && tx.type !== typeFilter) return false;
      if (assetFilter !== 'ALL' && tx.asset !== assetFilter) return false;
      if (statusFilter !== 'ALL' && tx.status !== statusFilter) return false;
      if (cutoffMs && new Date(tx.created_at).getTime() < cutoffMs) return false;
      if (q) {
        const termCode = resolveTerminalCode(terminals, tx.terminalUuid);
        const hay = `${tx.reference} ${termCode} ${tx.terminalUuid} ${tx.counterparty_terminal} ${tx.tx_hash} ${tx.memo ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [terminals, transactions, searchQuery, typeFilter, assetFilter, statusFilter, cutoffMs]);

  const filteredPostings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return ledgerPostings.filter((lp) => {
      if (assetFilter !== 'ALL' && lp.asset !== assetFilter) return false;
      if (cutoffMs && new Date(lp.created_at).getTime() < cutoffMs) return false;
      if (q) {
        const direction = lp.amount > 0 ? 'credit' : 'debit';
        const hay = `${lp.id} ${lp.journal_id} ${lp.account_ref} ${lp.asset} ${direction}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [ledgerPostings, searchQuery, assetFilter, cutoffMs]);

  const handleResetFilters = () => {
    setSearchQuery('');
    setTypeFilter('ALL');
    setAssetFilter('ALL');
    setStatusFilter('ALL');
    setDateRange('ALL');
  };

  const handleExportCsv = () => {
    if (tab === 'transactions') {
      exportRowsToCsv(
        'ntps-transactions-audit.csv',
        [
          'Reference',
          'Timestamp',
          'Terminal ID',
          'Counterparty',
          'Type',
          'Asset',
          'Network',
          'Amount',
          'Fee',
          'Status',
          'Tx Hash',
        ],
        filteredTransactions.map((t) => [
          t.reference,
          t.created_at,
          resolveTerminalCode(terminals, t.terminalUuid),
          t.counterparty_terminal,
          t.type,
          t.asset,
          t.network,
          t.amount,
          t.fee,
          t.status,
          t.tx_hash,
        ])
      );
      onToast(
        'Exported transactions CSV',
        `${filteredTransactions.length} rows exported`,
        'success'
      );
    } else {
      exportRowsToCsv(
        'ntps-double-entry-postings.csv',
        [
          'Posting ID',
          'Journal ID',
          'Timestamp',
          'Account Ref',
          'Direction',
          'Asset',
          'Signed Amount',
          'Abs Amount',
        ],
        filteredPostings.map((p) => [
          p.id,
          p.journal_id,
          p.created_at,
          p.account_ref,
          p.amount > 0 ? 'CREDIT' : 'DEBIT',
          p.asset,
          p.amount,
          Math.abs(p.amount),
        ])
      );
      onToast(
        'Exported double-entry postings CSV',
        `${filteredPostings.length} immutable postings exported`,
        'success'
      );
    }
  };

  return (
    <div className="space-y-4">
      {/* Double-Entry Ledger Invariant Status Banner */}
      <div
        className={`rounded-xl border p-4 flex flex-wrap items-center justify-between gap-4 ${
          invariantResult === null
            ? 'bg-[#0B0F16] border-white/[0.08]'
            : invariantResult.ok
              ? 'bg-[#0B0F16] border-emerald-500/30'
              : 'bg-red-950/20 border-red-500/40'
        }`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={`w-9 h-9 rounded-lg flex items-center justify-center border shrink-0 ${
              invariantResult === null
                ? 'bg-white/[0.04] border-white/[0.08] text-slate-400'
                : invariantResult.ok
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-red-500/10 border-red-500/30 text-red-400'
            }`}
          >
            {invariantResult && !invariantResult.ok ? (
              <ShieldAlert className="w-4 h-4" />
            ) : (
              <ShieldCheck className="w-4 h-4" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xs font-semibold text-slate-100">
                Double-Entry Invariant (SUM = 0)
              </h2>
              {invariantResult && (
                <span
                  className={`text-[11px] font-mono px-2 py-0.5 rounded border ${
                    invariantResult.ok
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                      : 'bg-red-500/10 text-red-400 border-red-500/25'
                  }`}
                >
                  {invariantResult.ok
                    ? 'BALANCED · APPEND-ONLY'
                    : `${invariantResult.imbalancedCount} IMBALANCED`}
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-400 font-mono tabular-nums mt-0.5">
              {invariantResult
                ? `${invariantResult.journalCount} journal groups · ${invariantResult.postingCount} postings · ${
                    authMode === 'supabase' ? 'Verified via PostgreSQL RPC' : 'Local Engine Check'
                  }`
                : 'Running double-entry balance verification...'}
            </p>
          </div>
        </div>

        <button
          type="button"
          disabled={isVerifying}
          onClick={() => void runInvariantVerification(true)}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-200 bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-45 border border-white/[0.1] rounded-lg transition-colors whitespace-nowrap"
        >
          <RefreshCcw className={`w-3.5 h-3.5 text-[#00E5FF] ${isVerifying ? 'animate-spin' : ''}`} />
          {isVerifying ? 'Verifying...' : 'Verify Invariant'}
        </button>
      </div>

      {/* Header & Filter Bar */}
      <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-1 p-1 bg-[#05070A] border border-white/[0.08] rounded-lg">
            <button
              type="button"
              onClick={() => setTab('transactions')}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                tab === 'transactions'
                  ? 'bg-[#00E5FF] text-[#05070A]'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Transactions ({filteredTransactions.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('postings')}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                tab === 'postings'
                  ? 'bg-[#00E5FF] text-[#05070A]'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Double-Entry Ledger ({filteredPostings.length})
            </button>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleResetFilters}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-300 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] rounded-lg transition-colors whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-100 bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] rounded-lg transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5 text-[#00E5FF]" />
              Export CSV
            </button>
          </div>
        </div>

        {/* Filter Controls */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="lg:col-span-2 relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                tab === 'transactions'
                  ? 'Filter Terminal ID, Reference, or Tx Hash...'
                  : 'Filter Journal ID, Account Ref, or Direction...'
              }
              className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg pl-9 pr-3 py-2 text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none"
            />
          </div>

          {tab === 'transactions' ? (
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as 'ALL' | TransactionType)}
              aria-label="Filter by transaction type"
              className="bg-[#05070A] border border-white/[0.12] rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-[#00E5FF] focus:outline-none"
            >
              <option value="ALL">All Types</option>
              <option value="internal_transfer">Internal Transfer</option>
              <option value="sub_allocation">Sub-Allocation</option>
              <option value="invoice_payment">Invoice Payment</option>
              <option value="trading_funding">Trading Funding</option>
              <option value="deposit">Deposit</option>
              <option value="withdrawal">Withdrawal</option>
            </select>
          ) : (
            <div className="bg-[#05070A] border border-white/[0.07] rounded-lg px-3 py-2 text-xs text-slate-500 flex items-center">
              Signed Zero-Sum Postings
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <select
              value={assetFilter}
              onChange={(e) => setAssetFilter(e.target.value as 'ALL' | AssetSymbol)}
              aria-label="Filter by asset"
              className="bg-[#05070A] border border-white/[0.12] rounded-lg px-2.5 py-2 text-xs text-slate-200 focus:border-[#00E5FF] focus:outline-none"
            >
              <option value="ALL">All Assets</option>
              <option value="USDT">USDT</option>
              <option value="BTC">BTC</option>
              <option value="ETH">ETH</option>
            </select>

            <select
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value as 'ALL' | '24H' | '7D' | '30D')}
              aria-label="Filter by date range"
              className="bg-[#05070A] border border-white/[0.12] rounded-lg px-2.5 py-2 text-xs text-slate-200 focus:border-[#00E5FF] focus:outline-none"
            >
              <option value="ALL">All Time</option>
              <option value="24H">Last 24h</option>
              <option value="7D">Last 7d</option>
              <option value="30D">Last 30d</option>
            </select>
          </div>

          {tab === 'transactions' && (
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'ALL' | TransactionStatus)}
              aria-label="Filter by status"
              className="bg-[#05070A] border border-white/[0.12] rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-[#00E5FF] focus:outline-none"
            >
              <option value="ALL">All Statuses</option>
              <option value="detected">Detected</option>
              <option value="pending">Pending</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="reversed">Reversed</option>
            </select>
          )}
        </div>
      </div>

      {/* High-Density Data Grid */}
      <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl overflow-hidden">
        {tab === 'transactions' ? (
          filteredTransactions.length === 0 ? (
            <div className="py-16 text-center space-y-3">
              <p className="text-sm text-slate-300">No ledger transactions match the active filters.</p>
              <button
                type="button"
                onClick={handleResetFilters}
                className="px-4 py-2 text-xs font-semibold text-[#05070A] bg-[#00E5FF] rounded-lg"
              >
                Clear All Filters
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/[0.08] text-[11px] font-medium text-slate-400 bg-[#05070A]/60">
                    <th className="py-2.5 px-4">Reference</th>
                    <th className="py-2.5 px-3">Timestamp</th>
                    <th className="py-2.5 px-3">Terminal</th>
                    <th className="py-2.5 px-3">Counterparty</th>
                    <th className="py-2.5 px-3">Type / Rail</th>
                    <th className="py-2.5 px-3 text-right">Amount</th>
                    <th className="py-2.5 px-3 text-right">Fee</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-4 text-right">Tx Hash</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05] text-xs">
                  {filteredTransactions.map((tx) => (
                    <tr key={tx.id} className="hover:bg-white/[0.025] transition-colors">
                      <td className="py-2.5 px-4 font-mono text-slate-200 whitespace-nowrap">
                        {tx.reference}
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                        {formatTimestamp(tx.created_at)}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-slate-300 whitespace-nowrap">
                        {resolveTerminalCode(terminals, tx.terminalUuid)}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[#00E5FF] whitespace-nowrap">
                        {truncateHash(tx.counterparty_terminal, 14, 6)}
                      </td>
                      <td className="py-2.5 px-3 text-slate-300 whitespace-nowrap">
                        <span className="capitalize">{tx.type.replace('_', ' ')}</span>
                        <span className="text-slate-600 mx-1.5">·</span>
                        <span className="text-slate-400">
                          {NETWORK_LABELS[tx.network] ?? tx.network}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-100 font-medium whitespace-nowrap">
                        {formatAssetAmount(tx.amount, tx.asset)}{' '}
                        <span className="text-slate-400">{tx.asset}</span>
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-400 whitespace-nowrap">
                        {tx.fee === 0 ? '0.00' : `${tx.fee} ${tx.asset}`}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span
                          className={`font-medium capitalize ${
                            tx.status === 'completed'
                              ? 'text-emerald-400'
                              : tx.status === 'pending' || tx.status === 'detected'
                                ? 'text-amber-400'
                                : 'text-red-400'
                          }`}
                        >
                          {tx.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-right whitespace-nowrap">
                        {tx.tx_hash ? (
                          <button
                            type="button"
                            onClick={() => onCopy(tx.tx_hash, 'Copied transaction hash')}
                            className="inline-flex items-center gap-1 font-mono text-slate-400 hover:text-[#00E5FF] transition-colors"
                            title={tx.tx_hash}
                          >
                            {truncateHash(tx.tx_hash, 8, 6)}
                            <Copy className="w-3 h-3" />
                          </button>
                        ) : (
                          <span className="font-mono text-slate-500">Pending broadcast</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : filteredPostings.length === 0 ? (
          <div className="py-16 text-center space-y-3">
            <p className="text-sm text-slate-300">No double-entry postings match your filter.</p>
            <button
              type="button"
              onClick={handleResetFilters}
              className="px-4 py-2 text-xs font-semibold text-[#05070A] bg-[#00E5FF] rounded-lg"
            >
              Clear Filters
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/[0.08] text-[11px] font-medium text-slate-400 bg-[#05070A]/60">
                  <th className="py-2.5 px-4">Journal ID</th>
                  <th className="py-2.5 px-3">Timestamp</th>
                  <th className="py-2.5 px-3">Account Ref</th>
                  <th className="py-2.5 px-3">Direction</th>
                  <th className="py-2.5 px-4 text-right">Signed Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05] text-xs">
                {filteredPostings.map((lp) => {
                  const isCredit = lp.amount > 0;
                  const direction = isCredit ? 'CREDIT' : 'DEBIT';
                  return (
                    <tr key={lp.id} className="hover:bg-white/[0.025] transition-colors">
                      <td className="py-2.5 px-4 font-mono text-slate-200 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => onCopy(lp.journal_id, 'Copied Journal UUID')}
                          className="inline-flex items-center gap-1.5 hover:text-[#00E5FF] transition-colors"
                          title={lp.journal_id}
                        >
                          {truncateHash(lp.journal_id, 8, 4)}
                          <Copy className="w-3 h-3 text-slate-500" />
                        </button>
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                        {formatTimestamp(lp.created_at)}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[#00E5FF] whitespace-nowrap">
                        {lp.account_ref}
                      </td>
                      <td className="py-2.5 px-3 font-mono font-semibold whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] border ${
                            isCredit
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                              : 'bg-amber-500/10 text-amber-400 border-amber-500/25'
                          }`}
                        >
                          {direction}
                        </span>
                      </td>
                      <td
                        className={`py-2.5 px-4 font-mono tabular-nums text-right font-medium whitespace-nowrap ${
                          isCredit ? 'text-emerald-400' : 'text-amber-300'
                        }`}
                      >
                        {isCredit ? '+' : '-'}
                        {formatAssetAmount(Math.abs(lp.amount), lp.asset)}{' '}
                        <span className="text-slate-400">{lp.asset}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
