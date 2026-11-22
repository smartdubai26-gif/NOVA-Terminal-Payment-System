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
  const isKycApproved = kycStatus === 'approved';
  const [mode, setMode] = useState<'deposit' | 'withdraw'>(initialMode);
  const [terminalUuid, setTerminalUuid] = useState(terminals[0]?.id ?? '');
  const [asset, setAsset] = useState<AssetSymbol>(initialAsset);
  const [network, setNetwork] = useState<NetworkId>(ASSET_NETWORKS[initialAsset][0]);

  // Deposit simulation / custom live address state
  const [simDepositAmt, setSimDepositAmt] = useState('25000');
  const [isDepositing, setIsDepositing] = useState(false);
  const [customDepositAddress, setCustomDepositAddress] = useState('');
  const [isUpdatingAddr, setIsUpdatingAddr] = useState(false);
  const ensuredKeysRef = useRef<Set<string>>(new Set());

  // Withdrawal state
  const [selectedWhitelistId, setSelectedWhitelistId] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawMemo, setWithdrawMemo] = useState('');
  const [is2FaOpen, setIs2FaOpen] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);

  // Add Whitelist inline state
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
      onToast('Invalid amount', 'Enter a positive deposit amount.', 'error');
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
        'Deposit settled to terminal',
        `+${formatAssetAmount(amt, asset)} ${asset} credited via ${networkLabel}`,
        'success'
      );
    } catch (err) {
      onToast(
        'Deposit simulation failed',
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
      onToast('Invalid address', 'Enter a valid on-chain deposit address.', 'error');
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
        'Deposit address registered',
        `${asset} (${networkLabel}) bound in deposit_addresses for worker polling`,
        'success'
      );
    } catch (err) {
      onToast(
        'Failed to bind deposit address',
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
        'KYC verification required',
        'Complete KYC/KYB approval before submitting external withdrawals.',
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
        'Withdrawal queued for compliance review',
        `${formatAssetAmount(parsedWithdraw, asset)} ${asset} to ${selectedWhitelist.label}`,
        'success'
      );
    } catch (err) {
      onToast(
        'Withdrawal failed',
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
      onToast('Invalid whitelist entry', 'Provide a custody label and valid destination address.', 'error');
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
    onToast('Whitelist address added', `${asset} (${networkLabel}) custody destination verified.`, 'success');
  };

  return (
    <div className="space-y-6">
      {/* Top Mode & Terminal Controls */}
      <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-[#05070A] border border-white/[0.08] rounded-lg">
          <button
            type="button"
            onClick={() => setMode('deposit')}
            className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              mode === 'deposit'
                ? 'bg-[#00E5FF] text-[#05070A]'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            <ArrowDownLeft className="w-3.5 h-3.5" />
            Deposit Funds
          </button>
          <button
            type="button"
            onClick={() => setMode('withdraw')}
            className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              mode === 'withdraw'
                ? 'bg-[#00E5FF] text-[#05070A]'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            <ArrowUpRight className="w-3.5 h-3.5" />
            Withdraw to Custody
          </button>
        </div>

        <div className="flex items-center gap-3">
          <label htmlFor="dw-terminal-select" className="text-xs text-slate-400 whitespace-nowrap">
            Target Terminal
          </label>
          <select
            id="dw-terminal-select"
            value={activeTerminal?.id ?? ''}
            onChange={(e) => setTerminalUuid(e.target.value)}
            className="bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none"
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
          {/* Left: Asset/Network Selector & Address */}
          <div className="lg:col-span-7 bg-[#0B0F16] border border-white/[0.08] rounded-xl p-6 space-y-6">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Inbound Chain Deposit Routing
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Unique deterministic custody address bound directly to{' '}
                <span className="font-mono text-[#00E5FF]">{activeTerminal?.terminalId}</span>
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <span className="block text-xs font-medium text-slate-300">Asset</span>
                <div className="grid grid-cols-3 gap-1.5 bg-[#05070A] p-1 border border-white/[0.1] rounded-lg">
                  {(['USDT', 'BTC', 'ETH'] as AssetSymbol[]).map((sym) => (
                    <button
                      key={sym}
                      type="button"
                      onClick={() => handleAssetChange(sym)}
                      className={`py-2 text-xs font-mono font-semibold rounded-md transition-colors ${
                        asset === sym
                          ? 'bg-[#00E5FF] text-[#05070A]'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      {sym}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <span className="block text-xs font-medium text-slate-300">Settlement Network</span>
                <div className="flex gap-1.5 bg-[#05070A] p-1 border border-white/[0.1] rounded-lg">
                  {ASSET_NETWORKS[asset].map((net) => (
                    <button
                      key={net}
                      type="button"
                      onClick={() => setNetwork(net)}
                      className={`flex-1 py-2 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                        network === net
                          ? 'bg-white/[0.12] text-white'
                          : 'text-slate-400 hover:text-slate-200'
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
              <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-xs text-amber-200">
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Simulated Network Rail ({networkLabel}):</span>{' '}
                  Live on-chain deposit polling and broadcasting currently cover{' '}
                  <span className="font-mono font-semibold text-white">USDT (TRC-20)</span> only.{' '}
                  {networkLabel} balances and transfers operate as ledger-only simulations.
                </div>
              </div>
            )}

            {/* Generated Address */}
            <div className="bg-[#05070A] border border-white/[0.1] rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">
                  {asset} ({networkLabel}) Deposit Address
                </span>
                <span className="text-emerald-400 inline-flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Terminal Bound
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <code className="font-mono text-xs sm:text-sm text-[#00E5FF] break-all">
                  {depositAddress}
                </code>
                <button
                  type="button"
                  onClick={() => onCopy(depositAddress, `Copied ${asset} (${networkLabel}) deposit address`)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-100 bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] rounded-md transition-colors shrink-0 whitespace-nowrap"
                >
                  <Copy className="w-3.5 h-3.5" />
                  Copy
                </button>
              </div>
            </div>

            {authMode === 'supabase' ? (
              <div className="pt-4 border-t border-white/[0.07] space-y-3">
                <div className="flex items-center justify-between gap-2">
                  {networkIsSimulated ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-300">
                      <AlertCircle className="w-3.5 h-3.5" />
                      Simulated Rail — No External Chain Watcher
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                      <Radio className="w-3.5 h-3.5" />
                      Live Worker Deposit Monitoring Active
                    </span>
                  )}
                  <span className="font-mono text-[11px] text-slate-400">
                    {persistedDepositRecord
                      ? `deposit_addresses · ${persistedDepositRecord.id.slice(0, 8)}`
                      : 'Provisioning deposit_addresses row...'}
                  </span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  {networkIsSimulated ? (
                    <>
                      <code className="font-mono text-slate-200">ntps-tron-worker</code> monitors{' '}
                      <strong className="text-slate-200">USDT (TRC-20)</strong> deposits only.{' '}
                      {asset} ({networkLabel}) entries in <code className="font-mono text-slate-200">deposit_addresses</code>{' '}
                      are reserved for future chain-watcher adapters.
                    </>
                  ) : (
                    <>
                      Confirmed inbound {asset} ({networkLabel}) transfers sent to this address are
                      detected by <code className="font-mono text-slate-200">ntps-tron-worker</code>{' '}
                      and credited via atomic <code className="font-mono text-slate-200">credit_crypto_deposit</code>{' '}
                      with Realtime balance updates.
                    </>
                  )}
                </p>
                <form onSubmit={handleBindCustomDepositAddress} className="flex flex-col sm:flex-row gap-2.5">
                  <input
                    type="text"
                    value={customDepositAddress}
                    onChange={(e) => setCustomDepositAddress(e.target.value)}
                    placeholder={`Bind custom ${networkLabel} watch address (optional)`}
                    className="flex-1 bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2 font-mono text-xs text-slate-100 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={isUpdatingAddr || customDepositAddress.trim().length < 12}
                    className="px-4 py-2 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] disabled:opacity-45 rounded-lg transition-colors whitespace-nowrap"
                  >
                    {isUpdatingAddr ? 'Binding...' : 'Register Watch Address'}
                  </button>
                </form>
              </div>
            ) : (
              <form
                onSubmit={handleDepositSim}
                className="pt-4 border-t border-white/[0.07] space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-300">
                    Test On-Chain Deposit Settlement
                  </span>
                  <span className="text-[11px] text-slate-400">
                    Credits double-entry ledger immediately
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
                      className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 pr-16 font-mono tabular-nums text-sm text-slate-100 focus:outline-none"
                    />
                    <span className="absolute right-3.5 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                      {asset}
                    </span>
                  </div>
                  <button
                    type="submit"
                    disabled={isDepositing}
                    className="px-5 py-2.5 text-xs font-semibold text-[#05070A] bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    {isDepositing ? 'Crediting...' : 'Simulate Confirmed Deposit'}
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* Right: Scannable QR & Protocol Rules */}
          <div className="lg:col-span-5 bg-[#0B0F16] border border-white/[0.08] rounded-xl p-6 flex flex-col items-center justify-between text-center space-y-5">
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-slate-100">
                Scan to Fund Terminal
              </h3>
              <p className="text-xs text-slate-400">
                {asset} on {networkLabel}
              </p>
            </div>

            <div className="p-4 bg-white rounded-xl">
              <QRCodeSVG
                value={depositAddress}
                size={184}
                level="M"
                bgColor="#FFFFFF"
                fgColor="#05070A"
              />
            </div>

            <div className="w-full divide-y divide-white/[0.06] text-xs text-left border-t border-white/[0.06]">
              <div className="flex items-center justify-between py-2.5">
                <span className="text-slate-400">Required Confirmations</span>
                <span className="font-mono text-slate-200">
                  {network === 'BTC' ? '2 Blocks' : network === 'TRC20' ? '19 Blocks' : '12 Blocks'}
                </span>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <span className="text-slate-400">Minimum Deposit</span>
                <span className="font-mono text-slate-200">
                  {asset === 'USDT' ? '10.00 USDT' : asset === 'BTC' ? '0.0005 BTC' : '0.01 ETH'}
                </span>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <span className="text-slate-400">Terminal Credit</span>
                <span className="font-mono text-[#00E5FF]">{activeTerminal?.terminalId}</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Withdrawal Form */}
          <div className="lg:col-span-7 bg-[#0B0F16] border border-white/[0.08] rounded-xl p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-white/[0.07] pb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-100">
                  Whitelisted Custody Withdrawal
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Dispatched exclusively to hardware-verified institutional destinations
                </p>
              </div>
              <span className="font-mono tabular-nums text-xs text-slate-300">
                Avail: {formatAssetAmount(availableAssetBalance, asset)} {asset}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <span className="block text-xs font-medium text-slate-300">Asset</span>
                <div className="grid grid-cols-3 gap-1.5 bg-[#05070A] p-1 border border-white/[0.1] rounded-lg">
                  {(['USDT', 'BTC', 'ETH'] as AssetSymbol[]).map((sym) => (
                    <button
                      key={sym}
                      type="button"
                      onClick={() => handleAssetChange(sym)}
                      className={`py-2 text-xs font-mono font-semibold rounded-md transition-colors ${
                        asset === sym
                          ? 'bg-[#00E5FF] text-[#05070A]'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      {sym}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <span className="block text-xs font-medium text-slate-300">Network</span>
                <div className="flex gap-1.5 bg-[#05070A] p-1 border border-white/[0.1] rounded-lg">
                  {ASSET_NETWORKS[asset].map((net) => (
                    <button
                      key={net}
                      type="button"
                      onClick={() => setNetwork(net)}
                      className={`flex-1 py-2 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                        network === net
                          ? 'bg-white/[0.12] text-white'
                          : 'text-slate-400 hover:text-slate-200'
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
              <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-xs text-amber-200">
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Simulated Withdrawal Rail ({networkLabel}):</span>{' '}
                  Automated on-chain worker broadcasting (<code className="font-mono text-white">ntps-tron-worker</code>) is{' '}
                  live for <span className="font-mono font-semibold text-white">USDT (TRC-20)</span> only.{' '}
                  {networkLabel} withdrawals are recorded in the ledger without external chain broadcast.
                </div>
              </div>
            )}

            {/* Whitelist Address Selector */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="wd-whitelist" className="text-xs font-medium text-slate-300">
                  Whitelisted Destination ({networkLabel})
                </label>
                <button
                  type="button"
                  onClick={() => setShowAddWhitelist((v) => !v)}
                  className="inline-flex items-center gap-1 text-xs text-[#00E5FF] hover:text-[#5ceeff]"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {showAddWhitelist ? 'Close' : 'Add Whitelist Address'}
                </button>
              </div>

              {matchingWhitelist.length > 0 ? (
                <select
                  id="wd-whitelist"
                  value={selectedWhitelistId}
                  onChange={(e) => setSelectedWhitelistId(e.target.value)}
                  className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 text-xs font-mono text-slate-100 focus:outline-none"
                >
                  {matchingWhitelist.map((wl) => (
                    <option key={wl.id} value={wl.id}>
                      {wl.label} — {wl.address}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="bg-[#05070A] border border-amber-500/30 rounded-lg px-4 py-3 text-xs text-amber-300">
                  No whitelisted addresses for {asset} ({networkLabel}). Add one above to withdraw.
                </div>
              )}

              {showAddWhitelist && (
                <form
                  onSubmit={handleAddWhitelistSubmit}
                  className="bg-[#05070A] border border-white/[0.1] rounded-lg p-4 space-y-3 mt-2"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input
                      type="text"
                      value={newWlLabel}
                      onChange={(e) => setNewWlLabel(e.target.value)}
                      placeholder="Custody Vault Label"
                      className="bg-[#0B0F16] border border-white/[0.12] rounded-md px-3 py-2 text-xs text-slate-100 focus:border-[#00E5FF] focus:outline-none"
                    />
                    <input
                      type="text"
                      value={newWlAddress}
                      onChange={(e) => setNewWlAddress(e.target.value)}
                      placeholder={`${networkLabel} Destination Address`}
                      className="bg-[#0B0F16] border border-white/[0.12] rounded-md px-3 py-2 font-mono text-xs text-slate-100 focus:border-[#00E5FF] focus:outline-none"
                    />
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      className="px-3.5 py-1.5 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] rounded-md"
                    >
                      Verify & Save Whitelist
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* Amount */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="wd-amount" className="font-medium text-slate-300">
                  Withdrawal Amount
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const maxNet = Math.max(0, Number((availableAssetBalance - feeInfo.amount).toFixed(6)));
                    setWithdrawAmount(String(maxNet));
                  }}
                  className="font-mono text-slate-400 hover:text-[#00E5FF]"
                >
                  Max Net: {formatAssetAmount(Math.max(0, availableAssetBalance - feeInfo.amount), asset)} {asset}
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
                  className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 pr-16 font-mono tabular-nums text-sm text-slate-100 focus:outline-none"
                />
                <span className="absolute right-3.5 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                  {asset}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono tabular-nums text-[#F5C542]">
                  ≈ {formatUsd(withdrawUsd)}
                </span>
                {exceedsAvail && (
                  <span className="text-red-400">Insufficient balance (incl. network fee)</span>
                )}
                {!exceedsAvail && exceedsDailyLimit && (
                  <span className="text-red-400">Exceeds remaining daily quota</span>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="wd-memo" className="block text-xs font-medium text-slate-300">
                Audit Reference (Optional)
              </label>
              <input
                id="wd-memo"
                type="text"
                value={withdrawMemo}
                onChange={(e) => setWithdrawMemo(e.target.value)}
                placeholder="e.g. Monthly Cold Vault Sweep"
                className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 text-sm text-slate-100 focus:outline-none"
              />
            </div>

            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-[#05070A] border border-white/[0.08] text-xs">
              <ShieldCheck className="w-4 h-4 text-[#00E5FF] shrink-0 mt-0.5" />
              <div>
                <div className="font-medium text-slate-200">
                  Mandatory Four-Eyes Compliance Queue
                </div>
                <div className="text-[11px] text-slate-400 mt-0.5">
                  All operator withdrawal requests enter <code className="font-mono text-slate-200">review</code> state and require independent <code className="font-mono text-slate-200">ops</code>/<code className="font-mono text-slate-200">compliance</code> sign-off before worker broadcast.
                </div>
              </div>
            </div>

            {!isKycApproved && (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs">
                <div className="flex items-start gap-2.5 text-amber-100">
                  <AlertCircle className="w-4 h-4 text-[#F5C542] shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">
                      External Withdrawals Locked (KYC Status: {kycStatus.replace('_', ' ')})
                    </div>
                    <div className="text-[11px] text-amber-200/80 mt-0.5">
                      Complete and obtain compliance approval on your Individual KYC or Corporate KYB
                      dossier before dispatching funds to custody addresses.
                    </div>
                  </div>
                </div>
                {onNavigateToKyc && (
                  <button
                    type="button"
                    onClick={onNavigateToKyc}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#05070A] bg-[#F5C542] hover:bg-[#ffd666] rounded-lg whitespace-nowrap shrink-0"
                  >
                    <UserCheck className="w-3.5 h-3.5" />
                    {kycStatus === 'pending_review' ? 'View KYC Status' : 'Complete KYC Verification'}
                  </button>
                )}
              </div>
            )}

            <button
              type="button"
              disabled={!canWithdraw}
              onClick={() => setIs2FaOpen(true)}
              className="w-full py-3 px-5 text-sm font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors"
            >
              {isKycApproved
                ? 'Authorize External Withdrawal'
                : 'KYC Approval Required to Withdraw'}
            </button>
          </div>

          {/* Right: Dynamic Network Fee & Daily Limit Progress */}
          <div className="lg:col-span-5 space-y-5">
            <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl p-6 space-y-4">
              <h3 className="text-sm font-semibold text-slate-100">Fee & Settlement Summary</h3>

              <div className="divide-y divide-white/[0.06] text-xs">
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-slate-400">Network Rail</span>
                  <span className="text-slate-200 font-medium">{networkLabel}</span>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-slate-400">Estimated Finality</span>
                  <span className="font-mono text-slate-200">{feeInfo.eta}</span>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-slate-400">Dynamic Network Fee</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {feeInfo.amount} {feeInfo.asset} ({formatUsd(feeInfo.amount * assetRates[feeInfo.asset])})
                  </span>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-slate-400">Total Ledger Debit</span>
                  <span className="font-mono tabular-nums text-[#F5C542] font-semibold">
                    {formatAssetAmount(totalDebit, asset)} {asset}
                  </span>
                </div>
              </div>
            </div>

            <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-100">Daily Withdrawal Limit</h3>
                {exceedsDailyLimit ? (
                  <span className="inline-flex items-center gap-1 text-xs text-red-400">
                    <AlertCircle className="w-3.5 h-3.5" />
                    Limit Exceeded
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Within Quota
                  </span>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                  <span className="text-slate-300">
                    Used: {formatUsd(dailyWithdrawnUsd)}
                  </span>
                  <span className="text-slate-400">
                    Cap: {formatUsd(dailyLimitUsd)}
                  </span>
                </div>

                <div className="relative h-2.5 w-full bg-[#05070A] rounded-full overflow-hidden border border-white/[0.08]">
                  <div
                    className="absolute left-0 top-0 bottom-0 bg-[#00E5FF] transition-all duration-300"
                    style={{ width: `${currentDailyPct}%` }}
                  />
                  {withdrawUsd > 0 && (
                    <div
                      className={`absolute top-0 bottom-0 transition-all duration-300 ${
                        exceedsDailyLimit ? 'bg-red-500/80' : 'bg-[#F5C542]/80'
                      }`}
                      style={{
                        left: `${currentDailyPct}%`,
                        width: `${Math.max(0, projectedDailyPct - currentDailyPct)}%`,
                      }}
                    />
                  )}
                </div>

                <p className="text-xs text-slate-400 font-mono tabular-nums">
                  Remaining today: {formatUsd(Math.max(0, dailyLimitUsd - dailyWithdrawnUsd))}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      <TwoFactorModal
        open={is2FaOpen}
        title="Authorize External Withdrawal"
        subtitle="Confirm custody dispatch with 6-digit authenticator token"
        confirmLabel="Dispatch Withdrawal"
        isSubmitting={isWithdrawing}
        onClose={() => setIs2FaOpen(false)}
        onConfirm={handleConfirmWithdrawal}
        summaryRows={[
          { label: 'Source Terminal', value: activeTerminal?.terminalId ?? '', mono: true },
          { label: 'Destination Label', value: selectedWhitelist?.label ?? '' },
          { label: 'Destination Address', value: selectedWhitelist?.address ?? '', mono: true, highlight: 'cyan' },
          {
            label: 'Net Withdrawal',
            value: `${formatAssetAmount(parsedWithdraw || 0, asset)} ${asset}`,
            mono: true,
            highlight: 'gold',
          },
          {
            label: 'Network Fee',
            value: `${feeInfo.amount} ${feeInfo.asset} (${networkLabel})`,
            mono: true,
          },
        ]}
      />
    </div>
  );
}
