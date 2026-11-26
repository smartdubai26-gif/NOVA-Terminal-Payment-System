import { useState } from 'react';
import { ArrowLeftRight, TrendingUp, ShieldCheck, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import type { TerminalRecord, TradingAccount, WalletBalance } from '../types/ntps';
import { formatAssetAmount } from '../lib/format';
import { TwoFactorModal } from './TwoFactorModal';
import { useLocale } from '../context/LocaleContext';

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
  const { tr } = useLocale();
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
        tr('Trading funding transfer settled', 'تمت تسوية تحويل تمويل التداول'),
        `${formatAssetAmount(parsedAmount, activeAccount.currency)} ${activeAccount.currency} successfully bridged ${
          direction === 'to_trading' ? 'to margin account' : 'back to terminal'
        }`,
        'success'
      );
    } catch (err) {
      onToast(
        tr('Bridge transfer failed', 'فشل تحويل الجسر'),
        err instanceof Error ? err.message : 'Error',
        'error'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white border border-[#E2E8F0] rounded-xl p-6 flex flex-wrap items-center justify-between gap-4 shadow-xs">
        <div>
          <h2 className="text-base font-semibold text-[#0F172A]">
            {tr('Trading Account Funding Bridge', 'جسر تمويل حسابات التداول')}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {tr(
              'Instant margin provisioning and collateral settlement between NTPS Terminals and NOVA / MT5 Omnibus',
              'توفير الهامش الفوري وتسوية الضمانات بين محطات NTPS وحسابات التداول'
            )}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs font-mono font-semibold text-white bg-[#1E40AF] px-3 py-1.5 rounded-lg">
          <TrendingUp className="w-3.5 h-3.5 text-[#D6FF3D]" />
          {tr('Omnibus Margin Bridge Active', 'جسر الهامش الموحد نشط')}
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
              className={`bg-white border rounded-xl p-6 cursor-pointer transition-all space-y-4 shadow-xs ${
                isSelected
                  ? 'border-[#1E40AF] ring-2 ring-[#1E40AF]/15'
                  : 'border-[#E2E8F0] hover:border-[#1E40AF]/40'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-[#0F172A] uppercase">
                      {acct.account_type === 'nova_margin'
                        ? tr('NOVA Platform Margin', 'هامش منصة NOVA')
                        : tr('MT5 Omnibus Desk', 'مكتب MT5 الموحد')}
                    </span>
                    <span className="text-[11px] font-mono font-semibold bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded text-emerald-700">
                      {acct.leverage}
                    </span>
                  </div>
                  <p className="font-mono tabular-nums text-xs text-[#1E40AF] font-semibold mt-1">
                    {acct.account_login}
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 text-xs text-slate-600 font-mono tabular-nums">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                  {termCode.slice(0, 16)}...
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-3 border-t border-[#E2E8F0] text-xs">
                <div>
                  <span className="text-slate-500">{tr('Total Balance', 'الرصيد الإجمالي')}</span>
                  <div className="font-mono tabular-nums text-lg font-bold text-[#0F172A] mt-0.5">
                    {formatAssetAmount(acct.balance, acct.currency)} {acct.currency}
                  </div>
                </div>
                <div>
                  <span className="text-slate-500">{tr('Free Margin', 'الهامش الحر')}</span>
                  <div className="font-mono tabular-nums text-lg font-bold text-emerald-700 mt-0.5">
                    {formatAssetAmount(acct.free_margin, acct.currency)} {acct.currency}
                  </div>
                </div>
              </div>

              <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                {tr('Associated Terminal:', 'المحطة المرتبطة:')} {term?.label ?? termCode} ({termCode})
              </div>
            </div>
          );
        })}
      </div>

      {/* Transfer Bridge Panel */}
      {activeAccount && boundTerminal && (
        <div className="bg-white border border-[#E2E8F0] rounded-xl p-6 space-y-6 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E2E8F0] pb-4">
            <div>
              <h3 className="text-sm font-semibold text-[#0F172A]">
                {tr('Bridge Funds:', 'جسر تحويل الأموال:')} {activeAccount.account_login}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {tr('Terminal Wallet Available:', 'رصيد المحطة المتاح:')}{' '}
                <strong className="font-mono tabular-nums text-[#0F172A]">
                  {formatAssetAmount(availableWalletBalance, activeAccount.currency)} {activeAccount.currency}
                </strong>
              </p>
            </div>

            <div className="flex items-center gap-1 p-1 bg-[#F4F7FA] border border-[#E2E8F0] rounded-lg">
              <button
                type="button"
                onClick={() => setDirection('to_trading')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  direction === 'to_trading'
                    ? 'bg-[#1E40AF] text-white shadow-xs'
                    : 'text-slate-600 hover:text-[#0F172A]'
                }`}
              >
                <ArrowDownLeft className="w-3.5 h-3.5" />
                {tr('Terminal → Trading', 'المحطة ← التداول')}
              </button>
              <button
                type="button"
                onClick={() => setDirection('from_trading')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  direction === 'from_trading'
                    ? 'bg-[#1E40AF] text-white shadow-xs'
                    : 'text-slate-600 hover:text-[#0F172A]'
                }`}
              >
                <ArrowUpRight className="w-3.5 h-3.5" />
                {tr('Trading → Terminal', 'التداول ← المحطة')}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-end">
            <div className="md:col-span-8 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <label className="font-semibold text-[#0F172A]">{tr('Transfer Amount', 'مبلغ التحويل')}</label>
                <button
                  type="button"
                  onClick={() =>
                    setAmountInput(
                      String(direction === 'to_trading' ? availableWalletBalance : activeAccount.free_margin)
                    )
                  }
                  className="font-mono tabular-nums text-[#1E40AF] hover:text-[#24489B] font-medium"
                >
                  {tr('Max:', 'الحد الأقصى:')}{' '}
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
                  className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg ps-3.5 pe-16 py-3 font-mono tabular-nums text-sm text-[#0F172A] focus:outline-none"
                />
                <span className="absolute end-3.5 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-500 font-semibold">
                  {activeAccount.currency}
                </span>
              </div>
              {exceedsWallet && (
                <p className="text-xs text-red-600 font-medium">
                  {tr('Exceeds available terminal wallet balance.', 'يتجاوز الرصيد المتاح في محطة الدفع.')}
                </p>
              )}
              {exceedsMargin && (
                <p className="text-xs text-red-600 font-medium">
                  {tr('Exceeds trading account free margin.', 'يتجاوز الهامش الحر لحساب التداول.')}
                </p>
              )}
            </div>

            <div className="md:col-span-4">
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => setIs2FaOpen(true)}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors shadow-xs"
              >
                <ArrowLeftRight className="w-4 h-4" />
                {tr('Execute Margin Bridge', 'تنفيذ جسر الهامش')}
              </button>
            </div>
          </div>
        </div>
      )}

      <TwoFactorModal
        open={is2FaOpen}
        title={tr('Authorize Trading Bridge Transfer', 'اعتماد تحويل جسر التداول')}
        subtitle={tr('2FA verification required for omnibus margin rebalance', 'التحقق الثنائي مطلوب لإعادة موازنة الهامش')}
        confirmLabel={tr('Confirm Bridge Transfer', 'تأكيد التحويل')}
        isSubmitting={isSubmitting}
        onClose={() => setIs2FaOpen(false)}
        onConfirm={handleConfirmTransfer}
        summaryRows={[
          { label: tr('Trading Account', 'حساب التداول'), value: activeAccount?.account_login ?? '', mono: true },
          {
            label: tr('Direction', 'الاتجاه'),
            value:
              direction === 'to_trading'
                ? 'Terminal → Trading Margin'
                : 'Trading Free Margin → Terminal',
            highlight: 'cyan',
          },
          {
            label: tr('Bridge Amount', 'المبلغ'),
            value: `${formatAssetAmount(parsedAmount || 0, activeAccount?.currency ?? 'USDT')} ${activeAccount?.currency ?? 'USDT'}`,
            mono: true,
            highlight: 'gold',
          },
          {
            label: tr('Settlement Fee', 'رسوم التسوية'),
            value: '$0.00 (Zero-Fee Internal Bridge)',
            highlight: 'emerald',
          },
        ]}
      />
    </div>
  );
}
