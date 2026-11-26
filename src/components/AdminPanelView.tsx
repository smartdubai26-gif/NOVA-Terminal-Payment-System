import { useState, useMemo } from 'react';
import {
  ShieldAlert,
  ShieldCheck,
  Search,
  CheckCircle2,
  XCircle,
  Lock,
  Unlock,
  RefreshCcw,
  Check,
  AlertCircle,
  UserCheck,
  FileText,
  Eye,
  X,
  ExternalLink,
} from 'lucide-react';
import type {
  AdminProfile,
  AssetRateMap,
  AssetSymbol,
  AuditLogRecord,
  KycSubmissionRecord,
  LedgerInvariantResult,
  LedgerPosting,
  TerminalRecord,
  TransactionRecord,
  WalletBalance,
  WithdrawalRequestRecord,
} from '../types/ntps';
import {
  ASSET_USD_RATES,
  computePortfolioUsd,
  createKycDocumentSignedUrl,
  getTerminalAssetTotal,
  resolveTerminalCode,
  verifyLedgerInvariant,
  type LedgerRuntimeMode,
} from '../lib/ledgerEngine';
import { formatAssetAmount, formatTimestamp, formatUsd } from '../lib/format';
import { useLocale } from '../context/LocaleContext';

interface AdminPanelViewProps {
  terminals: TerminalRecord[];
  wallets: WalletBalance[];
  transactions: TransactionRecord[];
  ledgerPostings: LedgerPosting[];
  auditLogs: AuditLogRecord[];
  withdrawalRequests?: WithdrawalRequestRecord[];
  kycQueue?: KycSubmissionRecord[];
  assetRates?: AssetRateMap;
  authMode?: LedgerRuntimeMode;
  adminProfile?: AdminProfile;
  onVerifyLedgerInvariant?: () => Promise<LedgerInvariantResult>;
  onUpdateTerminalStatus: (params: {
    terminalUuid: string;
    status: 'active' | 'suspended' | 'locked' | 'restricted';
    reason: string;
  }) => Promise<void>;
  onReviewWithdrawal: (params: {
    transactionId: string;
    action: 'approve' | 'reject';
    reason: string;
  }) => Promise<void>;
  onReviewKyc?: (params: {
    submissionId: string;
    decision: 'approved' | 'rejected';
    reason?: string;
  }) => Promise<void>;
  onToast: (title: string, description?: string, variant?: 'success' | 'error' | 'info') => void;
}

function isSafePreviewUrl(url: string): boolean {
  return (
    url.startsWith('https://') ||
    url.startsWith('http://localhost') ||
    url.startsWith('http://127.0.0.1') ||
    url.startsWith('blob:') ||
    url.startsWith('data:image/')
  );
}

