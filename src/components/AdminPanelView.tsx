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
} from 'lucide-react';
import type {
  AdminProfile,
  AssetRateMap,
  AssetSymbol,
  AuditLogRecord,
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
  getTerminalAssetTotal,
  resolveTerminalCode,
  verifyLedgerInvariant,
  type LedgerRuntimeMode,
} from '../lib/ledgerEngine';
import { formatAssetAmount, formatTimestamp, formatUsd } from '../lib/format';

interface AdminPanelViewProps {
  terminals: TerminalRecord[];
  wallets: WalletBalance[];
  transactions: TransactionRecord[];
  ledgerPostings: LedgerPosting[];
  auditLogs: AuditLogRecord[];
  withdrawalRequests?: WithdrawalRequestRecord[];
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
  onToast: (title: string, description?: string, variant?: 'success' | 'error' | 'info') => void;
}

export function AdminPanelView({
  terminals,
  wallets,
  transactions,
  ledgerPostings,
  auditLogs,
  withdrawalRequests = [],
  assetRates = ASSET_USD_RATES,
  authMode = 'local_demo',
  adminProfile,
  onVerifyLedgerInvariant,
  onUpdateTerminalStatus,
  onReviewWithdrawal,
  onToast,
}: AdminPanelViewProps) {
  const [adminTab, setAdminTab] = useState<'explorer' | 'withdrawals' | 'treasury' | 'audit'>('explorer');

  // Terminal Explorer state
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTermUuid, setSelectedTermUuid] = useState(terminals[0]?.id ?? '');
  const [statusReason, setStatusReason] = useState('');
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);

  // Withdrawal Review state
  const [reviewReason, setReviewReason] = useState('');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewingTxId, setReviewingTxId] = useState<string | null>(null);

  // Reconciliation state
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
  // Institutional treasury tier splits
  const hotWalletUsd = totalPortfolio * 0.035; // 3.5%
  const warmMpcUsd = totalPortfolio * 0.315;   // 31.5%
  const coldStorageUsd = totalPortfolio * 0.65; // 65.0%

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

  const handleStatusChange = async (newStatus: 'active' | 'suspended' | 'locked' | 'restricted') => {
    if (!selectedTerminal) return;
    setStatusError(null);
    if (!statusReason.trim()) {
      const msg = 'Provide a mandatory compliance note for terminal status change.';
      setStatusError(msg);
      onToast('Audit reason required', msg, 'error');
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
      onToast('Terminal status updated', `${selectedTerminal.terminalId} set to ${newStatus}`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to update terminal status';
      setStatusError(msg);
      onToast('Admin action blocked', msg, 'error');
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
      onToast('Review reason required', msg, 'error');
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
            ? 'Withdrawal approved for TRON worker'
            : 'Withdrawal approved',
          tx.reference,
          'success'
        );
      } else {
        onToast('Withdrawal rejected & refunded', tx.reference, 'info');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to review withdrawal request';
      setReviewError(msg);
      onToast('Withdrawal review blocked', msg, 'error');
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
          'Ledger Reconciliation Passed',
          `SUM(amount) = 0 across ${result.journalCount} journal groups (${result.postingCount} postings). Zero discrepancies.`,
          'success'
        );
      } else {
        onToast(
          'Reconciliation Discrepancy Detected',
          `${result.imbalancedCount} journal entries failed SUM(amount) = 0 invariant.`,
          'error'
        );
      }
    } catch (err) {
      onToast(
        'Reconciliation Failed',
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
      <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-center">
            <ShieldAlert className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Institutional Admin & Compliance Panel
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Terminal security controls, four-eyes withdrawal review, and zero-sum double-entry reconciliation
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#05070A] border border-white/[0.08] rounded-lg">
          {(
            [
              { id: 'explorer', label: 'Terminal Explorer' },
              { id: 'withdrawals', label: `Withdrawal Queue (${flaggedWithdrawals.length})` },
              { id: 'treasury', label: 'Treasury & Recon' },
              { id: 'audit', label: 'Hash-Chain Audit' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setAdminTab(tab.id)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                adminTab === tab.id
                  ? 'bg-[#00E5FF] text-[#05070A]'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* RBAC Session Role Status */}
      <div
        className={`rounded-xl px-5 py-3.5 border flex flex-wrap items-center justify-between gap-3 text-xs ${
          authMode === 'local_demo'
            ? 'bg-amber-500/10 border-amber-500/25 text-amber-200'
            : canExecuteAdminActions
              ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
              : 'bg-red-500/10 border-red-500/30 text-red-200'
        }`}
      >
        <div className="flex items-center gap-2.5">
          {authMode === 'local_demo' ? (
            <ShieldAlert className="w-4 h-4 text-[#F5C542] shrink-0" />
          ) : canExecuteAdminActions ? (
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          )}
          <div>
            {authMode === 'local_demo' ? (
              <span>
                <strong className="font-semibold">Local Demo RBAC Override:</strong> Operating as
                simulated <code className="font-mono text-[#F5C542]">super_admin</code> on local
                sandbox data.
              </span>
            ) : canExecuteAdminActions ? (
              <span>
                <strong className="font-semibold">Verified Admin RBAC Session:</strong> Active role{' '}
                <code className="font-mono text-white">{adminProfile?.role}</code> in{' '}
                <code className="font-mono text-white">public.app_admins</code>.
              </span>
            ) : (
              <span>
                <strong className="font-semibold">Unauthorized for Admin Mutations:</strong>{' '}
                {adminProfile?.role
                  ? `Role "${adminProfile.role}" is read-only for freezes and withdrawal approvals.`
                  : 'No active admin role found in public.app_admins.'}{' '}
                PostgreSQL RBAC requires an active{' '}
                <code className="font-mono text-white">ops</code>,{' '}
                <code className="font-mono text-white">compliance</code>, or{' '}
                <code className="font-mono text-white">super_admin</code> assignment.
              </span>
            )}
          </div>
        </div>
        <span className="font-mono text-[11px] uppercase tracking-wider opacity-90">
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
          <div className="lg:col-span-5 bg-[#0B0F16] border border-white/[0.08] rounded-xl p-5 space-y-4">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search terminal ID or label..."
                className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg pl-9 pr-3 py-2 text-xs font-mono text-slate-100 focus:outline-none"
              />
            </div>

            <div className="divide-y divide-white/[0.06] max-h-[500px] overflow-y-auto">
              {filteredTerminals.map((t) => {
                const isSelected = t.id === selectedTermUuid;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedTermUuid(t.id)}
                    className={`w-full text-left p-3.5 rounded-lg transition-colors flex items-center justify-between gap-3 ${
                      isSelected ? 'bg-white/[0.08]' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-100 truncate">{t.label}</span>
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.2 rounded uppercase ${
                            t.status === 'active'
                              ? 'bg-emerald-500/10 text-emerald-400'
                              : 'bg-red-500/10 text-red-400'
                          }`}
                        >
                          {t.status}
                        </span>
                      </div>
                      <p className="font-mono text-xs text-[#00E5FF] mt-1">{t.terminalId}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="lg:col-span-7 bg-[#0B0F16] border border-white/[0.08] rounded-xl p-6 space-y-6">
            {selectedTerminal ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.07] pb-4">
                  <div>
                    <h3 className="text-base font-semibold text-slate-100">
                      {selectedTerminal.label}
                    </h3>
                    <p className="font-mono text-xs text-[#00E5FF] mt-0.5">
                      {selectedTerminal.terminalId}
                    </p>
                  </div>
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-semibold capitalize ${
                      selectedTerminal.status === 'active'
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : 'bg-red-500/10 text-red-400 border border-red-500/20'
                    }`}
                  >
                    Status: {selectedTerminal.status}
                  </span>
                </div>

                {/* Wallets */}
                <div className="space-y-3">
                  <h4 className="text-xs font-semibold text-slate-300">Asset Balances</h4>
                  <div className="grid grid-cols-3 gap-3">
                    {(['USDT', 'BTC', 'ETH'] as AssetSymbol[]).map((sym) => {
                      const bal = getTerminalAssetTotal(wallets, selectedTerminal.id, sym);
                      return (
                        <div key={sym} className="bg-[#05070A] border border-white/[0.06] rounded-lg p-3">
                          <span className="font-mono text-xs font-bold text-slate-400">{sym}</span>
                          <div className="font-mono tabular-nums text-sm text-slate-100 font-semibold mt-1">
                            {formatAssetAmount(bal.available, sym)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Admin Status Controls */}
                <div className="space-y-4 pt-4 border-t border-white/[0.07]">
                  <h4 className="text-xs font-semibold text-slate-300">Compliance Security Actions</h4>

                  <div className="space-y-2">
                    <label htmlFor="admin-status-reason" className="text-xs text-slate-400">
                      Mandatory Audit Reason / Case Number
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
                      className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2 text-xs text-slate-100 focus:outline-none"
                    />
                  </div>

                  {statusError && (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
                      <span>{statusError}</span>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-3">
                    {selectedTerminal.status !== 'active' ? (
                      <button
                        type="button"
                        disabled={isUpdatingStatus}
                        onClick={() => handleStatusChange('active')}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-[#05070A] bg-emerald-400 hover:bg-emerald-300 rounded-lg"
                      >
                        <Unlock className="w-3.5 h-3.5" />
                        Unfreeze & Restore Active
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={isUpdatingStatus}
                          onClick={() => handleStatusChange('suspended')}
                          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded-lg"
                        >
                          <Lock className="w-3.5 h-3.5" />
                          Suspend Terminal
                        </button>
                        <button
                          type="button"
                          disabled={isUpdatingStatus}
                          onClick={() => handleStatusChange('locked')}
                          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-500 rounded-lg"
                        >
                          <Lock className="w-3.5 h-3.5" />
                          Emergency Lock
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* Tab 2: Withdrawal Review Queue */}
      {adminTab === 'withdrawals' && (
        <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/[0.08] space-y-3">
            <h3 className="text-sm font-semibold text-slate-100">
              Pending & Flagged Withdrawals (Four-Eyes Review)
            </h3>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <label htmlFor="admin-review-reason" className="text-xs text-slate-400 whitespace-nowrap">
                Mandatory Review Reason:
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
                className="flex-1 bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2 text-xs text-slate-100 focus:outline-none"
              />
            </div>
            {reviewError && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
                <span>{reviewError}</span>
              </div>
            )}
          </div>

          {flaggedWithdrawals.length === 0 ? (
            <div className="py-16 text-center space-y-2">
              <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto" />
              <p className="text-sm text-slate-300">No pending or flagged withdrawals in queue.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/[0.08] text-[11px] font-medium text-slate-400 bg-[#05070A]/60">
                    <th className="py-2.5 px-4">Reference</th>
                    <th className="py-2.5 px-3">Terminal ID</th>
                    <th className="py-2.5 px-3">Destination</th>
                    <th className="py-2.5 px-3 text-right">Amount</th>
                    <th className="py-2.5 px-3">Risk Score</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-4 text-right">Four-Eyes Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05] text-xs">
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
                      <tr key={tx.id} className="hover:bg-white/[0.025]">
                        <td className="py-3 px-4 font-mono text-slate-200 whitespace-nowrap">{tx.reference}</td>
                        <td className="py-3 px-3 font-mono text-[#00E5FF] whitespace-nowrap">
                          {resolveTerminalCode(terminals, tx.terminalUuid)}
                        </td>
                        <td className="py-3 px-3 font-mono text-slate-400 max-w-xs truncate">{tx.counterparty_terminal}</td>
                        <td className="py-3 px-3 font-mono tabular-nums text-right text-slate-100 font-medium whitespace-nowrap">
                          {formatAssetAmount(tx.amount, tx.asset)} {tx.asset}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          <span
                            className={`font-semibold px-2 py-0.5 rounded text-[11px] ${
                              tx.risk_score === 'High'
                                ? 'bg-red-500/15 text-red-400 border border-red-500/30'
                                : 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                            }`}
                          >
                            {tx.risk_score ?? 'Medium'} Risk
                          </span>
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          <span
                            className={`font-mono text-[11px] uppercase ${
                              reqState === 'approved'
                                ? 'text-[#00E5FF]'
                                : reqState === 'broadcast'
                                  ? 'text-emerald-400'
                                  : 'text-amber-400'
                            }`}
                          >
                            {reqState === 'approved'
                              ? 'approved · awaiting worker'
                              : reqState === 'broadcast'
                                ? 'broadcasted on-chain'
                                : reqState}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap space-x-2">
                          {canApprove && (
                            <button
                              type="button"
                              disabled={reviewingTxId === tx.id}
                              onClick={() => handleReviewAction(tx, 'approve')}
                              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-[#05070A] bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 rounded-md"
                            >
                              <Check className="w-3.5 h-3.5" />
                              {reviewingTxId === tx.id ? 'Processing...' : 'Approve'}
                            </button>
                          )}
                          {canReject && (
                            <button
                              type="button"
                              disabled={reviewingTxId === tx.id}
                              onClick={() => handleReviewAction(tx, 'reject')}
                              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded-md"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              Reject
                            </button>
                          )}
                          {!canApprove && !canReject && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-mono text-amber-300">
                              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                              Manual reconciliation required
                            </span>
                          )}
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

      {/* Tab 3: Treasury & Reconciliation Monitor */}
      {adminTab === 'treasury' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl p-5 space-y-2">
              <span className="text-xs text-slate-400">Hot Wallet (Instant Settlement)</span>
              <div className="font-mono tabular-nums text-2xl font-bold text-[#00E5FF]">
                {formatUsd(hotWalletUsd)}
              </div>
              <p className="text-[11px] text-slate-500">3.5% of total liquidity</p>
            </div>
            <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl p-5 space-y-2">
              <span className="text-xs text-slate-400">Warm MPC Vault (Rebalancing)</span>
              <div className="font-mono tabular-nums text-2xl font-bold text-[#F5C542]">
                {formatUsd(warmMpcUsd)}
              </div>
              <p className="text-[11px] text-slate-500">31.5% of total liquidity</p>
            </div>
            <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl p-5 space-y-2">
              <span className="text-xs text-slate-400">Cold Storage (Multisig Custody)</span>
              <div className="font-mono tabular-nums text-2xl font-bold text-emerald-400">
                {formatUsd(coldStorageUsd)}
              </div>
              <p className="text-[11px] text-slate-500">65.0% of total liquidity</p>
            </div>
          </div>

          <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl p-6 flex flex-wrap items-center justify-between gap-6">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Double-Entry Ledger Invariant Reconciliation
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Verifies mathematically that <code className="text-[#00E5FF]">SUM(amount) = 0</code> across every journal entry and asset.
              </p>
            </div>

            <button
              type="button"
              disabled={reconciling}
              onClick={runReconciliationCheck}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] disabled:opacity-50 rounded-lg transition-colors"
            >
              <RefreshCcw className={`w-3.5 h-3.5 ${reconciling ? 'animate-spin' : ''}`} />
              {reconciling ? 'Verifying Invariants...' : 'Run Ledger Reconciliation'}
            </button>
          </div>

          {reconciledResult && (
            <div
              className={`rounded-xl p-5 flex items-center gap-3 border ${
                reconciledResult.ok
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-red-500/10 border-red-500/30 text-red-400'
              }`}
            >
              {reconciledResult.ok ? (
                <CheckCircle2 className="w-5 h-5 shrink-0" />
              ) : (
                <XCircle className="w-5 h-5 shrink-0" />
              )}
              <div>
                <p className="text-sm font-semibold">
                  {reconciledResult.ok ? 'Ledger Invariant Verified' : 'Ledger Imbalance Detected'}
                </p>
                <p className="text-xs text-slate-300 mt-0.5">
                  Checked {reconciledResult.postingCount} signed double-entry postings across{' '}
                  {reconciledResult.journalCount} journal asset groups.{' '}
                  {reconciledResult.ok ? 'SUM(amount) = 0 verified with zero discrepancies.' : 'Discrepancy found.'}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 4: Hash-Chain Audit Logs */}
      {adminTab === 'audit' && (
        <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/[0.08]">
            <h3 className="text-sm font-semibold text-slate-100">
              Immutable Hash-Chained Compliance Audit Trail
            </h3>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/[0.08] text-[11px] font-medium text-slate-400 bg-[#05070A]/60">
                  <th className="py-2.5 px-4">Event Type</th>
                  <th className="py-2.5 px-3">Timestamp</th>
                  <th className="py-2.5 px-3">Actor</th>
                  <th className="py-2.5 px-3">Details</th>
                  <th className="py-2.5 px-4 font-mono text-right">Row Hash</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05] text-xs">
                {auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-white/[0.025]">
                    <td className="py-3 px-4 font-mono font-semibold text-[#00E5FF] whitespace-nowrap">
                      {log.event_type}
                    </td>
                    <td className="py-3 px-3 font-mono text-slate-400 whitespace-nowrap">
                      {formatTimestamp(log.created_at)}
                    </td>
                    <td className="py-3 px-3 text-slate-200 whitespace-nowrap">{log.actor}</td>
                    <td className="py-3 px-3 text-slate-300 max-w-sm truncate">{log.details}</td>
                    <td className="py-3 px-4 font-mono text-right text-slate-400 truncate max-w-xs">
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
