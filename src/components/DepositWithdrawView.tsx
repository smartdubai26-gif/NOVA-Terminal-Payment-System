import { useState, useEffect, useMemo, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Copy,
  Plus,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Radio,
  UserCheck,
} from 'lucide-react';
import type {
  AssetRateMap,
  AssetSymbol,
  DepositAddressRecord,
  KycStatus,
  NetworkId,
  TerminalRecord,
  WalletBalance,
  WhitelistAddress,
} from '../types/ntps';
import {
  ASSET_NETWORKS,
  ASSET_USD_RATES,
  NETWORK_FEES,
  NETWORK_LABELS,
  getTerminalAssetTotal,
  isSimulatedNetwork,
  type LedgerRuntimeMode,
} from '../lib/ledgerEngine';
import { deriveDepositAddress } from '../lib/terminalId';
import { formatAssetAmount, formatUsd } from '../lib/format';
import { TwoFactorModal } from './TwoFactorModal';
import { useLocale } from '../context/LocaleContext';

interface DepositWithdrawViewProps {
  terminals: TerminalRecord[];
  wallets: WalletBalance[];
  whitelistAddresses: WhitelistAddress[];
  depositAddresses?: DepositAddressRecord[];
  dailyWithdrawnUsd: number;
  assetRates?: AssetRateMap;
  authMode?: LedgerRuntimeMode;
  kycStatus?: KycStatus;
  onNavigateToKyc?: () => void;
  initialMode?: 'deposit' | 'withdraw';
  initialAsset?: AssetSymbol;
  onEnsureDepositAddress?: (params: {
    terminalUuid: string;
    asset: AssetSymbol;
    network: NetworkId;
    customAddress?: string;
  }) => Promise<void>;
  onSimulateDeposit: (params: {
    terminalUuid: string;
    asset: AssetSymbol;
    network: NetworkId;
    amount: number;
    sourceAddress: string;
  }) => Promise<void>;
  onExecuteWithdrawal: (params: {
    terminalUuid: string;
    asset: AssetSymbol;
    network: NetworkId;
    destinationAddress: string;
    whitelistAddressId?: string;
    amount: number;
    memo?: string;
    autoApprove?: boolean;
  }) => Promise<void>;
  onAddWhitelist: (params: {
    terminalUuid: string;
    label: string;
    asset: AssetSymbol;
    network: NetworkId;
    address: string;
  }) => Promise<void>;
  onCopy: (text: string, label: string) => void;
  onToast: (title: string, description?: string, variant?: 'success' | 'error' | 'info') => void;
}

