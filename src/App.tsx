import { useState, useCallback } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ArrowDownUp,
  ArrowLeftRight,
  Database,
  FileSpreadsheet,
  FileText,
  GitBranch,
  LayoutDashboard,
  Lock,
  Menu,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  TrendingUp,
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
import { ToastContainer } from './components/ToastContainer';
import { TerminalQrModal } from './components/TerminalQrModal';
import { SchemaModal } from './components/SchemaModal';
import { AuthGateModal } from './components/AuthGateModal';
import { TwoFactorRuntimeProvider } from './context/TwoFactorContext';

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
  label: string;
  icon: typeof LayoutDashboard;
}[] = [
  { id: 'dashboard', label: 'Overview & Wallets', icon: LayoutDashboard },
  { id: 'transfer', label: 'Internal Transfer', icon: ArrowLeftRight },
  { id: 'deposit_withdraw', label: 'Deposit & Withdraw', icon: ArrowDownUp },
  { id: 'sub_terminals', label: 'Sub-Terminals & IDs', icon: GitBranch },
  { id: 'invoices', label: 'Invoices & QR Pay', icon: FileText },
  { id: 'trading_funding', label: 'Trading Funding Bridge', icon: TrendingUp },
  { id: 'admin_panel', label: 'Admin & Compliance', icon: ShieldAlert },
  { id: 'ledger', label: 'Ledger Audit Log', icon: FileSpreadsheet },
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
        addToast('Copied to clipboard', text, 'info');
      }
    },
    [addToast]
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

  const currentNavLabel = NAV_ITEMS.find((n) => n.id === activeView)?.label ?? 'Overview';
  const ledger = ledgerQuery.data;
  const masterTerminal = ledger?.terminals.find((t) => t.type === 'master') ?? ledger?.terminals[0];
  const subTerminals = ledger?.terminals.filter((t) => t.type === 'sub') ?? [];

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
    <div className="min-h-screen bg-[#05070A] text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 bg-[#080B11] border-r border-white/[0.08]">
        <div className="h-16 px-6 flex items-center border-b border-white/[0.08]">
          <button
            type="button"
            onClick={() => handleNavigate('dashboard')}
            className="flex items-center gap-2.5 text-left whitespace-nowrap shrink-0"
          >
            <span className="w-7 h-7 rounded-lg bg-[#00E5FF]/15 border border-[#00E5FF]/35 flex items-center justify-center">
              <Terminal className="w-4 h-4 text-[#00E5FF]" />
            </span>
            <span className="font-display text-base font-bold tracking-tight text-white">
              NOVA Terminal
            </span>
          </button>
        </div>

        <nav className="flex-1 px-3 py-5 space-y-1" aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavigate(item.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-[#00E5FF]/12 text-[#00E5FF] border border-[#00E5FF]/25'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-white/[0.04] border border-transparent'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-white/[0.08] space-y-1">
          <button
            type="button"
            onClick={() => setAuthModalOpen(true)}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-xs rounded-lg bg-[#05070A] border border-white/[0.08] hover:border-white/[0.16] transition-colors mb-1.5"
          >
            {auth.authMode === 'supabase' ? (
              <ShieldCheck className="w-3.5 h-3.5 text-[#00E39A] shrink-0" />
            ) : (
              <Lock className="w-3.5 h-3.5 text-[#F5C542] shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="font-medium text-slate-200 truncate">
                {auth.authMode === 'supabase'
                  ? 'Connected Supabase Session'
                  : 'Local Demo Mode (localStorage)'}
              </div>
              <div className="font-mono text-[11px] text-slate-400 truncate">
                {auth.effectiveUserEmail}
              </div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => setSchemaModalOpen(true)}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-slate-400 hover:text-slate-100 hover:bg-white/[0.04] rounded-lg transition-colors whitespace-nowrap"
          >
            <Database className="w-3.5 h-3.5 text-[#00E5FF]" />
            Supabase SQL Schema
          </button>
          {auth.authMode === 'local_demo' && (
            <button
              type="button"
              onClick={async () => {
                await resetLedgerMutation.mutateAsync();
                addToast('Ledger state restored', 'Reset to initial institutional balances', 'info');
              }}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-slate-400 hover:text-slate-100 hover:bg-white/[0.04] rounded-lg transition-colors whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Demo Ledger
            </button>
          )}
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative z-50 w-64 max-w-[80vw] bg-[#080B11] border-r border-white/[0.1] flex flex-col">
            <div className="h-16 px-5 flex items-center justify-between border-b border-white/[0.08]">
              <span className="font-display text-base font-bold text-white">NOVA Terminal</span>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="p-1.5 text-slate-400 hover:text-white"
                aria-label="Close navigation menu"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 px-3 py-4 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeView === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNavigate(item.id)}
                    className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-xs font-medium rounded-lg transition-colors ${
                      active
                        ? 'bg-[#00E5FF]/12 text-[#00E5FF] border border-[#00E5FF]/25'
                        : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-3 border-t border-white/[0.08] space-y-1">
              <button
                type="button"
                onClick={() => {
                  setMobileNavOpen(false);
                  setAuthModalOpen(true);
                }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-xs rounded-lg bg-[#05070A] border border-white/[0.08] hover:border-white/[0.16] transition-colors mb-1.5"
              >
                {auth.authMode === 'supabase' ? (
                  <ShieldCheck className="w-3.5 h-3.5 text-[#00E39A] shrink-0" />
                ) : (
                  <Lock className="w-3.5 h-3.5 text-[#F5C542] shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-200 truncate">
                    {auth.authMode === 'supabase'
                      ? 'Connected Supabase Session'
                      : 'Local Demo Mode (localStorage)'}
                  </div>
                  <div className="font-mono text-[11px] text-slate-400 truncate">
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
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-slate-400 hover:text-slate-100 rounded-lg"
              >
                <Database className="w-3.5 h-3.5 text-[#00E5FF]" />
                Supabase SQL Schema
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 px-4 sm:px-6 lg:px-8 border-b border-white/[0.08] bg-[#05070A]/90 backdrop-blur-md sticky top-0 z-30 flex items-center justify-between gap-8">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-300 hover:text-white rounded-lg"
              aria-label="Open navigation menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-xs sm:text-sm min-w-0 truncate">
              <span className="text-slate-400 hidden sm:inline whitespace-nowrap">
                NTPS Workspace
              </span>
              <span className="text-slate-600 hidden sm:inline">/</span>
              <h1 className="font-display font-semibold text-slate-100 truncate">
                {currentNavLabel}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-3 sm:gap-4 shrink-0">
            <button
              type="button"
              onClick={async () => {
                if (realtimeStatus === 'demo') {
                  setAuthModalOpen(true);
                  return;
                }
                await ledgerQuery.refetch();
                addToast('Ledger synchronized', 'Fetched latest state from Supabase', 'info');
              }}
              title={
                realtimeStatus === 'connected'
                  ? `Supabase Realtime subscribed${lastRealtimeSyncAt ? ` · Last event ${new Date(lastRealtimeSyncAt).toLocaleTimeString()}` : ''} (click to refresh)`
                  : realtimeStatus === 'disconnected'
                    ? 'Realtime disconnected/reconnecting (click to resync manually)'
                    : 'Local Demo Mode — sandboxed browser localStorage only (click to configure or sign in to Supabase)'
              }
              className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-[11px] font-mono transition-colors whitespace-nowrap ${
                realtimeStatus === 'connected'
                  ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/15'
                  : realtimeStatus === 'disconnected'
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/15'
                    : 'bg-amber-500/10 border-amber-500/35 text-[#F5C542] hover:bg-amber-500/15'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  realtimeStatus === 'connected'
                    ? 'bg-emerald-400'
                    : realtimeStatus === 'disconnected'
                      ? 'bg-amber-400'
                      : 'bg-[#F5C542]'
                }`}
              />
              <span>
                {realtimeStatus === 'connected'
                  ? 'Realtime: Live'
                  : realtimeStatus === 'disconnected'
                    ? 'Realtime: Reconnecting'
                    : 'DEMO MODE — localStorage'}
              </span>
            </button>
            {masterTerminal && (
              <button
                type="button"
                onClick={() => handleCopy(masterTerminal.terminalId, 'Copied Master Terminal ID')}
                className="hidden md:inline-flex items-center text-xs font-mono text-slate-300 hover:text-[#00E5FF] transition-colors whitespace-nowrap"
              >
                {masterTerminal.terminalId}
              </button>
            )}
            <button
              type="button"
              onClick={() => handleNavigate('transfer')}
              className="px-4 py-2 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              New Transfer
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto">
          {ledgerQuery.isLoading || !ledger || !masterTerminal ? (
            <div className="space-y-6 animate-pulse">
              <div className="h-44 bg-[#0B0F16] border border-white/[0.06] rounded-xl" />
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="h-56 bg-[#0B0F16] border border-white/[0.06] rounded-xl" />
                <div className="h-56 bg-[#0B0F16] border border-white/[0.06] rounded-xl" />
                <div className="h-56 bg-[#0B0F16] border border-white/[0.06] rounded-xl" />
              </div>
            </div>
          ) : (
            <>
              {activeView === 'dashboard' && (
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
              )}

              {activeView === 'transfer' && (
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

              {activeView === 'deposit_withdraw' && (
                <DepositWithdrawView
                  terminals={ledger.terminals}
                  wallets={ledger.wallets}
                  whitelistAddresses={ledger.whitelistAddresses}
                  depositAddresses={ledger.depositAddresses}
                  dailyWithdrawnUsd={ledger.dailyWithdrawnUsd}
                  assetRates={ledger.assetRates}
                  authMode={auth.authMode}
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
                  onCopy={handleCopy}
                  onToast={addToast}
                />
              )}

              {activeView === 'sub_terminals' && (
                <SubTerminalsView
                  terminals={ledger.terminals}
                  wallets={ledger.wallets}
                  assetRates={ledger.assetRates}
                  onProvisionSub={async (params) => {
                    await provisionSubMutation.mutateAsync(params);
                  }}
                  onUpdatePolicy={async (params) => {
                    await updatePolicyMutation.mutateAsync(params);
                  }}
                  onRebalance={async (params) => {
                    await internalTransferMutation.mutateAsync(params);
                  }}
                  onCopy={handleCopy}
                  onToast={addToast}
                />
              )}

              {activeView === 'invoices' && (
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

              {activeView === 'trading_funding' && (
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

              {activeView === 'admin_panel' && (
                <AdminPanelView
                  terminals={ledger.terminals}
                  wallets={ledger.wallets}
                  transactions={ledger.transactions}
                  ledgerPostings={ledger.ledgerPostings}
                  auditLogs={ledger.auditLogs ?? []}
                  withdrawalRequests={ledger.withdrawalRequests ?? []}
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
                  onToast={addToast}
                />
              )}

              {activeView === 'ledger' && (
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
      <NtpsWorkspace />
    </QueryClientProvider>
  );
}
