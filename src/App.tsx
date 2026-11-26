import { useState, useCallback } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ArrowDownUp,
  ArrowLeftRight,
  Database,
  FileSpreadsheet,
  FileText,
  GitBranch,
  Globe,
  LayoutDashboard,
  Lock,
  Menu,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  TrendingUp,
  UserCheck,
  ArrowRight,
  X,
} from 'lucide-react';
import type { ActiveView, AssetSymbol, ToastItem } from './types/ntps';
import { createUuid } from './lib/ledgerEngine';
import { useNtpsLedger } from './hooks/useNtpsLedger';
import { useSupabaseAuth } from './hooks/useSupabaseAuth';
import { DashboardView } from './components/DashboardView';
import { InternalTransferView } from './components/InternalTransferView';
import { DepositWithdrawView } from './components/DepositWithdrawView';
import { SubTerminalsView } from './components/SubTerminalsView';
import { LedgerAuditView } from './components/LedgerAuditView';
import { InvoicesView } from './components/InvoicesView';
import { TradingFundingView } from './components/TradingFundingView';
import { AdminPanelView } from './components/AdminPanelView';
import { KycVerificationView } from './components/KycVerificationView';
import { ToastContainer } from './components/ToastContainer';
import { TerminalQrModal } from './components/TerminalQrModal';
import { SchemaModal } from './components/SchemaModal';
import { AuthGateModal } from './components/AuthGateModal';
import { TwoFactorRuntimeProvider } from './context/TwoFactorContext';
import { LocaleProvider, useLocale } from './context/LocaleContext';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const NAV_ITEMS: {
  id: ActiveView;
  labelEn: string;
  labelAr: string;
  icon: typeof LayoutDashboard;
}[] = [
  { id: 'dashboard', labelEn: 'Overview & Wallets', labelAr: 'نظرة عامة والمحافظ', icon: LayoutDashboard },
  { id: 'kyc_verification', labelEn: 'KYC / KYB Verification', labelAr: 'توثيق الهوية والشركات', icon: UserCheck },
  { id: 'transfer', labelEn: 'Internal Transfer', labelAr: 'التحويل الداخلي', icon: ArrowLeftRight },
  { id: 'deposit_withdraw', labelEn: 'Deposit & Withdraw', labelAr: 'الإيداع والسحب', icon: ArrowDownUp },
  { id: 'sub_terminals', labelEn: 'Sub-Terminals & IDs', labelAr: 'المحطات الفرعية والمعرفات', icon: GitBranch },
  { id: 'invoices', labelEn: 'Invoices & QR Pay', labelAr: 'الفواتير والدفع بالرمز', icon: FileText },
  { id: 'trading_funding', labelEn: 'Trading Funding Bridge', labelAr: 'جسر تمويل التداول', icon: TrendingUp },
  { id: 'admin_panel', labelEn: 'Admin & Compliance', labelAr: 'الإدارة والامتثال', icon: ShieldAlert },
  { id: 'ledger', labelEn: 'Ledger Audit Log', labelAr: 'سجل تدقيق الدفتر', icon: FileSpreadsheet },
];

