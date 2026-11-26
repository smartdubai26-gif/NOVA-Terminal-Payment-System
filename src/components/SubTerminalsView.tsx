import { useState, useMemo } from 'react';
import {
  Copy,
  GitBranch,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  CheckCircle2,
  AlertTriangle,
  ArrowRightLeft,
  UserCheck,
} from 'lucide-react';
import type {
  AssetRateMap,
  AssetSymbol,
  KycStatus,
  TerminalRecord,
  TerminalStatus,
  WalletBalance,
} from '../types/ntps';
import { ASSET_USD_RATES, computePortfolioUsd, getTerminalAssetTotal } from '../lib/ledgerEngine';
import {
  generateMasterTerminalId,
  generateSubTerminalId,
  normalizeTerminalIdInput,
  validateTerminalId,
} from '../lib/terminalId';
import { formatAssetAmount, formatUsd } from '../lib/format';
import { useLocale } from '../context/LocaleContext';

interface SubTerminalsViewProps {
  terminals: TerminalRecord[];
  wallets: WalletBalance[];
  assetRates?: AssetRateMap;
  kycStatus?: KycStatus;
  onNavigateToKyc?: () => void;
  onProvisionSub: (params: {
    label: string;
    dailyLimitUsd: number;
    perTxLimitUsd: number;
    allowedAssets: AssetSymbol[];
  }) => Promise<void>;
  onUpdatePolicy: (params: {
    terminalUuid: string;
    status?: TerminalStatus;
    dailyLimitUsd?: number;
    perTxLimitUsd?: number;
    allowedAssets?: AssetSymbol[];
  }) => Promise<void>;
  onRebalance: (params: {
    sourceTerminalUuid: string;
    recipientTerminalId: string;
    asset: AssetSymbol;
    amount: number;
    memo: string;
  }) => Promise<void>;
  onCopy: (text: string, label: string) => void;
  onToast: (title: string, description?: string, variant?: 'success' | 'error' | 'info') => void;
}