export function DepositWithdrawView({
  terminals,
  wallets,
  whitelistAddresses,
  depositAddresses = [],
  dailyWithdrawnUsd,
  assetRates = ASSET_USD_RATES,
  authMode = 'local_demo',
  kycStatus = 'unverified',
  onNavigateToKyc,
  initialMode = 'deposit',
  initialAsset = 'USDT',
  onEnsureDepositAddress,
  onSimulateDeposit,
  onExecuteWithdrawal,
  onAddWhitelist,
  onCopy,
  onToast,
}: DepositWithdrawViewProps) {
  const { tr } = useLocale();
  const isKycApproved = kycStatus === 'approved';
  const [mode, setMode] = useState<'deposit' | 'withdraw'>(initialMode);
  const [terminalUuid, setTerminalUuid] = useState(terminals[0]?.id ?? '');
  const [asset, setAsset] = useState<AssetSymbol>(initialAsset);
  const [network, setNetwork] = useState<NetworkId>(ASSET_NETWORKS[initialAsset][0]);

  const [simDepositAmt, setSimDepositAmt] = useState('25000');
  const [isDepositing, setIsDepositing] = useState(false);
  const [customDepositAddress, setCustomDepositAddress] = useState('');
  const [isUpdatingAddr, setIsUpdatingAddr] = useState(false);
  const ensuredKeysRef = useRef<Set<string>>(new Set());

  const [selectedWhitelistId, setSelectedWhitelistId] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawMemo, setWithdrawMemo] = useState('');
  const [is2FaOpen, setIs2FaOpen] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);

  const [showAddWhitelist, setShowAddWhitelist] = useState(false);
  const [newWlLabel, setNewWlLabel] = useState('');
  const [newWlAddress, setNewWlAddress] = useState('');

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    setAsset(initialAsset);
    setNetwork(ASSET_NETWORKS[initialAsset][0]);
  }, [initialAsset]);

  const handleAssetChange = (nextAsset: AssetSymbol) => {
    setAsset(nextAsset);
    const nets = ASSET_NETWORKS[nextAsset];
    setNetwork(nets[0]);
  };

  const activeTerminal = terminals.find((t) => t.id === terminalUuid) ?? terminals[0];
  const activeWallet = useMemo(
    () =>
      wallets.find(
        (w) =>
          w.terminalUuid === activeTerminal?.id &&
          w.asset === asset &&
          w.network === network
      ) ??
      wallets.find((w) => w.terminalUuid === activeTerminal?.id && w.asset === asset),
    [wallets, activeTerminal, asset, network]
  );

  const persistedDepositRecord = useMemo(
    () =>
      activeWallet
        ? depositAddresses.find(
            (d) => d.wallet_id === activeWallet.id && d.network === network
          )
        : undefined,
    [depositAddresses, activeWallet, network]
  );

  useEffect(() => {
    if (
      authMode !== 'supabase' ||
      !onEnsureDepositAddress ||
      !activeTerminal ||
      !activeWallet ||
      persistedDepositRecord
    ) {
      return;
    }
    const key = `${activeTerminal.id}:${activeWallet.id}:${network}`;
    if (ensuredKeysRef.current.has(key)) return;
    ensuredKeysRef.current.add(key);
    void onEnsureDepositAddress({
      terminalUuid: activeTerminal.id,
      asset,
      network,
    }).catch(() => {
      ensuredKeysRef.current.delete(key);
    });
  }, [
    authMode,
    onEnsureDepositAddress,
    activeTerminal,
    activeWallet,
    persistedDepositRecord,
    asset,
    network,
  ]);

  const depositAddress = useMemo(
    () =>
      persistedDepositRecord?.address ??
      deriveDepositAddress(activeTerminal?.terminalId ?? '', asset, network),
    [persistedDepositRecord, activeTerminal, asset, network]
  );

  const matchingWhitelist = useMemo(
    () =>
      whitelistAddresses.filter(
        (w) => w.asset === asset && w.network === network
      ),
    [whitelistAddresses, asset, network]
  );

  useEffect(() => {
    if (matchingWhitelist.length > 0) {
      if (!matchingWhitelist.some((w) => w.id === selectedWhitelistId)) {
        setSelectedWhitelistId(matchingWhitelist[0].id);
      }
    } else {
      setSelectedWhitelistId('');
    }
  }, [matchingWhitelist, selectedWhitelistId]);

  const selectedWhitelist = matchingWhitelist.find((w) => w.id === selectedWhitelistId);
  const availableAssetBalance = activeTerminal
    ? getTerminalAssetTotal(wallets, activeTerminal.id, asset).available
    : 0;

  const feeInfo = NETWORK_FEES[network];
  const parsedWithdraw = Number(withdrawAmount);
  const withdrawUsd =
    !Number.isNaN(parsedWithdraw) && parsedWithdraw > 0
      ? parsedWithdraw * assetRates[asset]
      : 0;
  const totalDebit =
    !Number.isNaN(parsedWithdraw) && parsedWithdraw > 0
      ? Number((parsedWithdraw + feeInfo.amount).toFixed(8))
      : 0;

  const dailyLimitUsd = activeTerminal?.daily_limit_usd ?? 500000;
  const currentDailyPct = Math.min(100, (dailyWithdrawnUsd / dailyLimitUsd) * 100);
  const projectedDailyPct = Math.min(
    100,
    ((dailyWithdrawnUsd + withdrawUsd) / dailyLimitUsd) * 100
  );
  const exceedsDailyLimit = dailyWithdrawnUsd + withdrawUsd > dailyLimitUsd;
  const exceedsAvail = totalDebit > availableAssetBalance;

  const canWithdraw =
    isKycApproved &&
    Boolean(selectedWhitelist) &&
    !Number.isNaN(parsedWithdraw) &&
    parsedWithdraw > 0 &&
    !exceedsAvail &&
    !exceedsDailyLimit;

  const networkLabel = NETWORK_LABELS[network] ?? network;
  const networkIsSimulated = isSimulatedNetwork(network);

  const handleDepositSim = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = Number(simDepositAmt);
    if (!activeTerminal || Number.isNaN(amt) || amt <= 0) {
      onToast(
        tr('Invalid amount', 'مبلغ غير صالح'),
        tr('Enter a positive deposit amount.', 'أدخل مبلغ إيداع موجباً.'),
        'error'
      );
      return;
    }
    setIsDepositing(true);
    try {
      await onSimulateDeposit({
        terminalUuid: activeTerminal.id,
        asset,
        network,
        amount: amt,
        sourceAddress: deriveDepositAddress(`EXT-${network}`, asset, network),
      });
      onToast(
        tr('Deposit settled to terminal', 'تمت تسوية الإيداع للمحطة'),
        `+${formatAssetAmount(amt, asset)} ${asset} credited via ${networkLabel}`,
        'success'
      );
    } catch (err) {
      onToast(
        tr('Deposit simulation failed', 'فشلت محاكاة الإيداع'),
        err instanceof Error ? err.message : 'Unable to credit deposit',
        'error'
      );
    } finally {
      setIsDepositing(false);
    }
  };

  const handleBindCustomDepositAddress = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeTerminal || !onEnsureDepositAddress || customDepositAddress.trim().length < 12) {
      onToast(
        tr('Invalid address', 'عنوان غير صالح'),
        tr('Enter a valid on-chain deposit address.', 'أدخل عنوان إيداع صالحاً على الشبكة.'),
        'error'
      );
      return;
    }
    setIsUpdatingAddr(true);
    try {
      await onEnsureDepositAddress({
        terminalUuid: activeTerminal.id,
        asset,
        network,
        customAddress: customDepositAddress.trim(),
      });
      setCustomDepositAddress('');
      onToast(
        tr('Deposit address registered', 'تم تسجيل عنوان الإيداع'),
        `${asset} (${networkLabel}) bound in deposit_addresses for worker polling`,
        'success'
      );
    } catch (err) {
      onToast(
        tr('Failed to bind deposit address', 'فشل ربط عنوان الإيداع'),
        err instanceof Error ? err.message : 'Unable to register address',
        'error'
      );
    } finally {
      setIsUpdatingAddr(false);
    }
  };

  const handleConfirmWithdrawal = async () => {
    if (!isKycApproved) {
      onToast(
        tr('KYC verification required', 'مطلوب توثيق الهوية'),
        tr('Complete KYC/KYB approval before submitting external withdrawals.', 'أكمل موافقة التوثيق قبل السحب الخارجي.'),
        'error'
      );
      return;
    }
    if (!activeTerminal || !selectedWhitelist) return;
    setIsWithdrawing(true);
    try {
      await onExecuteWithdrawal({
        terminalUuid: activeTerminal.id,
        asset,
        network,
        destinationAddress: selectedWhitelist.address,
        whitelistAddressId: selectedWhitelist.id,
        amount: parsedWithdraw,
        memo: withdrawMemo.trim() || `Custody withdrawal (${selectedWhitelist.label})`,
        autoApprove: false,
      });
      setIs2FaOpen(false);
      setWithdrawAmount('');
      setWithdrawMemo('');
      onToast(
        tr('Withdrawal queued for compliance review', 'تم وضع السحب في قائمة مراجعة الامتثال'),
        `${formatAssetAmount(parsedWithdraw, asset)} ${asset} to ${selectedWhitelist.label}`,
        'success'
      );
    } catch (err) {
      onToast(
        tr('Withdrawal failed', 'فشل السحب'),
        err instanceof Error ? err.message : 'Unable to process withdrawal',
        'error'
      );
    } finally {
      setIsWithdrawing(false);
    }
  };

  const handleAddWhitelistSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeTerminal || !newWlLabel.trim() || newWlAddress.trim().length < 12) {
      onToast(
        tr('Invalid whitelist entry', 'إدخال قائمة بيضاء غير صالح'),
        tr('Provide a custody label and valid destination address.', 'أدخل اسماً وعنوان وجهة صالحاً.'),
        'error'
      );
      return;
    }
    await onAddWhitelist({
      terminalUuid: activeTerminal.id,
      label: newWlLabel,
      asset,
      network,
      address: newWlAddress,
    });
    setNewWlLabel('');
    setNewWlAddress('');
    setShowAddWhitelist(false);
    onToast(
      tr('Whitelist address added', 'تمت إضافة العنوان للقائمة البيضاء'),
      `${asset} (${networkLabel}) custody destination verified.`,
      'success'
    );
  };

  return (
    <div className="space-y-6">
      {/* Top Mode & Terminal Controls */}
      <div className="bg-white border border-[#E2E8F0] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4 shadow-xs">
        <div className="flex items-center gap-1 p-1 bg-[#F4F7FA] border border-[#E2E8F0] rounded-lg">
          <button
            type="button"
            onClick={() => setMode('deposit')}
            className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              mode === 'deposit'
                ? 'bg-[#1E40AF] text-white shadow-xs'
                : 'text-slate-600 hover:text-[#0F172A]'
            }`}
          >
            <ArrowDownLeft className="w-3.5 h-3.5" />
            {tr('Deposit Funds', 'إيداع الأموال')}
          </button>
          <button
            type="button"
            onClick={() => setMode('withdraw')}
            className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              mode === 'withdraw'
                ? 'bg-[#1E40AF] text-white shadow-xs'
                : 'text-slate-600 hover:text-[#0F172A]'
            }`}
          >
            <ArrowUpRight className="w-3.5 h-3.5" />
            {tr('Withdraw to Custody', 'السحب إلى الحفظ')}
          </button>
        </div>

        <div className="flex items-center gap-3">
          <label htmlFor="dw-terminal-select" className="text-xs font-medium text-slate-600 whitespace-nowrap">
            {tr('Target Terminal', 'المحطة المستهدفة')}
          </label>
          <select
            id="dw-terminal-select"
            value={activeTerminal?.id ?? ''}
            onChange={(e) => setTerminalUuid(e.target.value)}
            className="bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] rounded-lg px-3 py-2 text-xs font-mono text-[#0F172A] focus:outline-none"
          >
            {terminals.map((t) => (
              <option key={t.id} value={t.id}>
                {t.terminalId} ({t.label})
              </option>
            ))}
          </select>
        </div>
      </div>

      {mode === 'deposit' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
          {/* Start: Asset/Network Selector & Address */}
          <div className="lg:col-span-7 bg-white border border-[#E2E8F0] rounded-xl p-6 space-y-6 shadow-xs">
            <div>
              <h2 className="text-base font-semibold text-[#0F172A]">
                {tr('Inbound Chain Deposit Routing', 'توجيه الإيداعات الواردة من الشبكة')}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {tr('Unique deterministic custody address bound directly to', 'عنوان حفظ محدد مرتبط مباشرة بالمحطة')}{' '}
                <span className="font-mono tabular-nums text-[#1E40AF] font-semibold">
                  {activeTerminal?.terminalId}
                </span>
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <span className="block text-xs font-semibold text-[#0F172A]">{tr('Asset', 'الأصل')}</span>
                <div className="grid grid-cols-3 gap-1.5 bg-[#F4F7FA] p-1 border border-[#E2E8F0] rounded-lg">
                  {(['USDT', 'BTC', 'ETH'] as AssetSymbol[]).map((sym) => (
                    <button
                      key={sym}
                      type="button"
                      onClick={() => handleAssetChange(sym)}
                      className={`py-2 text-xs font-mono font-semibold rounded-md transition-colors ${
                        asset === sym
                          ? 'bg-[#1E40AF] text-white shadow-xs'
                          : 'text-slate-600 hover:text-[#0F172A]'
                      }`}
                    >
                      {sym}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <span className="block text-xs font-semibold text-[#0F172A]">
                  {tr('Settlement Network', 'شبكة التسوية')}
                </span>
                <div className="flex gap-1.5 bg-[#F4F7FA] p-1 border border-[#E2E8F0] rounded-lg">
                  {ASSET_NETWORKS[asset].map((net) => (
                    <button
                      key={net}
                      type="button"
                      onClick={() => setNetwork(net)}
                      className={`flex-1 py-2 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                        network === net
                          ? 'bg-[#1E40AF] text-white font-semibold shadow-xs'
                          : 'text-slate-600 hover:text-[#0F172A]'
                      }`}
                    >
                      {NETWORK_LABELS[net]}
                      {isSimulatedNetwork(net) ? ' (Sim)' : ' · Live'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {networkIsSimulated && (
              <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Simulated Network Rail ({networkLabel}):</span>{' '}
                  Live on-chain deposit polling and broadcasting currently cover{' '}
                  <span className="font-mono font-semibold text-[#0F172A]">USDT (TRC-20)</span> only.{' '}
                  {networkLabel} balances and transfers operate as ledger-only simulations.
                </div>
              </div>
            )}

            {/* Generated Address */}
            <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600 font-medium">
                  {asset} ({networkLabel}) {tr('Deposit Address', 'عنوان الإيداع')}
                </span>
                <span className="text-emerald-700 font-semibold inline-flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  {tr('Terminal Bound', 'مرتبط بالمحطة')}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <code className="font-mono tabular-nums text-xs sm:text-sm text-[#1E40AF] font-semibold break-all">
                  {depositAddress}
                </code>
                <button
                  type="button"
                  onClick={() =>
                    onCopy(depositAddress, `Copied ${asset} (${networkLabel}) deposit address`)
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#0F172A] bg-white hover:bg-slate-100 border border-[#E2E8F0] rounded-md transition-colors shrink-0 whitespace-nowrap"
                >
                  <Copy className="w-3.5 h-3.5 text-[#1E40AF]" />
                  {tr('Copy', 'نسخ')}
                </button>
              </div>
            </div>

            {authMode === 'supabase' ? (
              <div className="pt-4 border-t border-[#E2E8F0] space-y-3">
                <div className="flex items-center justify-between gap-2">
                  {networkIsSimulated ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                      <AlertCircle className="w-3.5 h-3.5" />
                      Simulated Rail — No External Chain Watcher
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                      <Radio className="w-3.5 h-3.5" />
                      Live Worker Deposit Monitoring Active
                    </span>
                  )}
                  <span className="font-mono tabular-nums text-[11px] text-slate-500">
                    {persistedDepositRecord
                      ? `deposit_addresses · ${persistedDepositRecord.id.slice(0, 8)}`
                      : 'Provisioning deposit_addresses row...'}
                  </span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  {networkIsSimulated ? (
                    <>
                      <code className="font-mono text-[#0F172A]">ntps-tron-worker</code> monitors{' '}
                      <strong className="text-[#0F172A]">USDT (TRC-20)</strong> deposits only.{' '}
                      {asset} ({networkLabel}) entries in{' '}
                      <code className="font-mono text-[#0F172A]">deposit_addresses</code> are reserved
                      for future chain-watcher adapters.
                    </>
                  ) : (
                    <>
                      Confirmed inbound {asset} ({networkLabel}) transfers sent to this address are
                      detected by <code className="font-mono text-[#0F172A]">ntps-tron-worker</code>{' '}
                      and credited via atomic{' '}
                      <code className="font-mono text-[#0F172A]">credit_crypto_deposit</code> with
                      Realtime balance updates.
                    </>
                  )}
                </p>
                <form onSubmit={handleBindCustomDepositAddress} className="flex flex-col sm:flex-row gap-2.5">
                  <input
                    type="text"
                    value={customDepositAddress}
                    onChange={(e) => setCustomDepositAddress(e.target.value)}
                    placeholder={`Bind custom ${networkLabel} watch address (optional)`}
                    className="flex-1 bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2 font-mono text-xs text-[#0F172A] placeholder:text-slate-400 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={isUpdatingAddr || customDepositAddress.trim().length < 12}
                    className="px-4 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] disabled:opacity-45 rounded-lg transition-colors whitespace-nowrap"
                  >
                    {isUpdatingAddr
                      ? tr('Binding...', 'جاري الربط...')
                      : tr('Register Watch Address', 'تسجيل عنوان المراقبة')}
                  </button>
                </form>
              </div>
            ) : (
              <form
                onSubmit={handleDepositSim}
                className="pt-4 border-t border-[#E2E8F0] space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#0F172A]">
                    {tr('Test On-Chain Deposit Settlement', 'اختبار تسوية إيداع على السلسلة')}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    {tr('Credits double-entry ledger immediately', 'يُقيد فوراً في دفتر القيد المزدوج')}
                  </span>
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="relative flex-1">
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={simDepositAmt}
                      onChange={(e) => setSimDepositAmt(e.target.value)}
                      className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg ps-3.5 pe-16 py-2.5 font-mono tabular-nums text-sm text-[#0F172A] focus:outline-none"
                    />
                    <span className="absolute end-3.5 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-500 font-semibold">
                      {asset}
                    </span>
                  </div>
                  <button
                    type="submit"
                    disabled={isDepositing}
                    className="px-5 py-2.5 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 shadow-xs"
                  >
                    {isDepositing
                      ? tr('Crediting...', 'جاري الإيداع...')
                      : tr('Simulate Confirmed Deposit', 'محاكاة إيداع مؤكد')}
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* End: Scannable QR & Protocol Rules — Cobalt Header + Snow White Body */}
          <div className="lg:col-span-5 bg-white border border-[#E2E8F0] rounded-xl overflow-hidden flex flex-col justify-between shadow-xs">
            <div className="cobalt-hero-surface px-6 py-4 text-center text-white border-b border-[#24489B]">
              <h3 className="text-sm font-semibold text-white">
                {tr('Scan to Fund Terminal', 'امسح الرمز لتمويل المحطة')}
              </h3>
              <p className="text-xs text-blue-100/85 mt-0.5">
                {asset} · {networkLabel}
              </p>
            </div>

            <div className="p-6 flex flex-col items-center gap-5 flex-1 justify-between">
              <div className="p-4 bg-white rounded-xl border border-[#E2E8F0] shadow-xs">
                <QRCodeSVG
                  value={depositAddress}
                  size={184}
                  level="M"
                  bgColor="#FFFFFF"
                  fgColor="#0F172A"
                />
              </div>

              <div className="w-full divide-y divide-[#E2E8F0] text-xs text-start border-t border-[#E2E8F0]">
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-slate-500">{tr('Required Confirmations', 'التأكيدات المطلوبة')}</span>
                  <span className="font-mono tabular-nums text-[#0F172A] font-medium">
                    {network === 'BTC' ? '2 Blocks' : network === 'TRC20' ? '19 Blocks' : '12 Blocks'}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-slate-500">{tr('Minimum Deposit', 'الحد الأدنى للإيداع')}</span>
                  <span className="font-mono tabular-nums text-[#0F172A] font-medium">
                    {asset === 'USDT' ? '10.00 USDT' : asset === 'BTC' ? '0.0005 BTC' : '0.01 ETH'}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-slate-500">{tr('Terminal Credit', 'المحطة المستلمة')}</span>
                  <span className="font-mono tabular-nums text-[#1E40AF] font-semibold">
                    {activeTerminal?.terminalId}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Withdrawal Form */}
          <div className="lg:col-span-7 bg-white border border-[#E2E8F0] rounded-xl p-6 space-y-6 shadow-xs">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-4">
              <div>
                <h2 className="text-base font-semibold text-[#0F172A]">
                  {tr('Whitelisted Custody Withdrawal', 'سحب إلى العناوين الموثقة')}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {tr(
                    'Dispatched exclusively to hardware-verified institutional destinations',
                    'يُرسل حصراً إلى وجهات الحفظ المؤسسية المعتمدة'
                  )}
                </p>
              </div>
              <span className="font-mono tabular-nums text-xs font-semibold text-[#1E40AF]">
                {tr('Avail:', 'المتاح:')} {formatAssetAmount(availableAssetBalance, asset)} {asset}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <span className="block text-xs font-semibold text-[#0F172A]">{tr('Asset', 'الأصل')}</span>
                <div className="grid grid-cols-3 gap-1.5 bg-[#F4F7FA] p-1 border border-[#E2E8F0] rounded-lg">
                  {(['USDT', 'BTC', 'ETH'] as AssetSymbol[]).map((sym) => (
                    <button
                      key={sym}
                      type="button"
                      onClick={() => handleAssetChange(sym)}
                      className={`py-2 text-xs font-mono font-semibold rounded-md transition-colors ${
                        asset === sym
                          ? 'bg-[#1E40AF] text-white shadow-xs'
                          : 'text-slate-600 hover:text-[#0F172A]'
                      }`}
                    >
                      {sym}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <span className="block text-xs font-semibold text-[#0F172A]">{tr('Network', 'الشبكة')}</span>
                <div className="flex gap-1.5 bg-[#F4F7FA] p-1 border border-[#E2E8F0] rounded-lg">
                  {ASSET_NETWORKS[asset].map((net) => (
                    <button
                      key={net}
                      type="button"
                      onClick={() => setNetwork(net)}
                      className={`flex-1 py-2 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                        network === net
                          ? 'bg-[#1E40AF] text-white font-semibold shadow-xs'
                          : 'text-slate-600 hover:text-[#0F172A]'
                      }`}
                    >
                      {NETWORK_LABELS[net]}
                      {isSimulatedNetwork(net) ? ' (Sim)' : ' · Live'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {networkIsSimulated && (
              <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Simulated Withdrawal Rail ({networkLabel}):</span>{' '}
                  Automated on-chain worker broadcasting (
                  <code className="font-mono text-[#0F172A]">ntps-tron-worker</code>) is live for{' '}
                  <span className="font-mono font-semibold text-[#0F172A]">USDT (TRC-20)</span> only.{' '}
                  {networkLabel} withdrawals are recorded in the ledger without external chain broadcast.
                </div>
              </div>
            )}

            {/* Whitelist Address Selector */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="wd-whitelist" className="text-xs font-semibold text-[#0F172A]">
                  {tr('Whitelisted Destination', 'الوجهة المعتمدة')} ({networkLabel})
                </label>
                <button
                  type="button"
                  onClick={() => setShowAddWhitelist((v) => !v)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[#1E40AF] hover:text-[#24489B]"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {showAddWhitelist ? tr('Close', 'إغلاق') : tr('Add Whitelist Address', 'إضافة عنوان معتمد')}
                </button>
              </div>

              {matchingWhitelist.length > 0 ? (
                <select
                  id="wd-whitelist"
                  value={selectedWhitelistId}
                  onChange={(e) => setSelectedWhitelistId(e.target.value)}
                  className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2.5 text-xs font-mono text-[#0F172A] focus:outline-none"
                >
                  {matchingWhitelist.map((wl) => (
                    <option key={wl.id} value={wl.id}>
                      {wl.label} — {wl.address}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-900">
                  {tr('No whitelisted addresses for', 'لا توجد عناوين معتمدة لـ')} {asset} ({networkLabel}).{' '}
                  {tr('Add one above to withdraw.', 'أضف عنواناً أعلاه لإجراء السحب.')}
                </div>
              )}

              {showAddWhitelist && (
                <form
                  onSubmit={handleAddWhitelistSubmit}
                  className="bg-[#F4F7FA] border border-[#E2E8F0] rounded-lg p-4 space-y-3 mt-2"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input
                      type="text"
                      value={newWlLabel}
                      onChange={(e) => setNewWlLabel(e.target.value)}
                      placeholder={tr('Custody Vault Label', 'تسمية خزينة الحفظ')}
                      className="bg-white border border-[#E2E8F0] rounded-md px-3 py-2 text-xs text-[#0F172A] focus:border-[#1E40AF] focus:outline-none"
                    />
                    <input
                      type="text"
                      value={newWlAddress}
                      onChange={(e) => setNewWlAddress(e.target.value)}
                      placeholder={`${networkLabel} Destination Address`}
                      className="bg-white border border-[#E2E8F0] rounded-md px-3 py-2 font-mono text-xs text-[#0F172A] focus:border-[#1E40AF] focus:outline-none"
                    />
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      className="px-3.5 py-1.5 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-md"
                    >
                      {tr('Verify & Save Whitelist', 'تحقق وحفظ العنوان')}
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* Amount */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="wd-amount" className="font-semibold text-[#0F172A]">
                  {tr('Withdrawal Amount', 'مبلغ السحب')}
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const maxNet = Math.max(0, Number((availableAssetBalance - feeInfo.amount).toFixed(6)));
                    setWithdrawAmount(String(maxNet));
                  }}
                  className="font-mono tabular-nums text-[#1E40AF] hover:text-[#24489B] font-medium"
                >
                  {tr('Max Net:', 'أقصى صافي:')}{' '}
                  {formatAssetAmount(Math.max(0, availableAssetBalance - feeInfo.amount), asset)} {asset}
                </button>
              </div>
              <div className="relative">
                <input
                  id="wd-amount"
                  type="number"
                  step="any"
                  min="0"
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg ps-3.5 pe-16 py-2.5 font-mono tabular-nums text-sm text-[#0F172A] focus:outline-none"
                />
                <span className="absolute end-3.5 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-500 font-semibold">
                  {asset}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono tabular-nums text-[#1E40AF] font-semibold">
                  ≈ {formatUsd(withdrawUsd)}
                </span>
                {exceedsAvail && (
                  <span className="text-red-600 font-medium">
                    {tr('Insufficient balance (incl. network fee)', 'الرصيد غير كافٍ (شاملاً رسوم الشبكة)')}
                  </span>
                )}
                {!exceedsAvail && exceedsDailyLimit && (
                  <span className="text-red-600 font-medium">
                    {tr('Exceeds remaining daily quota', 'يتجاوز الحصة اليومية المتبقية')}
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="wd-memo" className="block text-xs font-semibold text-[#0F172A]">
                {tr('Audit Reference (Optional)', 'مرجع التدقيق (اختياري)')}
              </label>
              <input
                id="wd-memo"
                type="text"
                value={withdrawMemo}
                onChange={(e) => setWithdrawMemo(e.target.value)}
                placeholder={tr('e.g. Monthly Cold Vault Sweep', 'مثال: تحويل شهري للخزينة الباردة')}
                className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2.5 text-sm text-[#0F172A] focus:outline-none"
              />
            </div>

            <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-[#F4F7FA] border border-[#E2E8F0] text-xs">
              <ShieldCheck className="w-4 h-4 text-[#1E40AF] shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-[#0F172A]">
                  {tr('Mandatory Four-Eyes Compliance Queue', 'قائمة مراجعة الامتثال المزدوجة الإلزامية')}
                </div>
                <div className="text-[11px] text-slate-600 mt-0.5">
                  All operator withdrawal requests enter <code className="font-mono text-[#0F172A]">review</code> state and require independent <code className="font-mono text-[#0F172A]">ops</code>/<code className="font-mono text-[#0F172A]">compliance</code> sign-off before worker broadcast.
                </div>
              </div>
            </div>

            {!isKycApproved && (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-lg bg-amber-50 border border-amber-200 text-xs">
                <div className="flex items-start gap-2.5 text-amber-900">
                  <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">
                      {tr('External Withdrawals Locked', 'السحوبات الخارجية مقفلة')} (KYC: {kycStatus.replace('_', ' ')})
                    </div>
                    <div className="text-[11px] text-amber-800 mt-0.5">
                      {tr(
                        'Complete and obtain compliance approval on your Individual KYC or Corporate KYB dossier before dispatching funds to custody addresses.',
                        'أكمل ملف التوثيق واحصل على موافقة الامتثال قبل إرسال الأموال خارجياً.'
                      )}
                    </div>
                  </div>
                </div>
                {onNavigateToKyc && (
                  <button
                    type="button"
                    onClick={onNavigateToKyc}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg whitespace-nowrap shrink-0"
                  >
                    <UserCheck className="w-3.5 h-3.5" />
                    {kycStatus === 'pending_review'
                      ? tr('View KYC Status', 'عرض حالة التوثيق')
                      : tr('Complete KYC Verification', 'إكمال التوثيق')}
                  </button>
                )}
              </div>
            )}

            <button
              type="button"
              disabled={!canWithdraw}
              onClick={() => setIs2FaOpen(true)}
              className="w-full py-3 px-5 text-sm font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors shadow-xs"
            >
              {isKycApproved
                ? tr('Authorize External Withdrawal', 'اعتماد السحب الخارجي')
                : tr('KYC Approval Required to Withdraw', 'موافقة التوثيق مطلوبة للسحب')}
            </button>
          </div>

          {/* End: Dynamic Network Fee & Daily Limit Progress */}
          <div className="lg:col-span-5 space-y-5">
            <div className="bg-white border border-[#E2E8F0] rounded-xl p-6 space-y-4 shadow-xs">
              <h3 className="text-sm font-semibold text-[#0F172A]">
                {tr('Fee & Settlement Summary', 'ملخص الرسوم والتسوية')}
              </h3>

              <div className="divide-y divide-[#E2E8F0] text-xs">
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-slate-500">{tr('Network Rail', 'مسار الشبكة')}</span>
                  <span className="text-[#0F172A] font-medium">{networkLabel}</span>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-slate-500">{tr('Estimated Finality', 'زمن التأكيد المتوقع')}</span>
                  <span className="font-mono text-[#0F172A]">{feeInfo.eta}</span>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-slate-500">{tr('Dynamic Network Fee', 'رسوم الشبكة الديناميكية')}</span>
                  <span className="font-mono tabular-nums text-[#0F172A]">
                    {feeInfo.amount} {feeInfo.asset} ({formatUsd(feeInfo.amount * assetRates[feeInfo.asset])})
                  </span>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-slate-500">{tr('Total Ledger Debit', 'إجمالي الخصم من الدفتر')}</span>
                  <span className="font-mono tabular-nums text-[#1E40AF] font-bold">
                    {formatAssetAmount(totalDebit, asset)} {asset}
                  </span>
                </div>
              </div>
            </div>

            <div className="bg-white border border-[#E2E8F0] rounded-xl p-6 space-y-4 shadow-xs">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[#0F172A]">
                  {tr('Daily Withdrawal Limit', 'حد السحب اليومي')}
                </h3>
                {exceedsDailyLimit ? (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700">
                    <AlertCircle className="w-3.5 h-3.5" />
                    {tr('Limit Exceeded', 'تم تجاوز الحد')}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {tr('Within Quota', 'ضمن الحصة')}
                  </span>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                  <span className="text-[#0F172A] font-medium">
                    {tr('Used:', 'المستخدم:')} {formatUsd(dailyWithdrawnUsd)}
                  </span>
                  <span className="text-slate-500">
                    {tr('Cap:', 'السقف:')} {formatUsd(dailyLimitUsd)}
                  </span>
                </div>

                <div className="relative h-2.5 w-full bg-[#F4F7FA] rounded-full overflow-hidden border border-[#E2E8F0]">
                  <div
                    className="absolute start-0 top-0 bottom-0 bg-[#1E40AF] transition-all duration-300"
                    style={{ width: `${currentDailyPct}%` }}
                  />
                  {withdrawUsd > 0 && (
                    <div
                      className={`absolute top-0 bottom-0 transition-all duration-300 ${
                        exceedsDailyLimit ? 'bg-red-500' : 'bg-[#D6FF3D]'
                      }`}
                      style={{
                        insetInlineStart: `${currentDailyPct}%`,
                        width: `${Math.max(0, projectedDailyPct - currentDailyPct)}%`,
                      }}
                    />
                  )}
                </div>

                <p className="text-xs text-slate-500 font-mono tabular-nums">
                  {tr('Remaining today:', 'المتبقي اليوم:')} {formatUsd(Math.max(0, dailyLimitUsd - dailyWithdrawnUsd))}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      <TwoFactorModal
        open={is2FaOpen}
        title={tr('Authorize External Withdrawal', 'اعتماد السحب الخارجي')}
        subtitle={tr('Confirm custody dispatch with 6-digit authenticator token', 'تأكيد إرسال الحفظ برمز المصادقة المكون من 6 أرقام')}
        confirmLabel={tr('Dispatch Withdrawal', 'إرسال السحب')}
        isSubmitting={isWithdrawing}
        onClose={() => setIs2FaOpen(false)}
        onConfirm={handleConfirmWithdrawal}
        summaryRows={[
          { label: tr('Source Terminal', 'المحطة المصدر'), value: activeTerminal?.terminalId ?? '', mono: true },
          { label: tr('Destination Label', 'تسمية الوجهة'), value: selectedWhitelist?.label ?? '' },
          {
            label: tr('Destination Address', 'عنوان الوجهة'),
            value: selectedWhitelist?.address ?? '',
            mono: true,
            highlight: 'cyan',
          },
          {
            label: tr('Net Withdrawal', 'صافي السحب'),
            value: `${formatAssetAmount(parsedWithdraw || 0, asset)} ${asset}`,
            mono: true,
            highlight: 'gold',
          },
          {
            label: tr('Network Fee', 'رسوم الشبكة'),
            value: `${feeInfo.amount} ${feeInfo.asset} (${networkLabel})`,
            mono: true,
          },
        ]}
      />
    </div>
  );
}