function NtpsWorkspace() {
  const [activeView, setActiveView] = useState<ActiveView>('dashboard');
  const [preselectedAsset, setPreselectedAsset] = useState<AssetSymbol>('USDT');
  const [dwInitialMode, setDwInitialMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [schemaModalOpen, setSchemaModalOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const { locale, toggleLocale, tr } = useLocale();
  const auth = useSupabaseAuth();

  const {
    ledgerQuery,
    adminProfileQuery,
    realtimeStatus,
    lastRealtimeSyncAt,
    ensureDepositAddressMutation,
    internalTransferMutation,
    depositMutation,
    withdrawalMutation,
    provisionSubMutation,
    updatePolicyMutation,
    addWhitelistMutation,
    createInvoiceMutation,
    payInvoiceMutation,
    tradingTransferMutation,
    adminUpdateStatusMutation,
    adminReviewWithdrawalMutation,
    submitKycMutation,
    adminReviewKycMutation,
    verifyInvariantMutation,
    resetLedgerMutation,
    recordSimulated2FaAuditMutation,
  } = useNtpsLedger(auth.effectiveUserId, auth.authMode);

  const addToast = useCallback(
    (title: string, description?: string, variant: ToastItem['variant'] = 'success') => {
      const id = `toast-${Date.now()}-${createUuid().slice(0, 8)}`;
      setToasts((prev) => [...prev.slice(-3), { id, title, description, variant }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4200);
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const handleCopy = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        addToast(label, text, 'success');
      } catch {
        addToast(tr('Copied to clipboard', 'تم النسخ إلى الحافظة'), text, 'info');
      }
    },
    [addToast, tr]
  );

  const handleNavigate = useCallback(
    (view: ActiveView, asset?: AssetSymbol, mode?: 'deposit' | 'withdraw') => {
      if (asset) setPreselectedAsset(asset);
      if (mode) setDwInitialMode(mode);
      setActiveView(view);
      setMobileNavOpen(false);
    },
    []
  );

  const currentNavItem = NAV_ITEMS.find((n) => n.id === activeView);
  const currentNavLabel = currentNavItem
    ? tr(currentNavItem.labelEn, currentNavItem.labelAr)
    : tr('Overview', 'نظرة عامة');
  const ledger = ledgerQuery.data;
  const masterTerminal = ledger?.terminals.find((t) => t.type === 'master') ?? ledger?.terminals[0];
  const subTerminals = ledger?.terminals.filter((t) => t.type === 'sub') ?? [];
  const kycSubmission = ledger?.kycSubmission ?? null;
  const kycStatus = kycSubmission?.status ?? 'unverified';

  const renderNavLinks = () =>
    NAV_ITEMS.map((item) => {
      const Icon = item.icon;
      const active = activeView === item.id;
      return (
        <button
          key={item.id}
          type="button"
          onClick={() => handleNavigate(item.id)}
          className={`relative w-full flex items-center gap-3 px-3.5 py-2.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap text-start ${
            active
              ? 'bg-[#24489B] text-white font-semibold shadow-sm'
              : 'text-blue-100/85 hover:text-white hover:bg-[#24489B]/70'
          }`}
        >
          {active && (
            <span
              className="absolute start-0 top-1.5 bottom-1.5 w-1 rounded-e bg-[#D6FF3D]"
              aria-hidden="true"
            />
          )}
          <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-[#D6FF3D]' : 'text-blue-200'}`} />
          <span>{tr(item.labelEn, item.labelAr)}</span>
        </button>
      );
    });

  return (
    <TwoFactorRuntimeProvider
      value={{
        authMode: auth.authMode,
        userEmail: auth.effectiveUserEmail,
        onRecordSimulatedAudit: async (payload) => {
          await recordSimulated2FaAuditMutation.mutateAsync(payload);
        },
      }}
    >
      <div className="min-h-screen bg-[#F4F7FA] text-[#0F172A] flex">
        {/* Desktop Sidebar — 60% Primary Cobalt Blue */}
        <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 bg-[#1E40AF] text-white border-e border-[#24489B]">
          <div className="h-16 px-6 flex items-center border-b border-white/15">
            <button
              type="button"
              onClick={() => handleNavigate('dashboard')}
              className="flex items-center gap-2.5 text-start whitespace-nowrap shrink-0"
            >
              <span className="w-7 h-7 rounded-lg bg-[#D6FF3D] flex items-center justify-center shadow-sm">
                <Terminal className="w-4 h-4 text-[#0F172A]" />
              </span>
              <span className="font-display text-base font-bold tracking-tight text-white">
                NOVA Terminal
              </span>
            </button>
          </div>

          <nav
            className="flex-1 px-3 py-5 space-y-1"
            aria-label={tr('Primary navigation', 'التنقل الرئيسي')}
          >
            {renderNavLinks()}
          </nav>

          <div className="p-3 border-t border-white/15 space-y-1.5">
            <button
              type="button"
              onClick={() => setAuthModalOpen(true)}
              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-start text-xs rounded-lg bg-[#24489B] border border-white/15 hover:border-white/30 transition-colors"
            >
              {auth.authMode === 'supabase' ? (
                <ShieldCheck className="w-4 h-4 text-[#D6FF3D] shrink-0" />
              ) : (
                <Lock className="w-4 h-4 text-[#D6FF3D] shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-white truncate">
                  {auth.authMode === 'supabase'
                    ? tr('Connected Supabase Session', 'جلسة Supabase متصلة')
                    : tr('Local Demo Mode', 'وضع العرض المحلي')}
                </div>
                <div className="font-mono text-[11px] text-blue-100/80 truncate">
                  {auth.effectiveUserEmail}
                </div>
              </div>
            </button>
            <button
              type="button"
              onClick={() => setSchemaModalOpen(true)}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-blue-100 hover:text-white hover:bg-[#24489B] rounded-lg transition-colors whitespace-nowrap text-start"
            >
              <Database className="w-3.5 h-3.5 text-[#D6FF3D]" />
              <span>{tr('Supabase SQL Schema', 'مخطط قاعدة بيانات SQL')}</span>
            </button>
            {auth.authMode === 'local_demo' && (
              <button
                type="button"
                onClick={async () => {
                  await resetLedgerMutation.mutateAsync();
                  addToast(
                    tr('Ledger state restored', 'تمت استعادة حالة الدفتر'),
                    tr('Reset to initial institutional balances', 'تمت إعادة الضبط للأرصدة المؤسسية الأولية'),
                    'info'
                  );
                }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-blue-100 hover:text-white hover:bg-[#24489B] rounded-lg transition-colors whitespace-nowrap text-start"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{tr('Reset Demo Ledger', 'إعادة ضبط دفتر العرض')}</span>
              </button>
            )}
          </div>
        </aside>

        {/* Mobile Navigation Drawer */}
        {mobileNavOpen && (
          <div className="fixed inset-0 z-40 lg:hidden flex">
            <div
              className="fixed inset-0 bg-[#0F172A]/60 backdrop-blur-[1px]"
              onClick={() => setMobileNavOpen(false)}
            />
            <aside className="relative z-50 w-64 max-w-[80vw] bg-[#1E40AF] text-white border-e border-[#24489B] flex flex-col">
              <div className="h-16 px-5 flex items-center justify-between border-b border-white/15">
                <span className="font-display text-base font-bold text-white">NOVA Terminal</span>
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(false)}
                  className="p-1.5 text-blue-100 hover:text-white"
                  aria-label={tr('Close navigation menu', 'إغلاق قائمة التنقل')}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
                {renderNavLinks()}
              </nav>
              <div className="p-3 border-t border-white/15 space-y-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setMobileNavOpen(false);
                    setAuthModalOpen(true);
                  }}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-start text-xs rounded-lg bg-[#24489B] border border-white/15 hover:border-white/30 transition-colors"
                >
                  {auth.authMode === 'supabase' ? (
                    <ShieldCheck className="w-4 h-4 text-[#D6FF3D] shrink-0" />
                  ) : (
                    <Lock className="w-4 h-4 text-[#D6FF3D] shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-white truncate">
                      {auth.authMode === 'supabase'
                        ? tr('Connected Supabase Session', 'جلسة Supabase متصلة')
                        : tr('Local Demo Mode', 'وضع العرض المحلي')}
                    </div>
                    <div className="font-mono text-[11px] text-blue-100/80 truncate">
                      {auth.effectiveUserEmail}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMobileNavOpen(false);
                    setSchemaModalOpen(true);
                  }}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-blue-100 hover:text-white hover:bg-[#24489B] rounded-lg text-start"
                >
                  <Database className="w-3.5 h-3.5 text-[#D6FF3D]" />
                  <span>{tr('Supabase SQL Schema', 'مخطط قاعدة بيانات SQL')}</span>
                </button>
              </div>
            </aside>
          </div>
        )}

        {/* Main Content Shell */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Top Navbar — Cobalt Blue #1E40AF */}
          <header className="h-16 px-4 sm:px-6 lg:px-8 border-b border-[#24489B] bg-[#1E40AF] text-white sticky top-0 z-30 flex items-center justify-between gap-4 sm:gap-8 shadow-sm">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                className="lg:hidden p-2 -ms-2 text-blue-100 hover:text-white rounded-lg"
                aria-label={tr('Open navigation menu', 'فتح قائمة التنقل')}
              >
                <Menu className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-2 text-xs sm:text-sm min-w-0 truncate">
                <span className="text-blue-200 hidden sm:inline whitespace-nowrap">
                  {tr('NTPS Workspace', 'مساحة عمل NTPS')}
                </span>
                <span className="text-blue-300/60 hidden sm:inline">/</span>
                <h1 className="font-display font-semibold text-white truncate">
                  {currentNavLabel}
                </h1>
              </div>
            </div>

            <div className="flex items-center gap-2.5 sm:gap-3.5 shrink-0">
              <button
                type="button"
                onClick={toggleLocale}
                title={tr('Switch to Arabic (RTL)', 'التبديل إلى الإنجليزية (LTR)')}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#24489B] hover:bg-white/15 border border-white/20 text-[11px] font-semibold text-white transition-colors whitespace-nowrap"
              >
                <Globe className="w-3.5 h-3.5 text-[#D6FF3D]" />
                <span>{locale === 'en' ? 'العربية' : 'EN'}</span>
              </button>

              <button
                type="button"
                onClick={async () => {
                  if (realtimeStatus === 'demo') {
                    setAuthModalOpen(true);
                    return;
                  }
                  await ledgerQuery.refetch();
                  addToast(
                    tr('Ledger synchronized', 'تمت مزامنة الدفتر'),
                    tr('Fetched latest state from Supabase', 'تم جلب أحدث حالة من Supabase'),
                    'info'
                  );
                }}
                title={
                  realtimeStatus === 'connected'
                    ? `Supabase Realtime subscribed${lastRealtimeSyncAt ? ` · Last event ${new Date(lastRealtimeSyncAt).toLocaleTimeString()}` : ''} (click to refresh)`
                    : realtimeStatus === 'disconnected'
                      ? 'Realtime disconnected/reconnecting (click to resync manually)'
                      : 'Local Demo Mode — sandboxed browser localStorage only (click to configure or sign in to Supabase)'
                }
                className="hidden sm:inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[#24489B] hover:bg-white/15 border border-white/20 text-[11px] font-mono text-white transition-colors whitespace-nowrap"
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    realtimeStatus === 'connected'
                      ? 'bg-[#D6FF3D]'
                      : realtimeStatus === 'disconnected'
                        ? 'bg-amber-300'
                        : 'bg-[#D6FF3D]'
                  }`}
                />
                <span>
                  {realtimeStatus === 'connected'
                    ? tr('Realtime: Live', 'مزامنة مباشرة')
                    : realtimeStatus === 'disconnected'
                      ? tr('Realtime: Reconnecting', 'إعادة الاتصال')
                      : tr('DEMO MODE', 'وضع العرض')}
                </span>
              </button>

              {masterTerminal && (
                <button
                  type="button"
                  onClick={() =>
                    handleCopy(
                      masterTerminal.terminalId,
                      tr('Copied Master Terminal ID', 'تم نسخ معرف المحطة الرئيسية')
                    )
                  }
                  className="hidden md:inline-flex items-center text-xs font-mono tabular-nums text-blue-100 hover:text-[#D6FF3D] transition-colors whitespace-nowrap"
                >
                  {masterTerminal.terminalId}
                </button>
              )}

              <button
                type="button"
                onClick={() => handleNavigate(masterTerminal ? 'transfer' : 'kyc_verification')}
                className="px-4 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors whitespace-nowrap shrink-0 shadow-sm"
              >
                {masterTerminal
                  ? tr('New Transfer', 'تحويل جديد')
                  : tr('Verify KYC / KYB', 'توثيق الهوية')}
              </button>
            </div>
          </header>

          <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto">
            {ledgerQuery.isLoading || !ledger ? (
              <div className="space-y-6 animate-pulse">
                <div className="h-44 bg-white border border-[#E2E8F0] rounded-xl" />
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <div className="h-56 bg-white border border-[#E2E8F0] rounded-xl" />
                  <div className="h-56 bg-white border border-[#E2E8F0] rounded-xl" />
                  <div className="h-56 bg-white border border-[#E2E8F0] rounded-xl" />
                </div>
              </div>
            ) : (
              <>
                {activeView === 'kyc_verification' && (
                  <KycVerificationView
                    submission={kycSubmission}
                    authMode={auth.authMode}
                    userId={auth.effectiveUserId}
                    onSubmitKyc={async (input) => {
                      await submitKycMutation.mutateAsync(input);
                    }}
                    onToast={addToast}
                  />
                )}

                {activeView === 'admin_panel' && (
                  <AdminPanelView
                    terminals={ledger.terminals}
                    wallets={ledger.wallets}
                    transactions={ledger.transactions}
                    ledgerPostings={ledger.ledgerPostings}
                    auditLogs={ledger.auditLogs ?? []}
                    withdrawalRequests={ledger.withdrawalRequests ?? []}
                    kycQueue={ledger.kycQueue ?? []}
                    assetRates={ledger.assetRates}
                    authMode={auth.authMode}
                    adminProfile={adminProfileQuery.data}
                    onVerifyLedgerInvariant={() =>
                      verifyInvariantMutation.mutateAsync(ledger.ledgerPostings)
                    }
                    onUpdateTerminalStatus={async (params) => {
                      await adminUpdateStatusMutation.mutateAsync(params);
                    }}
                    onReviewWithdrawal={async (params) => {
                      await adminReviewWithdrawalMutation.mutateAsync(params);
                    }}
                    onReviewKyc={async (params) => {
                      await adminReviewKycMutation.mutateAsync(params);
                    }}
                    onToast={addToast}
                  />
                )}

                {activeView !== 'kyc_verification' &&
                  activeView !== 'admin_panel' &&
                  !masterTerminal && (
                    <div className="max-w-2xl mx-auto mt-8 bg-white border border-[#E2E8F0] rounded-xl p-7 space-y-5 shadow-sm">
                      <div className="flex items-start gap-4">
                        <div className="w-11 h-11 rounded-lg bg-amber-50 border border-amber-200 flex items-center justify-center shrink-0">
                          <Lock className="w-5 h-5 text-amber-700" />
                        </div>
                        <div className="space-y-1.5">
                          <div className="text-[11px] font-mono uppercase tracking-wider text-amber-700 font-semibold">
                            {tr('Status', 'الحالة')} · {kycStatus.replace('_', ' ')}
                          </div>
                          <h2 className="text-lg font-semibold text-[#0F172A]">
                            {tr(
                              'Master Treasury Provisioning Locked Pending KYC / KYB Approval',
                              'تفعيل الخزينة الرئيسية مقفل بانتظار موافقة التوثيق'
                            )}
                          </h2>
                          <p className="text-xs text-slate-600 leading-relaxed">
                            {kycStatus === 'pending_review'
                              ? tr(
                                  'Your identity and compliance dossier has been submitted and is currently awaiting compliance officer approval. Your Master Terminal ID and settlement wallets will activate automatically upon approval.',
                                  'تم إرسال ملف الهوية والامتثال وهو قيد مراجعة مسؤول الامتثال حالياً. سيتم تفعيل معرف المحطة الرئيسية ومحافظ التسوية تلقائياً فور الموافقة.'
                                )
                              : kycStatus === 'rejected'
                                ? `${tr('Your KYC / KYB submission requires correction:', 'يتطلب طلب التوثيق الخاص بك تعديلاً:')} ${kycSubmission?.rejection_reason ?? tr('Review compliance feedback and resubmit updated documents.', 'راجع ملاحظات الامتثال وأعد إرسال المستندات المحدثة.')}`
                                : tr(
                                    'PostgreSQL treasury onboarding requires verified Individual KYC or Corporate KYB compliance approval before generating your Crockford Base32 Master Terminal and enabling settlements.',
                                    'يتطلب تفعيل الخزينة موافقة امتثال KYC للأفراد أو KYB للشركات قبل إنشاء المحطة الرئيسية وتمكين التسويات.'
                                  )}
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-[#E2E8F0]">
                        <button
                          type="button"
                          onClick={() => handleNavigate('kyc_verification')}
                          className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors whitespace-nowrap"
                        >
                          <UserCheck className="w-4 h-4" />
                          {kycStatus === 'pending_review'
                            ? tr('View KYC Submission Status', 'عرض حالة طلب التوثيق')
                            : kycStatus === 'rejected'
                              ? tr('Update & Resubmit KYC', 'تحديث وإعادة إرسال التوثيق')
                              : tr('Complete KYC / KYB Verification', 'إكمال توثيق KYC / KYB')}
                          <ArrowRight className="w-3.5 h-3.5 rtl:rotate-180" />
                        </button>
                      </div>
                    </div>
                  )}

                {masterTerminal && activeView === 'dashboard' && (
                  <div className="space-y-6">
                    {kycStatus !== 'approved' && (
                      <div className="bg-white border border-amber-200 rounded-xl px-5 py-3.5 flex flex-wrap items-center justify-between gap-4 shadow-sm">
                        <div className="flex items-center gap-3 text-xs">
                          <UserCheck className="w-4 h-4 text-amber-700 shrink-0" />
                          <span className="text-slate-700">
                            <strong className="font-semibold text-[#0F172A]">
                              {tr('Compliance Gate', 'بوابة الامتثال')} ({kycStatus.replace('_', ' ').toUpperCase()}):
                            </strong>{' '}
                            {tr(
                              'External crypto withdrawals and Sub-Terminal provisioning require approved KYC / KYB verification.',
                              'تتطلب السحوبات الخارجية وإنشاء المحطات الفرعية موافقة توثيق KYC / KYB.'
                            )}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleNavigate('kyc_verification')}
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors whitespace-nowrap shrink-0"
                        >
                          {kycStatus === 'pending_review'
                            ? tr('View Verification', 'عرض التوثيق')
                            : tr('Complete KYC / KYB', 'إكمال التوثيق')}
                          <ArrowRight className="w-3.5 h-3.5 rtl:rotate-180" />
                        </button>
                      </div>
                    )}

                    <DashboardView
                      masterTerminal={masterTerminal}
                      subTerminals={subTerminals}
                      wallets={ledger.wallets}
                      transactions={ledger.transactions}
                      dailyWithdrawnUsd={ledger.dailyWithdrawnUsd}
                      assetRates={ledger.assetRates}
                      assetRatesSource={ledger.assetRatesSource}
                      onCopy={handleCopy}
                      onOpenQr={() => setQrModalOpen(true)}
                      onNavigate={handleNavigate}
                    />
                  </div>
                )}

                {masterTerminal && activeView === 'transfer' && (
                  <InternalTransferView
                    terminals={ledger.terminals}
                    wallets={ledger.wallets}
                    assetRates={ledger.assetRates}
                    preselectedAsset={preselectedAsset}
                    onExecuteTransfer={async (params) => {
                      await internalTransferMutation.mutateAsync(params);
                    }}
                    onToast={addToast}
                  />
                )}

                {masterTerminal && activeView === 'deposit_withdraw' && (
                  <DepositWithdrawView
                    terminals={ledger.terminals}
                    wallets={ledger.wallets}
                    whitelistAddresses={ledger.whitelistAddresses}
                    depositAddresses={ledger.depositAddresses}
                    dailyWithdrawnUsd={ledger.dailyWithdrawnUsd}
                    assetRates={ledger.assetRates}
                    authMode={auth.authMode}
                    kycStatus={kycStatus}
                    initialMode={dwInitialMode}
                    initialAsset={preselectedAsset}
                    onEnsureDepositAddress={async (params) => {
                      await ensureDepositAddressMutation.mutateAsync(params);
                    }}
                    onSimulateDeposit={async (params) => {
                      await depositMutation.mutateAsync(params);
                    }}
                    onExecuteWithdrawal={async (params) => {
                      await withdrawalMutation.mutateAsync(params);
                    }}
                    onAddWhitelist={async (params) => {
                      await addWhitelistMutation.mutateAsync(params);
                    }}
                    onNavigateToKyc={() => handleNavigate('kyc_verification')}
                    onCopy={handleCopy}
                    onToast={addToast}
                  />
                )}

                {masterTerminal && activeView === 'sub_terminals' && (
                  <SubTerminalsView
                    terminals={ledger.terminals}
                    wallets={ledger.wallets}
                    assetRates={ledger.assetRates}
                    kycStatus={kycStatus}
                    onProvisionSub={async (params) => {
                      await provisionSubMutation.mutateAsync(params);
                    }}
                    onUpdatePolicy={async (params) => {
                      await updatePolicyMutation.mutateAsync(params);
                    }}
                    onRebalance={async (params) => {
                      await internalTransferMutation.mutateAsync(params);
                    }}
                    onNavigateToKyc={() => handleNavigate('kyc_verification')}
                    onCopy={handleCopy}
                    onToast={addToast}
                  />
                )}

                {masterTerminal && activeView === 'invoices' && (
                  <InvoicesView
                    terminals={ledger.terminals}
                    wallets={ledger.wallets}
                    invoices={ledger.invoices ?? []}
                    onCreateInvoice={async (params) => {
                      await createInvoiceMutation.mutateAsync(params);
                    }}
                    onPayInvoice={async (params) => {
                      await payInvoiceMutation.mutateAsync(params);
                    }}
                    onCopy={handleCopy}
                    onToast={addToast}
                  />
                )}

                {masterTerminal && activeView === 'trading_funding' && (
                  <TradingFundingView
                    terminals={ledger.terminals}
                    wallets={ledger.wallets}
                    tradingAccounts={ledger.tradingAccounts ?? []}
                    onTransferToTrading={async (params) => {
                      await tradingTransferMutation.mutateAsync(params);
                    }}
                    onToast={addToast}
                  />
                )}

                {masterTerminal && activeView === 'ledger' && (
                  <LedgerAuditView
                    terminals={ledger.terminals}
                    transactions={ledger.transactions}
                    ledgerPostings={ledger.ledgerPostings}
                    authMode={auth.authMode}
                    onVerifyLedgerInvariant={() =>
                      verifyInvariantMutation.mutateAsync(ledger.ledgerPostings)
                    }
                    onCopy={handleCopy}
                    onToast={addToast}
                  />
                )}
              </>
            )}
          </main>
        </div>

        {masterTerminal && (
          <TerminalQrModal
            open={qrModalOpen}
            terminalId={masterTerminal.terminalId}
            label={masterTerminal.label}
            onClose={() => setQrModalOpen(false)}
            onCopy={handleCopy}
          />
        )}

        <SchemaModal
          open={schemaModalOpen}
          onClose={() => setSchemaModalOpen(false)}
          onCopy={handleCopy}
        />

        <AuthGateModal
          open={authModalOpen || auth.shouldShowAuthGate}
          canDismiss={!auth.shouldShowAuthGate}
          isSupabaseConfigured={auth.isSupabaseConfigured}
          authMode={auth.authMode}
          session={auth.session}
          user={auth.user}
          demoModeEnabled={auth.demoModeEnabled}
          onToggleDemoMode={auth.setDemoModeEnabled}
          onSignIn={auth.signIn}
          onSignUp={auth.signUp}
          onSignOut={auth.signOut}
          onClose={() => setAuthModalOpen(false)}
          onToast={addToast}
        />

        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </div>
    </TwoFactorRuntimeProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <NtpsWorkspace />
      </LocaleProvider>
    </QueryClientProvider>
  );
}
