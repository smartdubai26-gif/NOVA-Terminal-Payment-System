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
import { useLocale } from '../context/LocaleContext';

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
  const { tr } = useLocale();
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
            res.ok
              ? tr('Double-Entry Invariant Verified', 'تم التحقق من توازن القيد المزدوج')
              : tr('Ledger Imbalance Detected', 'تم اكتشاف عدم توازن في الدفتر'),
            res.ok
              ? `SUM(amount) = 0 across ${res.journalCount} journal groups (${res.postingCount} postings).`
              : `${res.imbalancedCount} journal groups failed SUM(amount) = 0 invariant.`,
            res.ok ? 'success' : 'error'
          );
        }
      } catch (err) {
        if (notifyOnComplete) {
          onToast(
            tr('Invariant Check Failed', 'فشل التحقق من التوازن'),
            err instanceof Error ? err.message : 'Unable to verify ledger invariant.',
            'error'
          );
        }
      } finally {
        setIsVerifying(false);
      }
    },
    [authMode, ledgerPostings, onVerifyLedgerInvariant, onToast, tr]
  );

  useEffect(() => {
    void runInvariantVerification(false);
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
        tr('Exported transactions CSV', 'تم تصدير ملف المعاملات CSV'),
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
        tr('Exported double-entry postings CSV', 'تم تصدير قيود القيد المزدوج CSV'),
        `${filteredPostings.length} immutable postings exported`,
        'success'
      );
    }
  };

  return (
    <div className="space-y-4">
      {/* Double-Entry Ledger Invariant Status Banner */}
      <div
        className={`rounded-xl border p-4 flex flex-wrap items-center justify-between gap-4 shadow-xs ${
          invariantResult === null
            ? 'bg-white border-[#E2E8F0]'
            : invariantResult.ok
              ? 'bg-emerald-50/70 border-emerald-200'
              : 'bg-red-50 border-red-200'
        }`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={`w-9 h-9 rounded-lg flex items-center justify-center border shrink-0 ${
              invariantResult === null
                ? 'bg-[#F4F7FA] border-[#E2E8F0] text-slate-500'
                : invariantResult.ok
                  ? 'bg-emerald-100 border-emerald-300 text-emerald-700'
                  : 'bg-red-100 border-red-300 text-red-700'
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
              <h2 className="text-xs font-semibold text-[#0F172A]">
                {tr('Double-Entry Invariant (SUM = 0)', 'ثابت القيد المزدوج (SUM = 0)')}
              </h2>
              {invariantResult && (
                <span
                  className={`text-[11px] font-mono font-semibold px-2 py-0.5 rounded border ${
                    invariantResult.ok
                      ? 'bg-white text-emerald-700 border-emerald-300'
                      : 'bg-white text-red-700 border-red-300'
                  }`}
                >
                  {invariantResult.ok
                    ? tr('BALANCED · APPEND-ONLY', 'متوازن · إضافة فقط')
                    : `${invariantResult.imbalancedCount} ${tr('IMBALANCED', 'غير متوازن')}`}
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-600 font-mono tabular-nums mt-0.5">
              {invariantResult
                ? `${invariantResult.journalCount} journal groups · ${invariantResult.postingCount} postings · ${
                    authMode === 'supabase' ? 'Verified via PostgreSQL RPC' : 'Local Engine Check'
                  }`
                : tr('Running double-entry balance verification...', 'جاري التحقق من توازن القيد المزدوج...')}
            </p>
          </div>
        </div>

        <button
          type="button"
          disabled={isVerifying}
          onClick={() => void runInvariantVerification(true)}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#0F172A] bg-white hover:bg-[#F8FAFC] disabled:opacity-45 border border-[#E2E8F0] rounded-lg transition-colors whitespace-nowrap"
        >
          <RefreshCcw className={`w-3.5 h-3.5 text-[#1E40AF] ${isVerifying ? 'animate-spin' : ''}`} />
          {isVerifying ? tr('Verifying...', 'جاري التحقق...') : tr('Verify Invariant', 'التحقق من التوازن')}
        </button>
      </div>

      {/* Header & Filter Bar */}
      <div className="bg-white border border-[#E2E8F0] rounded-xl p-5 space-y-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-1 p-1 bg-[#F4F7FA] border border-[#E2E8F0] rounded-lg">
            <button
              type="button"
              onClick={() => setTab('transactions')}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                tab === 'transactions'
                  ? 'bg-[#1E40AF] text-white shadow-xs'
                  : 'text-slate-600 hover:text-[#0F172A]'
              }`}
            >
              {tr('Transactions', 'المعاملات')} ({filteredTransactions.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('postings')}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                tab === 'postings'
                  ? 'bg-[#1E40AF] text-white shadow-xs'
                  : 'text-slate-600 hover:text-[#0F172A]'
              }`}
            >
              {tr('Double-Entry Ledger', 'دفتر القيد المزدوج')} ({filteredPostings.length})
            </button>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleResetFilters}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 bg-[#F4F7FA] hover:bg-slate-200/70 border border-[#E2E8F0] rounded-lg transition-colors whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {tr('Reset', 'إعادة ضبط')}
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors whitespace-nowrap shadow-xs"
            >
              <Download className="w-3.5 h-3.5" />
              {tr('Export CSV', 'تصدير CSV')}
            </button>
          </div>
        </div>

        {/* Filter Controls */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="lg:col-span-2 relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute start-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                tab === 'transactions'
                  ? tr('Filter Terminal ID, Reference, or Tx Hash...', 'تصفية برقم المحطة أو المرجع أو التجزئة...')
                  : tr('Filter Journal ID, Account Ref, or Direction...', 'تصفية برقم اليومية أو الحساب أو الاتجاه...')
              }
              className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg ps-9 pe-3 py-2 text-xs font-mono text-[#0F172A] placeholder:text-slate-400 focus:outline-none"
            />
          </div>

          {tab === 'transactions' ? (
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as 'ALL' | TransactionType)}
              aria-label="Filter by transaction type"
              className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-xs text-[#0F172A] focus:border-[#1E40AF] focus:outline-none"
            >
              <option value="ALL">{tr('All Types', 'كل الأنواع')}</option>
              <option value="internal_transfer">{tr('Internal Transfer', 'تحويل داخلي')}</option>
              <option value="sub_allocation">{tr('Sub-Allocation', 'تخصيص فرعي')}</option>
              <option value="invoice_payment">{tr('Invoice Payment', 'دفع فاتورة')}</option>
              <option value="trading_funding">{tr('Trading Funding', 'تمويل التداول')}</option>
              <option value="deposit">{tr('Deposit', 'إيداع')}</option>
              <option value="withdrawal">{tr('Withdrawal', 'سحب')}</option>
            </select>
          ) : (
            <div className="bg-[#F4F7FA] border border-[#E2E8F0] rounded-lg px-3 py-2 text-xs text-slate-600 flex items-center">
              {tr('Signed Zero-Sum Postings', 'قيود موقعة صفرية المجموع')}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <select
              value={assetFilter}
              onChange={(e) => setAssetFilter(e.target.value as 'ALL' | AssetSymbol)}
              aria-label="Filter by asset"
              className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-2.5 py-2 text-xs text-[#0F172A] focus:border-[#1E40AF] focus:outline-none"
            >
              <option value="ALL">{tr('All Assets', 'كل الأصول')}</option>
              <option value="USDT">USDT</option>
              <option value="BTC">BTC</option>
              <option value="ETH">ETH</option>
            </select>

            <select
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value as 'ALL' | '24H' | '7D' | '30D')}
              aria-label="Filter by date range"
              className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-2.5 py-2 text-xs text-[#0F172A] focus:border-[#1E40AF] focus:outline-none"
            >
              <option value="ALL">{tr('All Time', 'كل الأوقات')}</option>
              <option value="24H">{tr('Last 24h', 'آخر 24 ساعة')}</option>
              <option value="7D">{tr('Last 7d', 'آخر 7 أيام')}</option>
              <option value="30D">{tr('Last 30d', 'آخر 30 يوماً')}</option>
            </select>
          </div>

          {tab === 'transactions' && (
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'ALL' | TransactionStatus)}
              aria-label="Filter by status"
              className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-xs text-[#0F172A] focus:border-[#1E40AF] focus:outline-none"
            >
              <option value="ALL">{tr('All Statuses', 'كل الحالات')}</option>
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
      <div className="bg-white border border-[#E2E8F0] rounded-xl overflow-hidden shadow-xs">
        {tab === 'transactions' ? (
          filteredTransactions.length === 0 ? (
            <div className="py-16 text-center space-y-3">
              <p className="text-sm text-slate-600">
                {tr('No ledger transactions match the active filters.', 'لا توجد معاملات تطابق عوامل التصفية.')}
              </p>
              <button
                type="button"
                onClick={handleResetFilters}
                className="px-4 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg"
              >
                {tr('Clear All Filters', 'مسح كل الفلاتر')}
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="border-b border-[#E2E8F0] text-[11px] font-semibold text-[#0F172A] bg-[#F8FAFC]">
                    <th className="py-2.5 px-4 text-start">{tr('Reference', 'المرجع')}</th>
                    <th className="py-2.5 px-3 text-start">{tr('Timestamp', 'الوقت')}</th>
                    <th className="py-2.5 px-3 text-start">{tr('Terminal', 'المحطة')}</th>
                    <th className="py-2.5 px-3 text-start">{tr('Counterparty', 'الطرف المقابل')}</th>
                    <th className="py-2.5 px-3 text-start">{tr('Type / Rail', 'النوع / الشبكة')}</th>
                    <th className="py-2.5 px-3 text-end">{tr('Amount', 'المبلغ')}</th>
                    <th className="py-2.5 px-3 text-end">{tr('Fee', 'الرسوم')}</th>
                    <th className="py-2.5 px-3 text-start">{tr('Status', 'الحالة')}</th>
                    <th className="py-2.5 px-4 text-end">{tr('Tx Hash', 'تجزئة المعاملة')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0] text-xs bg-white">
                  {filteredTransactions.map((tx) => (
                    <tr key={tx.id} className="hover:bg-[#F8FAFC] transition-colors">
                      <td className="py-2.5 px-4 font-mono tabular-nums text-[#0F172A] font-medium whitespace-nowrap">
                        {tx.reference}
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                        {formatTimestamp(tx.created_at)}
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {resolveTerminalCode(terminals, tx.terminalUuid)}
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-[#1E40AF] font-medium whitespace-nowrap">
                        {truncateHash(tx.counterparty_terminal, 14, 6)}
                      </td>
                      <td className="py-2.5 px-3 text-slate-700 whitespace-nowrap">
                        <span className="capitalize">{tx.type.replace('_', ' ')}</span>
                        <span className="text-slate-400 mx-1.5">·</span>
                        <span className="text-slate-500">
                          {NETWORK_LABELS[tx.network] ?? tx.network}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-end text-[#0F172A] font-semibold whitespace-nowrap">
                        {formatAssetAmount(tx.amount, tx.asset)}{' '}
                        <span className="text-slate-500 font-normal">{tx.asset}</span>
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-end text-slate-500 whitespace-nowrap">
                        {tx.fee === 0 ? '0.00' : `${tx.fee} ${tx.asset}`}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-semibold capitalize ${
                            tx.status === 'completed'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : tx.status === 'pending' || tx.status === 'detected'
                                ? 'bg-amber-50 text-amber-800 border-amber-200'
                                : 'bg-red-50 text-red-700 border-red-200'
                          }`}
                        >
                          {tx.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-end whitespace-nowrap">
                        {tx.tx_hash ? (
                          <button
                            type="button"
                            onClick={() => onCopy(tx.tx_hash, tr('Copied transaction hash', 'تم نسخ تجزئة المعاملة'))}
                            className="inline-flex items-center gap-1 font-mono tabular-nums text-slate-600 hover:text-[#1E40AF] transition-colors"
                            title={tx.tx_hash}
                          >
                            {truncateHash(tx.tx_hash, 8, 6)}
                            <Copy className="w-3 h-3" />
                          </button>
                        ) : (
                          <span className="font-mono text-slate-400">{tr('Pending broadcast', 'بانتظار البث')}</span>
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
            <p className="text-sm text-slate-600">
              {tr('No double-entry postings match your filter.', 'لا توجد قيود مزدوجة تطابق التصفية.')}
            </p>
            <button
              type="button"
              onClick={handleResetFilters}
              className="px-4 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg"
            >
              {tr('Clear Filters', 'مسح الفلاتر')}
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-[#E2E8F0] text-[11px] font-semibold text-[#0F172A] bg-[#F8FAFC]">
                  <th className="py-2.5 px-4 text-start">{tr('Journal ID', 'معرف اليومية')}</th>
                  <th className="py-2.5 px-3 text-start">{tr('Timestamp', 'الوقت')}</th>
                  <th className="py-2.5 px-3 text-start">{tr('Account Ref', 'مرجع الحساب')}</th>
                  <th className="py-2.5 px-3 text-start">{tr('Direction', 'الاتجاه')}</th>
                  <th className="py-2.5 px-4 text-end">{tr('Signed Amount', 'المبلغ الموقع')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0] text-xs bg-white">
                {filteredPostings.map((lp) => {
                  const isCredit = lp.amount > 0;
                  const direction = isCredit ? 'CREDIT' : 'DEBIT';
                  return (
                    <tr key={lp.id} className="hover:bg-[#F8FAFC] transition-colors">
                      <td className="py-2.5 px-4 font-mono tabular-nums text-[#0F172A] whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => onCopy(lp.journal_id, tr('Copied Journal UUID', 'تم نسخ معرف اليومية'))}
                          className="inline-flex items-center gap-1.5 hover:text-[#1E40AF] transition-colors"
                          title={lp.journal_id}
                        >
                          {truncateHash(lp.journal_id, 8, 4)}
                          <Copy className="w-3 h-3 text-slate-400" />
                        </button>
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                        {formatTimestamp(lp.created_at)}
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-[#1E40AF] font-medium whitespace-nowrap">
                        {lp.account_ref}
                      </td>
                      <td className="py-2.5 px-3 font-mono font-semibold whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] border ${
                            isCredit
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-amber-50 text-amber-800 border-amber-200'
                          }`}
                        >
                          {direction}
                        </span>
                      </td>
                      <td
                        className={`py-2.5 px-4 font-mono tabular-nums text-end font-semibold whitespace-nowrap ${
                          isCredit ? 'text-emerald-700' : 'text-amber-800'
                        }`}
                      >
                        {isCredit ? '+' : '-'}
                        {formatAssetAmount(Math.abs(lp.amount), lp.asset)}{' '}
                        <span className="text-slate-500 font-normal">{lp.asset}</span>
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