export function SubTerminalsView({
  terminals,
  wallets,
  assetRates = ASSET_USD_RATES,
  kycStatus = 'unverified',
  onNavigateToKyc,
  onProvisionSub,
  onUpdatePolicy,
  onRebalance,
  onCopy,
  onToast,
}: SubTerminalsViewProps) {
  const { tr } = useLocale();
  const isKycApproved = kycStatus === 'approved';
  const masterTerminal = terminals.find((t) => t.type === 'master') ?? terminals[0];
  const subTerminals = terminals.filter((t) => t.type === 'sub');

  const [showProvisionForm, setShowProvisionForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newDailyLimit, setNewDailyLimit] = useState('150000');
  const [newPerTxLimit, setNewPerTxLimit] = useState('50000');
  const [newAllowedAssets, setNewAllowedAssets] = useState<AssetSymbol[]>(['USDT', 'ETH']);
  const [isProvisioning, setIsProvisioning] = useState(false);

  const [editingSubUuid, setEditingSubUuid] = useState<string | null>(null);
  const [editDaily, setEditDaily] = useState('');
  const [editPerTx, setEditPerTx] = useState('');
  const [editAssets, setEditAssets] = useState<AssetSymbol[]>([]);

  const [rebalanceSubUuid, setRebalanceSubUuid] = useState<string | null>(null);
  const [rebalanceDirection, setRebalanceDirection] = useState<'fund' | 'recall'>('fund');
  const [rebalanceAsset, setRebalanceAsset] = useState<AssetSymbol>('USDT');
  const [rebalanceAmount, setRebalanceAmount] = useState('10000');
  const [isRebalancing, setIsRebalancing] = useState(false);

  const [labInput, setLabInput] = useState(masterTerminal.terminalId);
  const labValidation = useMemo(() => validateTerminalId(labInput), [labInput]);

  const previewNextSubId = generateSubTerminalId(
    masterTerminal.terminalId,
    subTerminals.length + 1
  );

  const toggleAssetInList = (list: AssetSymbol[], sym: AssetSymbol): AssetSymbol[] => {
    if (list.includes(sym)) {
      return list.length > 1 ? list.filter((a) => a !== sym) : list;
    }
    return [...list, sym];
  };

  const validatePolicyLimits = (dailyRaw: string, perTxRaw: string, assets: AssetSymbol[]) => {
    const daily = Number(dailyRaw);
    const perTx = Number(perTxRaw);
    if (!Number.isFinite(daily) || daily <= 0 || !Number.isFinite(perTx) || perTx <= 0) {
      throw new Error('Daily and per-transaction limits must be strictly positive numbers.');
    }
    if (perTx > daily) {
      throw new Error('Per-transaction limit cannot exceed the daily limit.');
    }
    if (daily > masterTerminal.daily_limit_usd) {
      throw new Error(
        `Daily limit ($${daily.toLocaleString()}) cannot exceed Master Terminal cap ($${masterTerminal.daily_limit_usd.toLocaleString()}).`
      );
    }
    if (assets.length === 0) {
      throw new Error('Select at least one allowed asset.');
    }
    return { daily, perTx };
  };

  const handleCreateSub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isKycApproved) {
      onToast(
        tr('KYC verification required', 'مطلوب توثيق الهوية'),
        tr('Complete KYC/KYB verification before provisioning Sub-Terminals.', 'أكمل توثيق الهوية قبل إنشاء المحطات الفرعية.'),
        'error'
      );
      return;
    }
    if (!newLabel.trim()) {
      onToast(
        tr('Label required', 'التسمية مطلوبة'),
        tr('Enter a descriptive name for the Sub-Terminal desk or bot.', 'أدخل اسماً وصفياً للمحطة الفرعية.'),
        'error'
      );
      return;
    }
    setIsProvisioning(true);
    try {
      const { daily, perTx } = validatePolicyLimits(newDailyLimit, newPerTxLimit, newAllowedAssets);
      await onProvisionSub({
        label: newLabel.trim(),
        dailyLimitUsd: daily,
        perTxLimitUsd: perTx,
        allowedAssets: newAllowedAssets,
      });
      setNewLabel('');
      setShowProvisionForm(false);
      onToast(tr('Sub-Terminal provisioned', 'تم إنشاء المحطة الفرعية'), `${previewNextSubId} is now active.`, 'success');
    } catch (err) {
      onToast(
        tr('Provisioning blocked', 'تم حظر الإنشاء'),
        err instanceof Error ? err.message : 'Unable to provision Sub-Terminal.',
        'error'
      );
    } finally {
      setIsProvisioning(false);
    }
  };

  const openPolicyEditor = (sub: TerminalRecord) => {
    setEditingSubUuid(sub.id);
    setRebalanceSubUuid(null);
    setEditDaily(String(sub.daily_limit_usd));
    setEditPerTx(String(sub.per_tx_limit_usd));
    setEditAssets(sub.allowed_assets);
  };

  const handleSavePolicy = async (sub: TerminalRecord) => {
    try {
      const { daily, perTx } = validatePolicyLimits(editDaily, editPerTx, editAssets);
      await onUpdatePolicy({
        terminalUuid: sub.id,
        dailyLimitUsd: daily,
        perTxLimitUsd: perTx,
        allowedAssets: editAssets,
      });
      setEditingSubUuid(null);
      onToast(
        tr('Policy updated', 'تم تحديث السياسة'),
        `Limits and asset permissions saved for ${sub.terminalId}`,
        'success'
      );
    } catch (err) {
      onToast(
        tr('Policy update blocked', 'تم رفض تحديث السياسة'),
        err instanceof Error ? err.message : 'Unable to save sub-terminal policy.',
        'error'
      );
    }
  };

  const handleToggleStatus = async (sub: TerminalRecord) => {
    const nextStatus: TerminalStatus = sub.status === 'active' ? 'suspended' : 'active';
    await onUpdatePolicy({ terminalUuid: sub.id, status: nextStatus });
    onToast(
      `Sub-Terminal ${nextStatus === 'active' ? 'activated' : 'suspended'}`,
      sub.terminalId,
      'info'
    );
  };

  const handleRebalanceSubmit = async (sub: TerminalRecord) => {
    const amt = Number(rebalanceAmount);
    if (Number.isNaN(amt) || amt <= 0) {
      onToast(
        tr('Invalid amount', 'مبلغ غير صالح'),
        tr('Enter a positive rebalance amount.', 'أدخل مبلغ إعادة موازنة موجباً.'),
        'error'
      );
      return;
    }
    setIsRebalancing(true);
    try {
      const sourceUuid = rebalanceDirection === 'fund' ? masterTerminal.id : sub.id;
      const targetCode = rebalanceDirection === 'fund' ? sub.terminalId : masterTerminal.terminalId;
      await onRebalance({
        sourceTerminalUuid: sourceUuid,
        recipientTerminalId: targetCode,
        asset: rebalanceAsset,
        amount: amt,
        memo:
          rebalanceDirection === 'fund'
            ? `Master allocation to ${sub.label}`
            : `Treasury recall from ${sub.label}`,
      });
      setRebalanceSubUuid(null);
      onToast(
        tr('Rebalance settled', 'تمت إعادة الموازنة'),
        `${formatAssetAmount(amt, rebalanceAsset)} ${rebalanceAsset} moved to ${targetCode}`,
        'success'
      );
    } catch (err) {
      onToast(
        tr('Rebalance failed', 'فشلت إعادة الموازنة'),
        err instanceof Error ? err.message : 'Unable to rebalance',
        'error'
      );
    } finally {
      setIsRebalancing(false);
    }
  };

  const masterTotalUsd = computePortfolioUsd(wallets, [masterTerminal.id], assetRates);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* Start 8 cols: Master/Sub Hierarchy Tree */}
      <div className="xl:col-span-8 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 bg-white border border-[#E2E8F0] rounded-xl px-6 py-4 shadow-xs">
          <div>
            <h2 className="text-base font-semibold text-[#0F172A]">
              {tr('Master & Sub-Terminal Policy Tree', 'شجرة سياسات المحطة الرئيسية والفرعية')}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {tr(
                'Segregated desk balances, allowed asset policies, and per-transaction caps',
                'أرصدة مكاتب معزولة وسياسات الأصول المسموحة وحدود كل معاملة'
              )}
            </p>
          </div>
          {isKycApproved ? (
            <button
              type="button"
              onClick={() => setShowProvisionForm((v) => !v)}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors whitespace-nowrap shadow-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              {showProvisionForm
                ? tr('Cancel', 'إلغاء')
                : tr('Provision Sub-Terminal', 'إنشاء محطة فرعية')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onNavigateToKyc?.()}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors whitespace-nowrap shadow-xs"
            >
              <UserCheck className="w-3.5 h-3.5" />
              {kycStatus === 'pending_review'
                ? tr('Check KYC Review Status', 'مراجعة حالة التوثيق')
                : tr('Complete KYC to Provision', 'أكمل التوثيق للإنشاء')}
            </button>
          )}
        </div>

        {!isKycApproved && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
            <div className="flex items-start gap-2.5 text-amber-900">
              <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">
                  {tr('Sub-Terminal Provisioning Locked', 'إنشاء المحطات الفرعية مقفل')} (KYC: {kycStatus.replace('_', ' ')})
                </div>
                <p className="text-amber-800 mt-0.5">
                  {tr(
                    'PostgreSQL compliance policies require approved Individual KYC or Corporate KYB verification before issuing new Sub-Terminal IDs.',
                    'تتطلب سياسات الامتثال موافقة توثيق KYC أو KYB قبل إصدار معرفات محطات فرعية جديدة.'
                  )}
                </p>
              </div>
            </div>
            {onNavigateToKyc && (
              <button
                type="button"
                onClick={onNavigateToKyc}
                className="px-3.5 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg whitespace-nowrap shrink-0"
              >
                {tr('Open KYC Verification', 'فتح التوثيق')}
              </button>
            )}
          </div>
        )}

        {/* Provision Sub-Terminal Drawer */}
        {isKycApproved && showProvisionForm && (
          <form
            onSubmit={handleCreateSub}
            className="bg-white border border-[#1E40AF] rounded-xl p-6 space-y-5 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-[#0F172A]">
                  {tr('Provision Child Sub-Terminal', 'إنشاء محطة فرعية تابعة')}
                </h3>
                <p className="text-xs font-mono tabular-nums text-[#1E40AF] font-semibold mt-0.5">
                  {previewNextSubId}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-[#0F172A]">
                  {tr('Desk / Bot Label', 'اسم المكتب / البوت')}
                </label>
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="e.g. Perps Hedging Desk"
                  className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3 py-2 text-xs text-[#0F172A] focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-[#0F172A]">
                  {tr('Per-Tx Limit (USD)', 'الحد لكل معاملة (USD)')}
                </label>
                <input
                  type="number"
                  value={newPerTxLimit}
                  onChange={(e) => setNewPerTxLimit(e.target.value)}
                  className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3 py-2 font-mono tabular-nums text-xs text-[#0F172A] focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-[#0F172A]">
                  {tr('Daily Limit (USD)', 'الحد اليومي (USD)')}
                </label>
                <input
                  type="number"
                  value={newDailyLimit}
                  onChange={(e) => setNewDailyLimit(e.target.value)}
                  className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3 py-2 font-mono tabular-nums text-xs text-[#0F172A] focus:outline-none"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-[#E2E8F0]">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-600 me-1">{tr('Allowed Assets:', 'الأصول المسموحة:')}</span>
                {(['USDT', 'BTC', 'ETH'] as AssetSymbol[]).map((sym) => {
                  const active = newAllowedAssets.includes(sym);
                  return (
                    <button
                      key={sym}
                      type="button"
                      onClick={() => setNewAllowedAssets((prev) => toggleAssetInList(prev, sym))}
                      className={`px-3 py-1.5 text-xs font-mono font-semibold rounded-md border transition-colors ${
                        active
                          ? 'bg-[#1E40AF] border-[#1E40AF] text-white'
                          : 'bg-[#F4F7FA] border-[#E2E8F0] text-slate-500'
                      }`}
                    >
                      {sym}
                    </button>
                  );
                })}
              </div>

              <button
                type="submit"
                disabled={isProvisioning}
                className="px-4 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg shadow-xs"
              >
                {isProvisioning
                  ? tr('Provisioning...', 'جاري الإنشاء...')
                  : tr('Create Sub-Terminal', 'إنشاء محطة فرعية')}
              </button>
            </div>
          </form>
        )}

        {/* Root Master Terminal Node — Cobalt Blue Primary Identity */}
        <div className="cobalt-hero-surface border border-[#24489B] rounded-xl p-5 text-white">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2.5 text-xs">
                <span className="px-2 py-0.5 rounded bg-[#D6FF3D] text-[#0F172A] font-semibold">
                  {tr('Master Root', 'الجذر الرئيسي')}
                </span>
                <span className="text-blue-200/70">/</span>
                <span className="inline-flex items-center gap-1 text-white font-medium">
                  <ShieldCheck className="w-3.5 h-3.5 text-[#D6FF3D]" />
                  {tr('Active', 'نشط')}
                </span>
              </div>
              <div className="flex items-center gap-2.5">
                <span className="font-mono tabular-nums text-base font-bold text-white">
                  {masterTerminal.terminalId}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onCopy(masterTerminal.terminalId, tr('Copied Master Terminal ID', 'تم نسخ معرف المحطة الرئيسية'))
                  }
                  className="text-blue-100 hover:text-[#D6FF3D] p-1"
                  aria-label="Copy Master Terminal ID"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-xs text-blue-100/85">{masterTerminal.label}</p>
            </div>

            <div className="text-end">
              <p className="text-xs text-blue-100/85">{tr('Master Treasury', 'الخزينة الرئيسية')}</p>
              <p className="font-mono tabular-nums text-xl font-bold text-white">
                {formatUsd(masterTotalUsd)}
              </p>
              <p className="text-[11px] font-mono tabular-nums text-[#D6FF3D] mt-0.5">
                {tr('Daily Cap:', 'الحد اليومي:')} {formatUsd(masterTerminal.daily_limit_usd)}
              </p>
            </div>
          </div>
        </div>

        {/* Child Sub-Terminals Tree List — Logical RTL/LTR Connectors */}
        <div className="ps-4 sm:ps-8 space-y-4 border-s-2 border-[#CBD5E1] ms-4">
          {subTerminals.map((sub) => {
            const subUsd = computePortfolioUsd(wallets, [sub.id], assetRates);
            const isEditing = editingSubUuid === sub.id;
            const isRebalancingThis = rebalanceSubUuid === sub.id;

            return (
              <div key={sub.id} className="relative">
                {/* Branch horizontal connector */}
                <span
                  aria-hidden="true"
                  className="hidden sm:block absolute -start-8 top-7 w-7 h-0.5 bg-[#CBD5E1]"
                />

                <div className="bg-white border border-[#E2E8F0] rounded-xl p-5 space-y-4 shadow-xs">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-[#0F172A]">{sub.label}</span>
                        <span className="text-slate-400">·</span>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-semibold ${
                            sub.status === 'active'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-amber-50 text-amber-800 border-amber-200'
                          }`}
                        >
                          {sub.status === 'active' ? tr('Active', 'نشط') : tr('Suspended', 'موقوف')}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <code className="font-mono tabular-nums text-sm font-bold text-[#1E40AF]">
                          {sub.terminalId}
                        </code>
                        <button
                          type="button"
                          onClick={() => onCopy(sub.terminalId, tr('Copied Sub-Terminal ID', 'تم نسخ معرف المحطة الفرعية'))}
                          className="text-slate-400 hover:text-[#1E40AF] p-0.5"
                          aria-label={`Copy ${sub.terminalId}`}
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-slate-500 font-mono tabular-nums">
                        <span>{tr('Assets:', 'الأصول:')} {sub.allowed_assets.join(', ')}</span>
                        <span className="text-slate-300">|</span>
                        <span>{tr('Per-Tx:', 'لكل معاملة:')} {formatUsd(sub.per_tx_limit_usd)}</span>
                        <span className="text-slate-300">|</span>
                        <span>{tr('Daily:', 'يومي:')} {formatUsd(sub.daily_limit_usd)}</span>
                      </div>
                    </div>

                    <div className="text-end space-y-2">
                      <div className="font-mono tabular-nums text-lg font-bold text-[#0F172A]">
                        {formatUsd(subUsd)}
                      </div>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setRebalanceSubUuid(isRebalancingThis ? null : sub.id);
                            setEditingSubUuid(null);
                            setRebalanceAsset(sub.allowed_assets[0] ?? 'USDT');
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-md transition-colors whitespace-nowrap"
                        >
                          <ArrowRightLeft className="w-3 h-3" />
                          {tr('Rebalance', 'موازنة')}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            isEditing ? setEditingSubUuid(null) : openPolicyEditor(sub)
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#0F172A] bg-[#F4F7FA] hover:bg-slate-200/70 border border-[#E2E8F0] rounded-md transition-colors whitespace-nowrap"
                        >
                          <SlidersHorizontal className="w-3 h-3 text-[#1E40AF]" />
                          {tr('Policy', 'السياسة')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleStatus(sub)}
                          className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-[#F4F7FA] hover:bg-slate-200/70 border border-[#E2E8F0] rounded-md transition-colors whitespace-nowrap"
                        >
                          {sub.status === 'active' ? tr('Suspend', 'تعليق') : tr('Activate', 'تفعيل')}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Individual Asset Balances Row */}
                  <div className="grid grid-cols-3 gap-3 pt-3 border-t border-[#E2E8F0]">
                    {(['USDT', 'BTC', 'ETH'] as AssetSymbol[]).map((sym) => {
                      const bal = getTerminalAssetTotal(wallets, sub.id, sym);
                      const enabled = sub.allowed_assets.includes(sym);
                      return (
                        <div
                          key={sym}
                          className={`bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 ${
                            !enabled ? 'opacity-50' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between text-[11px] text-slate-500">
                            <span className="font-mono font-bold text-[#0F172A]">{sym}</span>
                            <span>{enabled ? tr('Enabled', 'مفعّل') : tr('Blocked', 'محظور')}</span>
                          </div>
                          <div className="font-mono tabular-nums text-xs font-semibold text-[#0F172A] mt-1">
                            {formatAssetAmount(bal.available, sym)}
                          </div>
                          <div className="font-mono tabular-nums text-[11px] text-slate-500">
                            {formatUsd(bal.available * assetRates[sym])}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Quick Rebalance Drawer */}
                  {isRebalancingThis && (
                    <div className="bg-[#F4F7FA] border border-[#1E40AF]/30 rounded-lg p-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-[#0F172A]">
                          {tr('Instant Master ↔ Sub-Terminal Allocation ($0 Fee)', 'تخصيص فوري بين الرئيسية والفرعية (رسوم $0)')}
                        </span>
                        <div className="flex items-center gap-1 bg-white p-0.5 rounded-md border border-[#E2E8F0] text-[11px]">
                          <button
                            type="button"
                            onClick={() => setRebalanceDirection('fund')}
                            className={`px-2.5 py-1 rounded ${
                              rebalanceDirection === 'fund'
                                ? 'bg-[#1E40AF] text-white font-semibold'
                                : 'text-slate-600'
                            }`}
                          >
                            {tr('Fund Sub', 'تمويل الفرعية')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setRebalanceDirection('recall')}
                            className={`px-2.5 py-1 rounded ${
                              rebalanceDirection === 'recall'
                                ? 'bg-[#1E40AF] text-white font-semibold'
                                : 'text-slate-600'
                            }`}
                          >
                            {tr('Recall to Master', 'استرداد للرئيسية')}
                          </button>
                        </div>
                      </div>

                      <div className="flex flex-col sm:flex-row gap-2.5">
                        <select
                          value={rebalanceAsset}
                          onChange={(e) => setRebalanceAsset(e.target.value as AssetSymbol)}
                          className="bg-white border border-[#E2E8F0] rounded-md px-3 py-2 text-xs font-mono text-[#0F172A] focus:outline-none"
                        >
                          {sub.allowed_assets.map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          step="any"
                          value={rebalanceAmount}
                          onChange={(e) => setRebalanceAmount(e.target.value)}
                          className="flex-1 bg-white border border-[#E2E8F0] rounded-md px-3 py-2 font-mono tabular-nums text-xs text-[#0F172A] focus:border-[#1E40AF] focus:outline-none"
                        />
                        <button
                          type="button"
                          disabled={isRebalancing}
                          onClick={() => handleRebalanceSubmit(sub)}
                          className="px-4 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-md whitespace-nowrap"
                        >
                          {isRebalancing ? tr('Settling...', 'جاري التسوية...') : tr('Execute', 'تنفيذ')}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Policy Editor Drawer */}
                  {isEditing && (
                    <div className="bg-[#F4F7FA] border border-[#E2E8F0] rounded-lg p-4 space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <label className="text-[11px] font-semibold text-[#0F172A]">
                            {tr('Per-Tx Limit (USD)', 'الحد لكل معاملة (USD)')}
                          </label>
                          <input
                            type="number"
                            value={editPerTx}
                            onChange={(e) => setEditPerTx(e.target.value)}
                            className="w-full bg-white border border-[#E2E8F0] rounded-md px-3 py-2 font-mono tabular-nums text-xs text-[#0F172A]"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[11px] font-semibold text-[#0F172A]">
                            {tr('Daily Limit (USD)', 'الحد اليومي (USD)')}
                          </label>
                          <input
                            type="number"
                            value={editDaily}
                            onChange={(e) => setEditDaily(e.target.value)}
                            className="w-full bg-white border border-[#E2E8F0] rounded-md px-3 py-2 font-mono tabular-nums text-xs text-[#0F172A]"
                          />
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-600">{tr('Assets:', 'الأصول:')}</span>
                          {(['USDT', 'BTC', 'ETH'] as AssetSymbol[]).map((sym) => {
                            const active = editAssets.includes(sym);
                            return (
                              <button
                                key={sym}
                                type="button"
                                onClick={() => setEditAssets((p) => toggleAssetInList(p, sym))}
                                className={`px-2.5 py-1 text-xs font-mono font-semibold rounded border ${
                                  active
                                    ? 'bg-[#1E40AF] border-[#1E40AF] text-white'
                                    : 'bg-white border-[#E2E8F0] text-slate-500'
                                }`}
                              >
                                {sym}
                              </button>
                            );
                          })}
                        </div>
                        <button
                          type="button"
                          onClick={() => handleSavePolicy(sub)}
                          className="px-4 py-1.5 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-md"
                        >
                          {tr('Save Policy', 'حفظ السياسة')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* End 4 cols: Crockford Base32 Mod-37 Generator & Validator Lab */}
      <div className="xl:col-span-4 bg-white border border-[#E2E8F0] rounded-xl p-6 space-y-5 shadow-xs">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-[#0F172A] flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-[#1E40AF]" />
              {tr('Terminal ID Generator & Validator', 'مولد ومتحقق معرفات المحطات')}
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              {tr(
                'Crockford Base32 (excludes I, L, O, U) with Mod-37 check character',
                'ترميز Crockford Base32 مع خانة تحقق Mod-37'
              )}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="ntps-lab-input" className="text-xs font-semibold text-[#0F172A]">
            {tr('Test Normalization & Checksum', 'اختبار التطبيع والتحقق')}
          </label>
          <div
            className={`flex items-center bg-[#F8FAFC] border rounded-lg px-3 py-2.5 transition-all ${
              labValidation.isEmpty
                ? 'border-[#E2E8F0]'
                : labValidation.isValid
                  ? 'border-emerald-500'
                  : 'border-red-500'
            }`}
          >
            <input
              id="ntps-lab-input"
              type="text"
              value={labInput}
              onChange={(e) => {
                const { normalized } = normalizeTerminalIdInput(e.target.value);
                setLabInput(normalized || e.target.value.toUpperCase());
              }}
              placeholder="nt-0mega-7k9p-3m2x"
              className="flex-1 bg-transparent font-mono tabular-nums text-xs text-[#0F172A] focus:outline-none"
            />
            {!labValidation.isEmpty &&
              (labValidation.isValid ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
              ))}
          </div>

          <div className="text-xs min-h-[18px]">
            {labValidation.isValid ? (
              <span className="text-emerald-700 font-medium">
                {tr('Valid', 'صالح')}{' '}
                {labValidation.type === 'sub'
                  ? tr('Sub-Terminal', 'محطة فرعية')
                  : tr('Master Terminal', 'محطة رئيسية')}{' '}
                ID
              </span>
            ) : labValidation.error ? (
              <span className="text-red-600">{labValidation.error}</span>
            ) : null}
          </div>
        </div>

        <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg divide-y divide-[#E2E8F0] text-xs">
          <div className="flex items-center justify-between px-3.5 py-2.5">
            <span className="text-slate-500">{tr('Payload (7 chars)', 'الحمولة (7 أحرف)')}</span>
            <span className="font-mono tabular-nums text-[#0F172A] font-semibold">
              {labValidation.payload7 ?? '—'}
            </span>
          </div>
          <div className="flex items-center justify-between px-3.5 py-2.5">
            <span className="text-slate-500">{tr('Expected Mod-37 Check', 'خانة Mod-37 المتوقعة')}</span>
            <span className="font-mono text-[#1E40AF] font-bold">
              {labValidation.checkCharExpected ?? '—'}
            </span>
          </div>
          <div className="flex items-center justify-between px-3.5 py-2.5">
            <span className="text-slate-500">{tr('Actual Check Char', 'الخانة الفعلية')}</span>
            <span
              className={`font-mono font-bold ${
                labValidation.isValid ? 'text-emerald-700' : 'text-red-600'
              }`}
            >
              {labValidation.checkCharActual ?? '—'}
            </span>
          </div>
          <div className="flex items-center justify-between px-3.5 py-2.5">
            <span className="text-slate-500">{tr('Auto-Corrections', 'التصحيحات التلقائية')}</span>
            <span className="font-mono text-slate-700 text-end">
              {labValidation.corrections.length > 0
                ? labValidation.corrections[0]
                : tr('None', 'لا يوجد')}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={() => {
              const id = generateMasterTerminalId();
              setLabInput(id);
              onToast(tr('Generated Master ID', 'تم توليد معرف رئيسي'), id, 'info');
            }}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {tr('New Master ID', 'معرف رئيسي جديد')}
          </button>
          <button
            type="button"
            onClick={() => {
              const base = labValidation.masterBase ?? masterTerminal.terminalId;
              const arr = new Uint32Array(1);
              globalThis.crypto.getRandomValues(arr);
              const id = generateSubTerminalId(base, 1 + (arr[0] % 19));
              setLabInput(id);
            }}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-[#0F172A] bg-[#F4F7FA] hover:bg-slate-200/70 border border-[#E2E8F0] rounded-lg transition-colors whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5 text-[#1E40AF]" />
            {tr('Sample Sub ID', 'معرف فرعي تجريبي')}
          </button>
        </div>
      </div>
    </div>
  );
}
