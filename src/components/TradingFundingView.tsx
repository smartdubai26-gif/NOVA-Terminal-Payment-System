import { useState } from 'react';
import { ArrowLeftRight, TrendingUp, ShieldCheck, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import type { TerminalRecord, TradingAccount, WalletBalance } from '../types/ntps';
import { formatAssetAmount } from '../lib/format';
import { TwoFactorModal } from './TwoFactorModal';

interface TradingFundingViewProps {
  terminals: TerminalRecord[];
  wallets: WalletBalance[];
  tradingAccounts: TradingAccount[];
  onTransferToTrading: (params: {
    terminalUuid: string;
    tradingAccountId: string;
    amount: number;
    direction: 'to_trading' | 'from_trading';
  }) => Promise<void>;
  onToast: (title: string, description?: string, variant?: 'success' | 'error' | 'info') => void;
}

export function TradingFundingView({
  terminals,
  wallets,
  tradingAccounts,
  onTransferToTrading,
  onToast,
}: TradingFundingViewProps) {
  const [selectedAcctId, setSelectedAcctId] = useState(tradingAccounts[0]?.id ?? '');
  const [direction, setDirection] = useState<'to_trading' | 'from_trading'>('to_trading');
  const [amountInput, setAmountInput] = useState('25000');
  const [is2FaOpen, setIs2FaOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const activeAccount =
    tradingAccounts.find((t) => t.id === selectedAcctId) ?? tradingAccounts[0];
  const boundTerminal = terminals.find((t) => t.id === activeAccount?.terminalUuid) ?? terminals[0];

  const matchingWallet = wallets.find(
    (w) => w.terminalUuid === (boundTerminal?.id ?? '') && w.asset === (activeAccount?.currency ?? 'USDT')
  );
  const availableWalletBalance = matchingWallet?.available ?? 0;

  const parsedAmount = Number(amountInput);
  const isInvalidAmount = Number.isNaN(parsedAmount) || parsedAmount <= 0;

  const exceedsWallet = direction === 'to_trading' && parsedAmount > availableWalletBalance;
  const exceedsMargin = direction === 'from_trading' && parsedAmount > (activeAccount?.free_margin ?? 0);

  const canSubmit = !isInvalidAmount && !exceedsWallet && !exceedsMargin;

  const handleConfirmTransfer = async () => {
    if (!activeAccount || !boundTerminal) return;
    setIsSubmitting(true);
    try {
      await onTransferToTrading({
        terminalUuid: boundTerminal.id,
        tradingAccountId: activeAccount.id,
        amount: parsedAmount,
        direction,
      });
      setIs2FaOpen(false);
      onToast(
        'Trading funding transfer settled',
        `${formatAssetAmount(parsedAmount, activeAccount.currency)} ${activeAccount.currency} successfully bridged ${
          direction === 'to_trading' ? 'to margin account' : 'back to terminal'
        }`,
        'success'
      );
    } catch (err) {
      onToast('Bridge transfer failed', err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Trading Account Funding Bridge
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Instant margin provisioning and collateral settlement between NTPS Terminals and NOVA / MT5 Omnibus
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs font-mono text-[#00E5FF] bg-[#00E5FF]/10 px-3 py-1.5 rounded-lg border border-[#00E5FF]/25">
          <TrendingUp className="w-3.5 h-3.5" />
          Omnibus Margin Bridge Active
        </span>
      </div>

      {/* Linked Accounts Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {tradingAccounts.map((acct) => {
          const isSelected = acct.id === selectedAcctId;
          const term = terminals.find((t) => t.id === acct.terminalUuid);
          const termCode = term?.terminalId ?? acct.terminalUuid;

          return (
            <div
              key={acct.id}
              onClick={() => setSelectedAcctId(acct.id)}
              className={`bg-[#0B0F16] border rounded-xl p-6 cursor-pointer transition-all space-y-4 ${
                isSelected
                  ? 'border-[#00E5FF] shadow-[0_0_24px_-8px_rgba(0,229,255,0.3)]'
                  : 'border-white/[0.08] hover:border-white/[0.15]'
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-100 uppercase">
                      {acct.account_type === 'nova_margin' ? 'NOVA Platform Margin' : 'MT5 Omnibus Desk'}
                    </span>
                    <span className="text-[11px] font-mono bg-white/[0.06] px-2 py-0.5 rounded text-emerald-400">
                      {acct.leverage}
                    </span>
                  </div>
                  <p className="font-mono text-xs text-[#00E5FF] mt-1">{acct.account_login}</p>
                </div>
                <span className="inline-flex items-center gap-1 text-xs text-slate-400 font-mono">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  Bound: {termCode.slice(0, 16)}...
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-3 border-t border-white/[0.06] text-xs">
                <div>
                  <span className="text-slate-400">Total Balance</span>
                  <div className="font-mono tabular-nums text-lg font-bold text-[#F5C542] mt-0.5">
                    {formatAssetAmount(acct.balance, acct.currency)} {acct.currency}
                  </div>
                </div>
                <div>
                  <span className="text-slate-400">Free Margin</span>
                  <div className="font-mono tabular-nums text-lg font-bold text-emerald-400 mt-0.5">
                    {formatAssetAmount(acct.free_margin, acct.currency)} {acct.currency}
                  </div>
                </div>
              </div>

              <div className="text-[11px] text-slate-500">
                Associated Terminal: {term?.label ?? termCode} ({termCode})
              </div>
            </div>
          );
        })}
      </div>

      {/* Transfer Bridge Panel */}
      {activeAccount && boundTerminal && (
        <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.07] pb-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Bridge Funds: {activeAccount.account_login}
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Terminal Wallet Available: <strong className="font-mono text-slate-200">{formatAssetAmount(availableWalletBalance, activeAccount.currency)} {activeAccount.currency}</strong>
              </p>
            </div>

            <div className="flex items-center gap-1 p-1 bg-[#05070A] border border-white/[0.08] rounded-lg">
              <button
                type="button"
                onClick={() => setDirection('to_trading')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  direction === 'to_trading'
                    ? 'bg-[#00E5FF] text-[#05070A]'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <ArrowDownLeft className="w-3.5 h-3.5" />
                Terminal → Trading
              </button>
              <button
                type="button"
                onClick={() => setDirection('from_trading')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  direction === 'from_trading'
                    ? 'bg-[#00E5FF] text-[#05070A]'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <ArrowUpRight className="w-3.5 h-3.5" />
                Trading → Terminal
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-end">
            <div className="md:col-span-8 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <label className="font-medium text-slate-300">Transfer Amount</label>
                <button
                  type="button"
                  onClick={() =>
                    setAmountInput(
                      String(direction === 'to_trading' ? availableWalletBalance : activeAccount.free_margin)
                    )
                  }
                  className="font-mono text-slate-400 hover:text-[#00E5FF]"
                >
                  Max:{' '}
                  {direction === 'to_trading'
                    ? formatAssetAmount(availableWalletBalance, activeAccount.currency)
                    : formatAssetAmount(activeAccount.free_margin, activeAccount.currency)}{' '}
                  {activeAccount.currency}
                </button>
              </div>
              <div className="relative">
                <input
                  type="number"
                  step="any"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-3 pr-16 font-mono tabular-nums text-sm text-slate-100 focus:outline-none"
                />
                <span className="absolute right-3.5 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                  {activeAccount.currency}
                </span>
              </div>
              {exceedsWallet && (
                <p className="text-xs text-red-400">Exceeds available terminal wallet balance.</p>
              )}
              {exceedsMargin && (
                <p className="text-xs text-red-400">Exceeds trading account free margin.</p>
              )}
            </div>

            <div className="md:col-span-4">
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => setIs2FaOpen(true)}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                <ArrowLeftRight className="w-4 h-4" />
                Execute Margin Bridge
              </button>
            </div>
          </div>
        </div>
      )}

      <TwoFactorModal
        open={is2FaOpen}
        title="Authorize Trading Bridge Transfer"
        subtitle="2FA verification required for omnibus margin rebalance"
        confirmLabel="Confirm Bridge Transfer"
        isSubmitting={isSubmitting}
        onClose={() => setIs2FaOpen(false)}
        onConfirm={handleConfirmTransfer}
        summaryRows={[
          { label: 'Trading Account', value: activeAccount?.account_login ?? '', mono: true },
          { label: 'Direction', value: direction === 'to_trading' ? 'Terminal → Trading Margin' : 'Trading Free Margin → Terminal', highlight: 'cyan' },
          {
            label: 'Bridge Amount',
            value: `${formatAssetAmount(parsedAmount || 0, activeAccount?.currency ?? 'USDT')} ${activeAccount?.currency ?? 'USDT'}`,
            mono: true,
            highlight: 'gold',
          },
          { label: 'Settlement Fee', value: '$0.00 (Zero-Fee Internal Bridge)', highlight: 'emerald' },
        ]}
      />
    </div>
  );
}