export function AdminPanelView({
  terminals,
  wallets,
  transactions,
  ledgerPostings,
  auditLogs,
  withdrawalRequests = [],
  kycQueue = [],
  assetRates = ASSET_USD_RATES,
  authMode = 'local_demo',
  adminProfile,
  onVerifyLedgerInvariant,
  onUpdateTerminalStatus,
  onReviewWithdrawal,
  onReviewKyc,
  onToast,
}: AdminPanelViewProps) {
  const { tr } = useLocale();
  const [adminTab, setAdminTab] = useState<'explorer' | 'withdrawals' | 'kyc' | 'treasury' | 'audit'>('explorer');

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTermUuid, setSelectedTermUuid] = useState(terminals[0]?.id ?? '');
  const [statusReason, setStatusReason] = useState('');
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);

  const [reviewReason, setReviewReason] = useState('');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewingTxId, setReviewingTxId] = useState<string | null>(null);

  const [kycFilter, setKycFilter] = useState<'all' | 'pending_review' | 'approved' | 'rejected'>('all');
  const [kycSearch, setKycSearch] = useState('');
  const [selectedKycId, setSelectedKycId] = useState<string>(kycQueue[0]?.id ?? '');
  const [kycReason, setKycReason] = useState('');
  const [kycError, setKycError] = useState<string | null>(null);
  const [reviewingKycId, setReviewingKycId] = useState<string | null>(null);
  const [docPreviewLoading, setDocPreviewLoading] = useState<string | null>(null);
  const [docPreview, setDocPreview] = useState<{
    label: string;
    url: string;
    mimeType: string;
  } | null>(null);

  const [reconciling, setReconciling] = useState(false);
  const [reconciledResult, setReconciledResult] = useState<LedgerInvariantResult | null>(null);

  const selectedTerminal =
    terminals.find((t) => t.id === selectedTermUuid) ?? terminals[0];

  const filteredTerminals = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return terminals;
    return terminals.filter(
      (t) => t.terminalId.toLowerCase().includes(q) || t.label.toLowerCase().includes(q)
    );
  }, [terminals, searchTerm]);

  const withdrawalRequestByTxId = useMemo(() => {
    const map = new Map<string, WithdrawalRequestRecord>();
    for (const req of withdrawalRequests) {
      map.set(req.transaction_id, req);
    }
    return map;
  }, [withdrawalRequests]);

  const flaggedWithdrawals = useMemo(
    () =>
      transactions.filter((tx) => {
        if (tx.type !== 'withdrawal') return false;
        const req = withdrawalRequestByTxId.get(tx.id);
        if (req && (req.state === 'review' || req.state === 'approved' || req.state === 'broadcast')) {
          return true;
        }
        return tx.status === 'pending' || tx.status === 'detected';
      }),
    [transactions, withdrawalRequestByTxId]
  );

  const totalPortfolio = computePortfolioUsd(wallets, undefined, assetRates);
  const hotWalletUsd = totalPortfolio * 0.035;
  const warmMpcUsd = totalPortfolio * 0.315;
  const coldStorageUsd = totalPortfolio * 0.65;

  const canExecuteAdminActions =
    authMode === 'local_demo' ||
    Boolean(
      adminProfile?.isAdmin &&
        adminProfile.isActive &&
        adminProfile.role &&
        (adminProfile.role === 'ops' ||
          adminProfile.role === 'compliance' ||
          adminProfile.role === 'super_admin')
    );

  const canReviewKyc =
    authMode === 'local_demo' ||
    Boolean(
      adminProfile?.isAdmin &&
        adminProfile.isActive &&
        adminProfile.role &&
        (adminProfile.role === 'compliance' || adminProfile.role === 'super_admin')
    );

  const pendingKycCount = useMemo(
    () => kycQueue.filter((item) => item.status === 'pending_review').length,
    [kycQueue]
  );

  const filteredKycQueue = useMemo(() => {
    const q = kycSearch.trim().toLowerCase();
    return kycQueue.filter((item) => {
      if (kycFilter !== 'all' && item.status !== kycFilter) return false;
      if (!q) return true;
      return (
        item.full_legal_name.toLowerCase().includes(q) ||
        item.country_of_residence.toLowerCase().includes(q) ||
        item.nationality.toLowerCase().includes(q) ||
        item.account_type.toLowerCase().includes(q)
      );
    });
  }, [kycQueue, kycFilter, kycSearch]);

  const selectedKycSubmission =
    filteredKycQueue.find((item) => item.id === selectedKycId) ??
    kycQueue.find((item) => item.id === selectedKycId) ??
    filteredKycQueue[0] ??
    null;

  const handleOpenKycDocument = async (path: string | null | undefined, label: string) => {
    if (!path) return;
    setKycError(null);
    setDocPreviewLoading(label);
    try {
      const signed = await createKycDocumentSignedUrl({ path, label, authMode });
      if (!isSafePreviewUrl(signed.url)) {
        throw new Error('Blocked unsafe document preview URI scheme.');
      }
      setDocPreview({ label, url: signed.url, mimeType: signed.mimeType });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to fetch temporary document preview.';
      setKycError(msg);
      onToast(tr('Document preview blocked', 'تم حظر معاينة المستند'), msg, 'error');
    } finally {
      setDocPreviewLoading(null);
    }
  };

  const handleKycDecision = async (
    submission: KycSubmissionRecord,
    decision: 'approved' | 'rejected'
  ) => {
    if (!onReviewKyc) return;
    setKycError(null);
    const trimmedReason = kycReason.trim();
    if (decision === 'rejected' && !trimmedReason) {
      const msg = 'Enter a mandatory rejection reason explaining why the KYC/KYB submission was declined.';
      setKycError(msg);
      onToast(tr('Rejection reason required', 'سبب الرفض مطلوب'), msg, 'error');
      return;
    }
    setReviewingKycId(submission.id);
    try {
      await onReviewKyc({
        submissionId: submission.id,
        decision,
        reason: trimmedReason || undefined,
      });
      setKycReason('');
      onToast(
        decision === 'approved'
          ? tr('KYC / KYB submission approved', 'تمت الموافقة على التوثيق')
          : tr('KYC / KYB submission rejected', 'تم رفض طلب التوثيق'),
        `${submission.account_type === 'corporate' ? 'Corporate KYB' : 'Individual KYC'} dossier updated.`,
        decision === 'approved' ? 'success' : 'info'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to record compliance decision.';
      setKycError(msg);
      onToast(tr('KYC review failed', 'فشلت مراجعة التوثيق'), msg, 'error');
    } finally {
      setReviewingKycId(null);
    }
  };

  const handleStatusChange = async (newStatus: 'active' | 'suspended' | 'locked' | 'restricted') => {
    if (!selectedTerminal) return;
    setStatusError(null);
    if (!statusReason.trim()) {
      const msg = 'Provide a mandatory compliance note for terminal status change.';
      setStatusError(msg);
      onToast(tr('Audit reason required', 'سبب التدقيق مطلوب'), msg, 'error');
      return;
    }
    setIsUpdatingStatus(true);
    try {
      await onUpdateTerminalStatus({
        terminalUuid: selectedTerminal.id,
        status: newStatus,
        reason: statusReason.trim(),
      });
      setStatusReason('');
      onToast(tr('Terminal status updated', 'تم تحديث حالة المحطة'), `${selectedTerminal.terminalId} set to ${newStatus}`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to update terminal status';
      setStatusError(msg);
      onToast(tr('Admin action blocked', 'تم حظر الإجراء الإداري'), msg, 'error');
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  const handleReviewAction = async (
    tx: TransactionRecord,
    action: 'approve' | 'reject'
  ) => {
    setReviewError(null);
    if (!reviewReason.trim()) {
      const msg = 'Enter a mandatory compliance review reason before approving or rejecting.';
      setReviewError(msg);
      onToast(tr('Review reason required', 'سبب المراجعة مطلوب'), msg, 'error');
      return;
    }
    setReviewingTxId(tx.id);
    try {
      await onReviewWithdrawal({
        transactionId: tx.id,
        action,
        reason: reviewReason.trim(),
      });
      setReviewReason('');
      if (action === 'approve') {
        onToast(
          authMode === 'supabase'
            ? tr('Withdrawal approved for TRON worker', 'تم اعتماد السحب لمعالج TRON')
            : tr('Withdrawal approved', 'تم اعتماد السحب'),
          tx.reference,
          'success'
        );
      } else {
        onToast(tr('Withdrawal rejected & refunded', 'تم رفض السحب وإعادة المبلغ'), tx.reference, 'info');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to review withdrawal request';
      setReviewError(msg);
      onToast(tr('Withdrawal review blocked', 'تم حظر مراجعة السحب'), msg, 'error');
    } finally {
      setReviewingTxId(null);
    }
  };

  const runReconciliationCheck = async () => {
    setReconciling(true);
    setReconciledResult(null);
    try {
      const result = onVerifyLedgerInvariant
        ? await onVerifyLedgerInvariant()
        : await verifyLedgerInvariant(authMode, ledgerPostings);
      setReconciledResult(result);
      if (result.ok) {
        onToast(
          tr('Ledger Reconciliation Passed', 'نجحت مطابقة الدفتر'),
          `SUM(amount) = 0 across ${result.journalCount} journal groups (${result.postingCount} postings). Zero discrepancies.`,
          'success'
        );
      } else {
        onToast(
          tr('Reconciliation Discrepancy Detected', 'تم اكتشاف اختلاف في المطابقة'),
          `${result.imbalancedCount} journal entries failed SUM(amount) = 0 invariant.`,
          'error'
        );
      }
    } catch (err) {
      onToast(
        tr('Reconciliation Failed', 'فشلت المطابقة'),
        err instanceof Error ? err.message : 'Unable to execute ledger invariant check.',
        'error'
      );
    } finally {
      setReconciling(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Sub-Tabs */}
      <div className="bg-white border border-[#E2E8F0] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-[#1E40AF] flex items-center justify-center shrink-0">
            <ShieldAlert className="w-4 h-4 text-[#D6FF3D]" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-[#0F172A]">
              {tr('Institutional Admin & Compliance Panel', 'لوحة الإدارة والامتثال المؤسسي')}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {tr(
                'Terminal security controls, four-eyes withdrawal review, and zero-sum double-entry reconciliation',
                'ضوابط أمان المحطات، ومراجعة السحوبات الرباعية، ومطابقة القيد المزدوج'
              )}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-[#F4F7FA] border border-[#E2E8F0] rounded-lg">
          {(
            [
              { id: 'explorer', label: tr('Terminal Explorer', 'مستكشف المحطات') },
              { id: 'withdrawals', label: `${tr('Withdrawal Queue', 'قائمة السحوبات')} (${flaggedWithdrawals.length})` },
              { id: 'kyc', label: `${tr('KYC Queue', 'قائمة التوثيق')} (${pendingKycCount})` },
              { id: 'treasury', label: tr('Treasury & Recon', 'الخزينة والمطابقة') },
              { id: 'audit', label: tr('Hash-Chain Audit', 'سجل التجزئة') },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setAdminTab(tab.id)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                adminTab === tab.id
                  ? 'bg-[#1E40AF] text-white shadow-xs'
                  : 'text-slate-600 hover:text-[#0F172A]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* RBAC Session Role Status */}
      <div
        className={`rounded-xl px-5 py-3.5 border flex flex-wrap items-center justify-between gap-3 text-xs shadow-xs ${
          authMode === 'local_demo'
            ? 'bg-amber-50 border-amber-200 text-amber-900'
            : canExecuteAdminActions
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
        }`}
      >
        <div className="flex items-center gap-2.5">
          {authMode === 'local_demo' ? (
            <ShieldAlert className="w-4 h-4 text-amber-700 shrink-0" />
          ) : canExecuteAdminActions ? (
            <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-red-700 shrink-0" />
          )}
          <div>
            {authMode === 'local_demo' ? (
              <span>
                <strong className="font-semibold">{tr('Local Demo RBAC Override:', 'تجاوز صلاحيات العرض المحلي:')}</strong>{' '}
                Operating as simulated{' '}
                <code className="font-mono font-semibold text-[#1E40AF] bg-white px-1 py-0.5 rounded border border-amber-200">
                  super_admin
                </code>{' '}
                on local sandbox data.
              </span>
            ) : canExecuteAdminActions ? (
              <span>
                <strong className="font-semibold">{tr('Verified Admin RBAC Session:', 'جلسة صلاحيات إدارية موثقة:')}</strong>{' '}
                Active role{' '}
                <code className="font-mono font-semibold text-[#0F172A] bg-white px-1 py-0.5 rounded border border-emerald-200">
                  {adminProfile?.role}
                </code>{' '}
                in <code className="font-mono">public.app_admins</code>.
              </span>
            ) : (
              <span>
                <strong className="font-semibold">{tr('Unauthorized for Admin Mutations:', 'غير مخول بالتعديلات الإدارية:')}</strong>{' '}
                {adminProfile?.role
                  ? `Role "${adminProfile.role}" is read-only for freezes and withdrawal approvals.`
                  : 'No active admin role found in public.app_admins.'}{' '}
                PostgreSQL RBAC requires an active <code className="font-mono">ops</code>,{' '}
                <code className="font-mono">compliance</code>, or{' '}
                <code className="font-mono">super_admin</code> assignment.
              </span>
            )}
          </div>
        </div>
        <span className="font-mono text-[11px] uppercase tracking-wider font-semibold">
          {authMode === 'local_demo'
            ? 'DEMO · super_admin'
            : adminProfile?.isAdmin
              ? `ROLE · ${adminProfile.role}`
              : 'ROLE · none'}
        </span>
      </div>

      {/* Tab 1: Terminal Explorer */}
      {adminTab === 'explorer' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 bg-white border border-[#E2E8F0] rounded-xl p-5 space-y-4 shadow-xs">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute start-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={tr('Search terminal ID or label...', 'ابحث برقم المحطة أو الاسم...')}
                className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg ps-9 pe-3 py-2 text-xs font-mono text-[#0F172A] placeholder:text-slate-400 focus:outline-none"
              />
            </div>

            <div className="divide-y divide-[#E2E8F0] max-h-[500px] overflow-y-auto">
              {filteredTerminals.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-500">
                  {tr('No terminals matched or provisioned yet.', 'لا توجد محطات مطابقة بعد.')}
                </div>
              ) : (
                filteredTerminals.map((t) => {
                  const isSelected = t.id === selectedTermUuid;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setSelectedTermUuid(t.id)}
                      className={`w-full text-start p-3.5 rounded-lg transition-colors flex items-center justify-between gap-3 ${
                        isSelected
                          ? 'bg-blue-50/80 border-s-2 border-s-[#1E40AF]'
                          : 'hover:bg-[#F8FAFC]'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-[#0F172A] truncate">{t.label}</span>
                          <span
                            className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded uppercase border ${
                              t.status === 'active'
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : 'bg-red-50 text-red-700 border-red-200'
                            }`}
                          >
                            {t.status}
                          </span>
                        </div>
                        <p className="font-mono tabular-nums text-xs text-[#1E40AF] font-medium mt-1">
                          {t.terminalId}
                        </p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="lg:col-span-7 bg-white border border-[#E2E8F0] rounded-xl p-6 space-y-6 shadow-xs">
            {selectedTerminal ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#E2E8F0] pb-4">
                  <div>
                    <h3 className="text-base font-semibold text-[#0F172A]">
                      {selectedTerminal.label}
                    </h3>
                    <p className="font-mono tabular-nums text-xs text-[#1E40AF] font-semibold mt-0.5">
                      {selectedTerminal.terminalId}
                    </p>
                  </div>
                  <span
                    className={`px-3 py-1 rounded-md text-xs font-semibold capitalize border ${
                      selectedTerminal.status === 'active'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-red-50 text-red-700 border-red-200'
                    }`}
                  >
                    {tr('Status:', 'الحالة:')} {selectedTerminal.status}
                  </span>
                </div>

                {/* Wallets */}
                <div className="space-y-3">
                  <h4 className="text-xs font-semibold text-[#0F172A]">{tr('Asset Balances', 'أرصدة الأصول')}</h4>
                  <div className="grid grid-cols-3 gap-3">
                    {(['USDT', 'BTC', 'ETH'] as AssetSymbol[]).map((sym) => {
                      const bal = getTerminalAssetTotal(wallets, selectedTerminal.id, sym);
                      return (
                        <div key={sym} className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-3">
                          <span className="font-mono text-xs font-bold text-[#1E40AF]">{sym}</span>
                          <div className="font-mono tabular-nums text-sm text-[#0F172A] font-semibold mt-1">
                            {formatAssetAmount(bal.available, sym)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Admin Status Controls */}
                <div className="space-y-4 pt-4 border-t border-[#E2E8F0]">
                  <h4 className="text-xs font-semibold text-[#0F172A]">
                    {tr('Compliance Security Actions', 'إجراءات الأمان والامتثال')}
                  </h4>

                  <div className="space-y-2">
                    <label htmlFor="admin-status-reason" className="text-xs font-medium text-slate-600">
                      {tr('Mandatory Audit Reason / Case Number', 'سبب التدقيق الإلزامي / رقم الحالة')}
                    </label>
                    <input
                      id="admin-status-reason"
                      type="text"
                      value={statusReason}
                      onChange={(e) => {
                        setStatusReason(e.target.value);
                        if (statusError) setStatusError(null);
                      }}
                      placeholder="e.g. KYC Compliance Case #98214 - Temporary Freeze"
                      className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2 text-xs text-[#0F172A] placeholder:text-slate-400 focus:outline-none"
                    />
                  </div>

                  {statusError && (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
                      <span>{statusError}</span>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-3">
                    {selectedTerminal.status !== 'active' ? (
                      <button
                        type="button"
                        disabled={isUpdatingStatus}
                        onClick={() => handleStatusChange('active')}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg shadow-xs"
                      >
                        <Unlock className="w-3.5 h-3.5" />
                        {tr('Unfreeze & Restore Active', 'إلغاء التجميد والتفعيل')}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={isUpdatingStatus}
                          onClick={() => handleStatusChange('suspended')}
                          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg"
                        >
                          <Lock className="w-3.5 h-3.5" />
                          {tr('Suspend Terminal', 'تعليق المحطة')}
                        </button>
                        <button
                          type="button"
                          disabled={isUpdatingStatus}
                          onClick={() => handleStatusChange('locked')}
                          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg"
                        >
                          <Lock className="w-3.5 h-3.5" />
                          {tr('Emergency Lock', 'إغلاق طارئ')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="py-12 text-center text-xs text-slate-500">
                {tr(
                  'Select or provision an active terminal to inspect wallet balances and compliance actions.',
                  'اختر محطة نشطة لعرض أرصدتها وإجراءات الامتثال.'
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 2: Withdrawal Review Queue */}
      {adminTab === 'withdrawals' && (
        <div className="bg-white border border-[#E2E8F0] rounded-xl overflow-hidden shadow-xs">
          <div className="px-5 py-4 border-b border-[#E2E8F0] space-y-3">
            <h3 className="text-sm font-semibold text-[#0F172A]">
              {tr('Pending & Flagged Withdrawals (Four-Eyes Review)', 'السحوبات المعلقة والموسومة (مراجعة رباعية)')}
            </h3>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <label htmlFor="admin-review-reason" className="text-xs font-medium text-slate-600 whitespace-nowrap">
                {tr('Mandatory Review Reason:', 'سبب المراجعة الإلزامي:')}
              </label>
              <input
                id="admin-review-reason"
                type="text"
                value={reviewReason}
                onChange={(e) => {
                  setReviewReason(e.target.value);
                  if (reviewError) setReviewError(null);
                }}
                placeholder="e.g. Four-eyes custody check passed · Ticket #4419"
                className="flex-1 bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2 text-xs text-[#0F172A] placeholder:text-slate-400 focus:outline-none"
              />
            </div>
            {reviewError && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
                <span>{reviewError}</span>
              </div>
            )}
          </div>

          {flaggedWithdrawals.length === 0 ? (
            <div className="py-16 text-center space-y-2">
              <CheckCircle2 className="w-8 h-8 text-emerald-600 mx-auto" />
              <p className="text-sm text-slate-600">
                {tr('No pending or flagged withdrawals in queue.', 'لا توجد سحوبات معلقة في قائمة الانتظار.')}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="border-b border-[#E2E8F0] text-[11px] font-semibold text-[#0F172A] bg-[#F8FAFC]">
                    <th className="py-2.5 px-4 text-start">{tr('Reference', 'المرجع')}</th>
                    <th className="py-2.5 px-3 text-start">{tr('Terminal ID', 'معرف المحطة')}</th>
                    <th className="py-2.5 px-3 text-start">{tr('Destination', 'الوجهة')}</th>
                    <th className="py-2.5 px-3 text-end">{tr('Amount', 'المبلغ')}</th>
                    <th className="py-2.5 px-3 text-start">{tr('Risk Score', 'درجة المخاطر')}</th>
                    <th className="py-2.5 px-3 text-start">{tr('Status', 'الحالة')}</th>
                    <th className="py-2.5 px-4 text-end">{tr('Four-Eyes Action', 'إجراء المراجعة')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0] text-xs bg-white">
                  {flaggedWithdrawals.map((tx) => {
                    const wdReq = withdrawalRequestByTxId.get(tx.id);
                    const reqState = wdReq?.state ?? 'review';
                    const hasOnChainEvidence =
                      Boolean(tx.tx_hash) ||
                      tx.status === 'completed' ||
                      Boolean(wdReq?.broadcast_at) ||
                      reqState === 'broadcast' ||
                      reqState === 'confirmed';
                    const canApprove = reqState === 'review' && !hasOnChainEvidence;
                    const canReject =
                      (reqState === 'review' || reqState === 'approved') && !hasOnChainEvidence;
                    return (
                      <tr key={tx.id} className="hover:bg-[#F8FAFC]">
                        <td className="py-3 px-4 font-mono tabular-nums text-[#0F172A] font-medium whitespace-nowrap">
                          {tx.reference}
                        </td>
                        <td className="py-3 px-3 font-mono tabular-nums text-[#1E40AF] font-medium whitespace-nowrap">
                          {resolveTerminalCode(terminals, tx.terminalUuid)}
                        </td>
                        <td className="py-3 px-3 font-mono tabular-nums text-slate-600 max-w-xs truncate">
                          {tx.counterparty_terminal}
                        </td>
                        <td className="py-3 px-3 font-mono tabular-nums text-end text-[#0F172A] font-semibold whitespace-nowrap">
                          {formatAssetAmount(tx.amount, tx.asset)} {tx.asset}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          <span
                            className={`font-semibold px-2 py-0.5 rounded text-[11px] border ${
                              tx.risk_score === 'High'
                                ? 'bg-red-50 text-red-700 border-red-200'
                                : 'bg-amber-50 text-amber-800 border-amber-200'
                            }`}
                          >
                            {tx.risk_score ?? 'Medium'} Risk
                          </span>
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          <span
                            className={`font-mono text-[11px] uppercase font-semibold ${
                              reqState === 'approved'
                                ? 'text-[#1E40AF]'
                                : reqState === 'broadcast'
                                  ? 'text-emerald-700'
                                  : 'text-amber-700'
                            }`}
                          >
                            {reqState === 'approved'
                              ? 'approved · awaiting worker'
                              : reqState === 'broadcast'
                                ? 'broadcasted on-chain'
                                : reqState}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-end whitespace-nowrap">
                          <div className="inline-flex items-center gap-2">
                            {canApprove && (
                              <button
                                type="button"
                                disabled={reviewingTxId === tx.id}
                                onClick={() => handleReviewAction(tx, 'approve')}
                                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] disabled:opacity-50 rounded-md"
                              >
                                <Check className="w-3.5 h-3.5" />
                                {reviewingTxId === tx.id
                                  ? tr('Processing...', 'جاري التنفيذ...')
                                  : tr('Approve', 'اعتماد')}
                              </button>
                            )}
                            {canReject && (
                              <button
                                type="button"
                                disabled={reviewingTxId === tx.id}
                                onClick={() => handleReviewAction(tx, 'reject')}
                                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-md"
                              >
                                <XCircle className="w-3.5 h-3.5" />
                                {tr('Reject', 'رفض')}
                              </button>
                            )}
                            {!canApprove && !canReject && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-mono text-amber-800">
                                <ShieldAlert className="w-3.5 h-3.5 text-amber-700" />
                                {tr('Manual reconciliation required', 'يتطلب مطابقة يدوية')}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab 3: KYC / KYB Compliance Queue */}
      {adminTab === 'kyc' && (
        <div className="space-y-4">
          {!canReviewKyc && (
            <div className="rounded-xl px-4 py-3 bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 text-amber-700 shrink-0" />
              <span>
                KYC/KYB compliance decisions and document previews require an active{' '}
                <code className="font-mono font-semibold text-[#0F172A]">compliance</code> or{' '}
                <code className="font-mono font-semibold text-[#0F172A]">super_admin</code> role in{' '}
                <code className="font-mono font-semibold text-[#0F172A]">public.app_admins</code>.
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Queue List */}
            <div className="lg:col-span-5 bg-white border border-[#E2E8F0] rounded-xl p-5 space-y-4 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-[#0F172A] flex items-center gap-2">
                  <UserCheck className="w-4 h-4 text-[#1E40AF]" />
                  {tr('Verification Queue', 'قائمة طلبات التوثيق')}
                </h3>
                <div className="flex items-center gap-1 p-0.5 bg-[#F4F7FA] border border-[#E2E8F0] rounded-lg">
                  {(
                    [
                      { id: 'all', label: tr('All', 'الكل') },
                      { id: 'pending_review', label: tr('Pending', 'معلق') },
                      { id: 'approved', label: tr('Approved', 'معتمد') },
                      { id: 'rejected', label: tr('Rejected', 'مرفوض') },
                    ] as const
                  ).map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setKycFilter(f.id)}
                      className={`px-2 py-1 text-[11px] font-semibold rounded transition-colors whitespace-nowrap ${
                        kycFilter === f.id
                          ? 'bg-[#1E40AF] text-white'
                          : 'text-slate-600 hover:text-[#0F172A]'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute start-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={kycSearch}
                  onChange={(e) => setKycSearch(e.target.value)}
                  placeholder={tr('Search legal name, country, or type...', 'ابحث بالاسم القانوني أو الدولة...')}
                  className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg ps-9 pe-3 py-2 text-xs text-[#0F172A] placeholder:text-slate-400 focus:outline-none"
                />
              </div>

              <div className="divide-y divide-[#E2E8F0] max-h-[520px] overflow-y-auto">
                {filteredKycQueue.length === 0 ? (
                  <div className="py-12 text-center space-y-2">
                    <CheckCircle2 className="w-7 h-7 text-emerald-600 mx-auto" />
                    <p className="text-xs text-slate-500">
                      {tr('No KYC / KYB submissions match this filter.', 'لا توجد طلبات توثيق تطابق التصفية.')}
                    </p>
                  </div>
                ) : (
                  filteredKycQueue.map((item) => {
                    const isSelected = selectedKycSubmission?.id === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setSelectedKycId(item.id);
                          setKycError(null);
                        }}
                        className={`w-full text-start p-3.5 rounded-lg transition-colors flex items-start justify-between gap-3 ${
                          isSelected
                            ? 'bg-blue-50/80 border-s-2 border-s-[#1E40AF]'
                            : 'hover:bg-[#F8FAFC]'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-[#0F172A] truncate">
                            {item.full_legal_name}
                          </div>
                          <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-2">
                            <span className="font-mono uppercase font-semibold text-[#1E40AF]">
                              {item.account_type === 'corporate' ? 'KYB' : 'KYC'}
                            </span>
                            <span>·</span>
                            <span>{item.country_of_residence}</span>
                          </div>
                        </div>
                        <span
                          className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded uppercase border shrink-0 ${
                            item.status === 'approved'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : item.status === 'rejected'
                                ? 'bg-red-50 text-red-700 border-red-200'
                                : 'bg-amber-50 text-amber-800 border-amber-200'
                          }`}
                        >
                          {item.status.replace('_', ' ')}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Applicant Dossier Inspector */}
            <div className="lg:col-span-7 bg-white border border-[#E2E8F0] rounded-xl p-6 space-y-6 shadow-xs">
              {selectedKycSubmission ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#E2E8F0] pb-4">
                    <div>
                      <div className="flex items-center gap-2.5">
                        <h3 className="text-base font-semibold text-[#0F172A]">
                          {selectedKycSubmission.full_legal_name}
                        </h3>
                        <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded bg-blue-50 border border-blue-200 text-[#1E40AF] uppercase">
                          {selectedKycSubmission.account_type === 'corporate'
                            ? 'Corporate KYB'
                            : 'Individual KYC'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 font-mono tabular-nums mt-1">
                        {tr('Submitted', 'أُرسل في')} {formatTimestamp(selectedKycSubmission.updated_at)}
                      </p>
                    </div>
                    <span
                      className={`px-3 py-1 rounded-md text-xs font-semibold capitalize border ${
                        selectedKycSubmission.status === 'approved'
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : selectedKycSubmission.status === 'rejected'
                            ? 'bg-red-50 text-red-700 border-red-200'
                            : 'bg-amber-50 text-amber-800 border-amber-200'
                      }`}
                    >
                      {selectedKycSubmission.status.replace('_', ' ')}
                    </span>
                  </div>

                  {/* Metadata Dossier */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-3">
                      <div className="text-slate-500">{tr('Date of Birth / Incorporation', 'تاريخ الميلاد / التأسيس')}</div>
                      <div className="font-mono tabular-nums text-[#0F172A] font-medium mt-1">
                        {selectedKycSubmission.date_of_birth || 'Not provided (Corporate KYB)'}
                      </div>
                    </div>
                    <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-3">
                      <div className="text-slate-500">{tr('Nationality / Residence', 'الجنسية / الإقامة')}</div>
                      <div className="text-[#0F172A] font-medium mt-1">
                        {selectedKycSubmission.nationality} ·{' '}
                        {selectedKycSubmission.country_of_residence}
                      </div>
                    </div>
                    <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-3">
                      <div className="text-slate-500">{tr('Identity Document', 'وثيقة الهوية')}</div>
                      <div className="font-mono tabular-nums text-[#0F172A] font-medium mt-1">
                        {selectedKycSubmission.id_type.replace('_', ' ').toUpperCase()} ·{' '}
                        {selectedKycSubmission.id_number}
                      </div>
                    </div>
                    <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-3">
                      <div className="text-slate-500">{tr('Phone & Registration', 'الهاتف والتسجيل')}</div>
                      <div className="font-mono tabular-nums text-[#0F172A] font-medium mt-1">
                        {selectedKycSubmission.phone_number}
                        {selectedKycSubmission.tax_or_reg_number
                          ? ` · Tax/Reg ${selectedKycSubmission.tax_or_reg_number}`
                          : ''}
                      </div>
                    </div>
                    <div className="sm:col-span-2 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-3">
                      <div className="text-slate-500">{tr('Registered Address', 'العنوان المسجل')}</div>
                      <div className="text-[#0F172A] font-medium mt-1">{selectedKycSubmission.address_line}</div>
                    </div>
                  </div>

                  {selectedKycSubmission.status === 'rejected' &&
                    selectedKycSubmission.rejection_reason && (
                      <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                        <strong className="font-semibold">{tr('Previous Rejection Note:', 'ملاحظة الرفض السابقة:')}</strong>{' '}
                        {selectedKycSubmission.rejection_reason}
                      </div>
                    )}

                  {/* Document Preview Vault */}
                  <div className="space-y-3 pt-2 border-t border-[#E2E8F0]">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-[#0F172A] flex items-center gap-2">
                        <FileText className="w-3.5 h-3.5 text-[#1E40AF]" />
                        {tr('Encrypted Storage Vault (120s Signed URL)', 'خزنة المستندات المشفرة (رابط مؤقت 120ث)')}
                      </h4>
                      <span className="text-[11px] font-mono text-slate-500">
                        Bucket: kyc-documents
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {[
                        {
                          label: tr('ID Front / Certificate', 'الوجه الأمامي / الشهادة'),
                          path: selectedKycSubmission.id_front_path,
                        },
                        {
                          label: tr('ID Back / UBO Addendum', 'الوجه الخلفي / الملحق'),
                          path: selectedKycSubmission.id_back_path,
                        },
                        {
                          label: tr('Liveness / Signatory Selfie', 'صورة المفوض بالتوقيع'),
                          path: selectedKycSubmission.selfie_path,
                        },
                        {
                          label: tr('Proof of Address', 'إثبات العنوان'),
                          path: selectedKycSubmission.proof_of_address_path,
                        },
                      ].map((doc) => (
                        <button
                          key={doc.label}
                          type="button"
                          disabled={!doc.path || !canReviewKyc || docPreviewLoading === doc.label}
                          onClick={() => handleOpenKycDocument(doc.path, doc.label)}
                          className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-[#F8FAFC] border border-[#E2E8F0] hover:border-[#1E40AF] disabled:opacity-45 rounded-lg text-xs text-[#0F172A] transition-colors"
                        >
                          <span className="truncate font-medium">{doc.label}</span>
                          <span className="inline-flex items-center gap-1 text-[#1E40AF] font-mono font-semibold text-[11px] shrink-0">
                            <Eye className="w-3.5 h-3.5" />
                            {!doc.path
                              ? tr('Not provided', 'غير متوفر')
                              : docPreviewLoading === doc.label
                                ? tr('Signing...', 'جاري التوقيع...')
                                : tr('Inspect', 'فحص')}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Compliance Decision Controls */}
                  <div className="space-y-4 pt-4 border-t border-[#E2E8F0]">
                    <div className="space-y-2">
                      <label htmlFor="admin-kyc-reason" className="text-xs font-medium text-slate-600">
                        {tr(
                          'Compliance Note / Rejection Reason (mandatory when rejecting)',
                          'ملاحظة الامتثال / سبب الرفض (إلزامي عند الرفض)'
                        )}
                      </label>
                      <input
                        id="admin-kyc-reason"
                        type="text"
                        value={kycReason}
                        onChange={(e) => {
                          setKycReason(e.target.value);
                          if (kycError) setKycError(null);
                        }}
                        placeholder="e.g. Verified passport & proof of address · or Blurry ID front image"
                        className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2 text-xs text-[#0F172A] placeholder:text-slate-400 focus:outline-none"
                      />
                    </div>

                    {kycError && (
                      <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
                        <span>{kycError}</span>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        disabled={
                          !canReviewKyc ||
                          !onReviewKyc ||
                          reviewingKycId === selectedKycSubmission.id ||
                          selectedKycSubmission.status === 'approved'
                        }
                        onClick={() => handleKycDecision(selectedKycSubmission, 'approved')}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] disabled:opacity-45 rounded-lg whitespace-nowrap shadow-xs"
                      >
                        <Check className="w-3.5 h-3.5" />
                        {reviewingKycId === selectedKycSubmission.id
                          ? tr('Saving...', 'جاري الحفظ...')
                          : selectedKycSubmission.status === 'approved'
                            ? tr('Already Approved', 'معتمد بالفعل')
                            : tr('Approve KYC / KYB', 'اعتماد التوثيق')}
                      </button>
                      <button
                        type="button"
                        disabled={
                          !canReviewKyc ||
                          !onReviewKyc ||
                          reviewingKycId === selectedKycSubmission.id
                        }
                        onClick={() => handleKycDecision(selectedKycSubmission, 'rejected')}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-45 rounded-lg whitespace-nowrap"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        {tr('Reject Application', 'رفض الطلب')}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="py-16 text-center text-xs text-slate-500">
                  {tr(
                    'Select a KYC / KYB application from the queue to inspect identity documents and compliance status.',
                    'اختر طلباً من القائمة لفحص مستندات الهوية وحالة الامتثال.'
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Document Signed URL Preview Modal */}
      {docPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#0F172A]/70 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="kyc-doc-preview-title"
            className="w-full max-w-3xl bg-white border border-[#E2E8F0] rounded-xl overflow-hidden flex flex-col max-h-[88vh] shadow-2xl"
          >
            <div className="cobalt-hero-surface px-5 py-3.5 border-b border-[#24489B] flex items-center justify-between gap-4 text-white">
              <div>
                <h4 id="kyc-doc-preview-title" className="text-sm font-semibold text-white">
                  {docPreview.label}
                </h4>
                <p className="text-[11px] font-mono text-blue-100/85 mt-0.5">
                  Temporary short-lived document stream ({docPreview.mimeType})
                </p>
              </div>
              <div className="flex items-center gap-2">
                {!docPreview.url.startsWith('data:') && (
                  <a
                    href={docPreview.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg whitespace-nowrap"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    {tr('Open Tab', 'فتح في تبويب')}
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => setDocPreview(null)}
                  className="p-1.5 text-blue-100 hover:text-white rounded-md"
                  aria-label="Close document preview"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="p-4 bg-[#F4F7FA] overflow-auto flex-1 flex items-center justify-center">
              {docPreview.mimeType === 'application/pdf' ? (
                <iframe
                  src={docPreview.url}
                  title={docPreview.label}
                  className="w-full h-[65vh] rounded border border-[#E2E8F0] bg-white"
                />
              ) : (
                <img
                  src={docPreview.url}
                  alt={docPreview.label}
                  className="max-w-full max-h-[65vh] object-contain rounded border border-[#E2E8F0] bg-white"
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab 4: Treasury & Reconciliation Monitor */}
      {adminTab === 'treasury' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="bg-white border border-[#E2E8F0] rounded-xl p-5 space-y-2 shadow-xs">
              <span className="text-xs font-medium text-slate-500">
                {tr('Hot Wallet (Instant Settlement)', 'المحفظة الساخنة (التسوية الفورية)')}
              </span>
              <div className="font-mono tabular-nums text-2xl font-bold text-[#1E40AF]">
                {formatUsd(hotWalletUsd)}
              </div>
              <p className="text-[11px] text-slate-500">3.5% of total liquidity</p>
            </div>
            <div className="bg-white border border-[#E2E8F0] rounded-xl p-5 space-y-2 shadow-xs">
              <span className="text-xs font-medium text-slate-500">
                {tr('Warm MPC Vault (Rebalancing)', 'خزنة MPC الدافئة (إعادة الموازنة)')}
              </span>
              <div className="font-mono tabular-nums text-2xl font-bold text-[#0F172A]">
                {formatUsd(warmMpcUsd)}
              </div>
              <p className="text-[11px] text-slate-500">31.5% of total liquidity</p>
            </div>
            <div className="bg-white border border-[#E2E8F0] rounded-xl p-5 space-y-2 shadow-xs">
              <span className="text-xs font-medium text-slate-500">
                {tr('Cold Storage (Multisig Custody)', 'التخزين البارد (حفظ متعدد التواقيع)')}
              </span>
              <div className="font-mono tabular-nums text-2xl font-bold text-emerald-700">
                {formatUsd(coldStorageUsd)}
              </div>
              <p className="text-[11px] text-slate-500">65.0% of total liquidity</p>
            </div>
          </div>

          <div className="bg-white border border-[#E2E8F0] rounded-xl p-6 flex flex-wrap items-center justify-between gap-6 shadow-xs">
            <div>
              <h3 className="text-sm font-semibold text-[#0F172A]">
                {tr('Double-Entry Ledger Invariant Reconciliation', 'مطابقة ثابت القيد المزدوج للدفتر')}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {tr(
                  'Verifies mathematically that SUM(amount) = 0 across every journal entry and asset.',
                  'يتحقق رياضياً من أن مجموع القيود يساوي صفراً عبر كل قيد يومية وأصل.'
                )}
              </p>
            </div>

            <button
              type="button"
              disabled={reconciling}
              onClick={runReconciliationCheck}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] disabled:opacity-50 rounded-lg transition-colors shadow-xs"
            >
              <RefreshCcw className={`w-3.5 h-3.5 ${reconciling ? 'animate-spin' : ''}`} />
              {reconciling
                ? tr('Verifying Invariants...', 'جاري التحقق...')
                : tr('Run Ledger Reconciliation', 'تشغيل مطابقة الدفتر')}
            </button>
          </div>

          {reconciledResult && (
            <div
              className={`rounded-xl p-5 flex items-center gap-3 border shadow-xs ${
                reconciledResult.ok
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-red-50 border-red-200 text-red-800'
              }`}
            >
              {reconciledResult.ok ? (
                <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-700" />
              ) : (
                <XCircle className="w-5 h-5 shrink-0 text-red-700" />
              )}
              <div>
                <p className="text-sm font-semibold">
                  {reconciledResult.ok
                    ? tr('Ledger Invariant Verified', 'تم التحقق من توازن الدفتر')
                    : tr('Ledger Imbalance Detected', 'تم اكتشاف عدم توازن')}
                </p>
                <p className="text-xs text-slate-700 mt-0.5 font-mono tabular-nums">
                  Checked {reconciledResult.postingCount} signed double-entry postings across{' '}
                  {reconciledResult.journalCount} journal asset groups.{' '}
                  {reconciledResult.ok ? 'SUM(amount) = 0 verified with zero discrepancies.' : 'Discrepancy found.'}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 5: Hash-Chain Audit Logs */}
      {adminTab === 'audit' && (
        <div className="bg-white border border-[#E2E8F0] rounded-xl overflow-hidden shadow-xs">
          <div className="px-5 py-4 border-b border-[#E2E8F0]">
            <h3 className="text-sm font-semibold text-[#0F172A]">
              {tr('Immutable Hash-Chained Compliance Audit Trail', 'سجل تدقيق الامتثال غير القابل للتعديل')}
            </h3>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-[#E2E8F0] text-[11px] font-semibold text-[#0F172A] bg-[#F8FAFC]">
                  <th className="py-2.5 px-4 text-start">{tr('Event Type', 'نوع الحدث')}</th>
                  <th className="py-2.5 px-3 text-start">{tr('Timestamp', 'الوقت')}</th>
                  <th className="py-2.5 px-3 text-start">{tr('Actor', 'المنفذ')}</th>
                  <th className="py-2.5 px-3 text-start">{tr('Details', 'التفاصيل')}</th>
                  <th className="py-2.5 px-4 font-mono text-end">{tr('Row Hash', 'تجزئة السجل')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0] text-xs bg-white">
                {auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-[#F8FAFC]">
                    <td className="py-3 px-4 font-mono font-semibold text-[#1E40AF] whitespace-nowrap">
                      {log.event_type}
                    </td>
                    <td className="py-3 px-3 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {formatTimestamp(log.created_at)}
                    </td>
                    <td className="py-3 px-3 text-[#0F172A] font-medium whitespace-nowrap">{log.actor}</td>
                    <td className="py-3 px-3 text-slate-700 max-w-sm truncate">{log.details}</td>
                    <td className="py-3 px-4 font-mono tabular-nums text-end text-slate-500 truncate max-w-xs">
                      {log.row_hash}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
