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
} from 'lucide-react';
import type { AssetRateMap, AssetSymbol, TerminalRecord, TerminalStatus, WalletBalance } from '../types/ntps';
import { ASSET_USD_RATES, computePortfolioUsd, getTerminalAssetTotal } from '../lib/ledgerEngine';
import {
  generateMasterTerminalId,
  generateSubTerminalId,
  normalizeTerminalIdInput,
  validateTerminalId,
} from '../lib/terminalId';
import { formatAssetAmount, formatUsd } from '../lib/format';

interface SubTerminalsViewProps {
  terminals: TerminalRecord[];
  wallets: WalletBalance[];
  assetRates?: AssetRateMap;
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
  onProvisionSub,
  onUpdatePolicy,
  onRebalance,
  onCopy,
  onToast,
}: SubTerminalsViewProps) {
  const masterTerminal = terminals.find((t) => t.type === 'master') ?? terminals[0];
  const subTerminals = terminals.filter((t) => t.type === 'sub');

  // Provision Sub-Terminal state
  const [showProvisionForm, setShowProvisionForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newDailyLimit, setNewDailyLimit] = useState('150000');
  const [newPerTxLimit, setNewPerTxLimit] = useState('50000');
  const [newAllowedAssets, setNewAllowedAssets] = useState<AssetSymbol[]>(['USDT', 'ETH']);
  const [isProvisioning, setIsProvisioning] = useState(false);

  // Policy edit modal/panel
  const [editingSubUuid, setEditingSubUuid] = useState<string | null>(null);
  const [editDaily, setEditDaily] = useState('');
  const [editPerTx, setEditPerTx] = useState('');
  const [editAssets, setEditAssets] = useState<AssetSymbol[]>([]);

  // Quick Rebalance inline state
  const [rebalanceSubUuid, setRebalanceSubUuid] = useState<string | null>(null);
  const [rebalanceDirection, setRebalanceDirection] = useState<'fund' | 'recall'>('fund');
  const [rebalanceAsset, setRebalanceAsset] = useState<AssetSymbol>('USDT');
  const [rebalanceAmount, setRebalanceAmount] = useState('10000');
  const [isRebalancing, setIsRebalancing] = useState(false);

  // Terminal ID Generator & Checksum Lab
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

  const handleCreateSub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLabel.trim()) {
      onToast('Label required', 'Enter a descriptive name for the Sub-Terminal desk or bot.', 'error');
      return;
    }
    setIsProvisioning(true);
    try {
      await onProvisionSub({
        label: newLabel,
        dailyLimitUsd: Math.max(1000, Number(newDailyLimit) || 100000),
        perTxLimitUsd: Math.max(500, Number(newPerTxLimit) || 25000),
        allowedAssets: newAllowedAssets,
      });
      setNewLabel('');
      setShowProvisionForm(false);
      onToast('Sub-Terminal provisioned', `${previewNextSubId} is now active.`, 'success');
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
    await onUpdatePolicy({
      terminalUuid: sub.id,
      dailyLimitUsd: Math.max(1000, Number(editDaily) || 50000),
      perTxLimitUsd: Math.max(500, Number(editPerTx) || 15000),
      allowedAssets: editAssets,
    });
    setEditingSubUuid(null);
    onToast('Policy updated', `Limits and asset permissions saved for ${sub.terminalId}`, 'success');
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
      onToast('Invalid amount', 'Enter a positive rebalance amount.', 'error');
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
        'Rebalance settled',
        `${formatAssetAmount(amt, rebalanceAsset)} ${rebalanceAsset} moved to ${targetCode}`,
        'success'
      );
    } catch (err) {
      onToast(
        'Rebalance failed',
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
      {/* Left 8 cols: Master/Sub Hierarchy Tree */}
      <div className="xl:col-span-8 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 bg-[#0B0F16] border border-white/[0.08] rounded-xl px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Master & Sub-Terminal Policy Tree
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Segregated desk balances, allowed asset policies, and per-transaction caps
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowProvisionForm((v) => !v)}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] rounded-lg transition-colors whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            {showProvisionForm ? 'Cancel' : 'Provision Sub-Terminal'}
          </button>
        </div>

        {/* Provision Sub-Terminal Drawer */}
        {showProvisionForm && (
          <form
            onSubmit={handleCreateSub}
            className="bg-[#0B0F16] border border-[#00E5FF]/30 rounded-xl p-6 space-y-5"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  Provision Child Sub-Terminal
                </h3>
                <p className="text-xs font-mono text-[#00E5FF] mt-0.5">{previewNextSubId}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">Desk / Bot Label</label>
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="e.g. Perps Hedging Desk"
                  className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">Per-Tx Limit (USD)</label>
                <input
                  type="number"
                  value={newPerTxLimit}
                  onChange={(e) => setNewPerTxLimit(e.target.value)}
                  className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3 py-2 font-mono text-xs text-slate-100 focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">Daily Limit (USD)</label>
                <input
                  type="number"
                  value={newDailyLimit}
                  onChange={(e) => setNewDailyLimit(e.target.value)}
                  className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3 py-2 font-mono text-xs text-slate-100 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-white/[0.06]">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400 mr-1">Allowed Assets:</span>
                {(['USDT', 'BTC', 'ETH'] as AssetSymbol[]).map((sym) => {
                  const active = newAllowedAssets.includes(sym);
                  return (
                    <button
                      key={sym}
                      type="button"
                      onClick={() => setNewAllowedAssets((prev) => toggleAssetInList(prev, sym))}
                      className={`px-3 py-1.5 text-xs font-mono rounded-md border transition-colors ${
                        active
                          ? 'bg-[#00E5FF]/15 border-[#00E5FF]/40 text-[#00E5FF]'
                          : 'bg-[#05070A] border-white/[0.08] text-slate-500'
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
                className="px-4 py-2 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] rounded-lg"
              >
                {isProvisioning ? 'Provisioning...' : 'Create Sub-Terminal'}
              </button>
            </div>
          </form>
        )}

        {/* Root Master Terminal Node */}
        <div className="bg-[#0B0F16] border border-[#00E5FF]/30 rounded-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2.5 text-xs">
                <span className="font-semibold text-[#F5C542]">Master Root</span>
                <span className="text-slate-600">/</span>
                <span className="inline-flex items-center gap-1 text-emerald-400">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Active
                </span>
              </div>
              <div className="flex items-center gap-2.5">
                <span className="font-mono text-base font-bold text-[#00E5FF]">
                  {masterTerminal.terminalId}
                </span>
                <button
                  type="button"
                  onClick={() => onCopy(masterTerminal.terminalId, 'Copied Master Terminal ID')}
                  className="text-slate-400 hover:text-slate-100 p-1"
                  aria-label="Copy Master Terminal ID"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-xs text-slate-400">{masterTerminal.label}</p>
            </div>

            <div className="text-right">
              <p className="text-xs text-slate-400">Master Treasury</p>
              <p className="font-mono tabular-nums text-xl font-bold text-[#F5C542]">
                {formatUsd(masterTotalUsd)}
              </p>
              <p className="text-[11px] font-mono text-slate-400 mt-0.5">
                Daily Cap: {formatUsd(masterTerminal.daily_limit_usd)}
              </p>
            </div>
          </div>
        </div>

        {/* Child Sub-Terminals Tree List */}
        <div className="pl-4 sm:pl-8 space-y-4 border-l border-white/[0.12] ml-4">
          {subTerminals.map((sub) => {
            const subUsd = computePortfolioUsd(wallets, [sub.id], assetRates);
            const isEditing = editingSubUuid === sub.id;
            const isRebalancingThis = rebalanceSubUuid === sub.id;

            return (
              <div key={sub.id} className="relative">
                {/* Branch horizontal connector */}
                <span
                  aria-hidden="true"
                  className="hidden sm:block absolute -left-8 top-7 w-7 h-px bg-white/[0.12]"
                />

                <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl p-5 space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-slate-200">{sub.label}</span>
                        <span className="text-slate-600">·</span>
                        <span
                          className={`font-medium ${
                            sub.status === 'active' ? 'text-emerald-400' : 'text-amber-400'
                          }`}
                        >
                          {sub.status === 'active' ? 'Active' : 'Suspended'}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <code className="font-mono text-sm font-semibold text-slate-100">
                          {sub.terminalId}
                        </code>
                        <button
                          type="button"
                          onClick={() => onCopy(sub.terminalId, 'Copied Sub-Terminal ID')}
                          className="text-slate-400 hover:text-[#00E5FF] p-0.5"
                          aria-label={`Copy ${sub.terminalId}`}
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-slate-400 font-mono tabular-nums">
                        <span>Assets: {sub.allowed_assets.join(', ')}</span>
                        <span className="text-slate-600">|</span>
                        <span>Per-Tx: {formatUsd(sub.per_tx_limit_usd)}</span>
                        <span className="text-slate-600">|</span>
                        <span>Daily: {formatUsd(sub.daily_limit_usd)}</span>
                      </div>
                    </div>

                    <div className="text-right space-y-2">
                      <div className="font-mono tabular-nums text-lg font-bold text-[#F5C542]">
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
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#00E5FF] bg-[#00E5FF]/10 hover:bg-[#00E5FF]/20 border border-[#00E5FF]/25 rounded-md transition-colors whitespace-nowrap"
                        >
                          <ArrowRightLeft className="w-3 h-3" />
                          Rebalance
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            isEditing ? setEditingSubUuid(null) : openPolicyEditor(sub)
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] rounded-md transition-colors whitespace-nowrap"
                        >
                          <SlidersHorizontal className="w-3 h-3" />
                          Policy
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleStatus(sub)}
                          className="px-2.5 py-1.5 text-xs font-medium text-slate-300 bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.08] rounded-md transition-colors whitespace-nowrap"
                        >
                          {sub.status === 'active' ? 'Suspend' : 'Activate'}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Individual Asset Balances Row */}
                  <div className="grid grid-cols-3 gap-3 pt-3 border-t border-white/[0.06]">
                    {(['USDT', 'BTC', 'ETH'] as AssetSymbol[]).map((sym) => {
                      const bal = getTerminalAssetTotal(wallets, sub.id, sym);
                      const enabled = sub.allowed_assets.includes(sym);
                      return (
                        <div
                          key={sym}
                          className={`bg-[#05070A] border border-white/[0.06] rounded-lg px-3 py-2 ${
                            !enabled ? 'opacity-45' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between text-[11px] text-slate-400">
                            <span className="font-mono font-semibold">{sym}</span>
                            <span>{enabled ? 'Enabled' : 'Blocked'}</span>
                          </div>
                          <div className="font-mono tabular-nums text-xs text-slate-100 mt-1">
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
                    <div className="bg-[#05070A] border border-[#00E5FF]/25 rounded-lg p-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-medium text-slate-200">
                          Instant Master ↔ Sub-Terminal Allocation ($0 Fee)
                        </span>
                        <div className="flex items-center gap-1 bg-[#0B0F16] p-0.5 rounded-md border border-white/[0.08] text-[11px]">
                          <button
                            type="button"
                            onClick={() => setRebalanceDirection('fund')}
                            className={`px-2.5 py-1 rounded ${
                              rebalanceDirection === 'fund'
                                ? 'bg-[#00E5FF] text-[#05070A] font-semibold'
                                : 'text-slate-400'
                            }`}
                          >
                            Fund Sub
                          </button>
                          <button
                            type="button"
                            onClick={() => setRebalanceDirection('recall')}
                            className={`px-2.5 py-1 rounded ${
                              rebalanceDirection === 'recall'
                                ? 'bg-[#00E5FF] text-[#05070A] font-semibold'
                                : 'text-slate-400'
                            }`}
                          >
                            Recall to Master
                          </button>
                        </div>
                      </div>

                      <div className="flex flex-col sm:flex-row gap-2.5">
                        <select
                          value={rebalanceAsset}
                          onChange={(e) => setRebalanceAsset(e.target.value as AssetSymbol)}
                          className="bg-[#0B0F16] border border-white/[0.12] rounded-md px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none"
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
                          className="flex-1 bg-[#0B0F16] border border-white/[0.12] rounded-md px-3 py-2 font-mono text-xs text-slate-100 focus:border-[#00E5FF] focus:outline-none"
                        />
                        <button
                          type="button"
                          disabled={isRebalancing}
                          onClick={() => handleRebalanceSubmit(sub)}
                          className="px-4 py-2 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] rounded-md whitespace-nowrap"
                        >
                          {isRebalancing ? 'Settling...' : 'Execute'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Policy Editor Drawer */}
                  {isEditing && (
                    <div className="bg-[#05070A] border border-white/[0.12] rounded-lg p-4 space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <label className="text-[11px] text-slate-400">Per-Tx Limit (USD)</label>
                          <input
                            type="number"
                            value={editPerTx}
                            onChange={(e) => setEditPerTx(e.target.value)}
                            className="w-full bg-[#0B0F16] border border-white/[0.12] rounded-md px-3 py-2 font-mono text-xs text-slate-100"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[11px] text-slate-400">Daily Limit (USD)</label>
                          <input
                            type="number"
                            value={editDaily}
                            onChange={(e) => setEditDaily(e.target.value)}
                            className="w-full bg-[#0B0F16] border border-white/[0.12] rounded-md px-3 py-2 font-mono text-xs text-slate-100"
                          />
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-400">Assets:</span>
                          {(['USDT', 'BTC', 'ETH'] as AssetSymbol[]).map((sym) => {
                            const active = editAssets.includes(sym);
                            return (
                              <button
                                key={sym}
                                type="button"
                                onClick={() => setEditAssets((p) => toggleAssetInList(p, sym))}
                                className={`px-2.5 py-1 text-xs font-mono rounded border ${
                                  active
                                    ? 'bg-[#00E5FF]/15 border-[#00E5FF]/40 text-[#00E5FF]'
                                    : 'bg-[#0B0F16] border-white/[0.08] text-slate-500'
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
                          className="px-4 py-1.5 text-xs font-semibold text-[#05070A] bg-emerald-400 hover:bg-emerald-300 rounded-md"
                        >
                          Save Policy
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

      {/* Right 4 cols: Crockford Base32 Mod-37 Generator & Validator Lab */}
      <div className="xl:col-span-4 bg-[#0B0F16] border border-white/[0.08] rounded-xl p-6 space-y-5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-[#00E5FF]" />
              Terminal ID Generator & Validator
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Crockford Base32 (excludes I, L, O, U) with Mod-37 check character
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="ntps-lab-input" className="text-xs font-medium text-slate-300">
            Test Normalization & Checksum
          </label>
          <div
            className={`flex items-center bg-[#05070A] border rounded-lg px-3 py-2.5 transition-all ${
              labValidation.isEmpty
                ? 'border-white/[0.12]'
                : labValidation.isValid
                  ? 'border-emerald-500/80'
                  : 'border-red-500/80'
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
              className="flex-1 bg-transparent font-mono text-xs text-slate-100 focus:outline-none"
            />
            {!labValidation.isEmpty &&
              (labValidation.isValid ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              ))}
          </div>

          <div className="text-xs min-h-[18px]">
            {labValidation.isValid ? (
              <span className="text-emerald-400">
                Valid {labValidation.type === 'sub' ? 'Sub-Terminal' : 'Master Terminal'} ID
              </span>
            ) : labValidation.error ? (
              <span className="text-red-400">{labValidation.error}</span>
            ) : null}
          </div>
        </div>

        <div className="bg-[#05070A] border border-white/[0.07] rounded-lg divide-y divide-white/[0.06] text-xs">
          <div className="flex items-center justify-between px-3.5 py-2.5">
            <span className="text-slate-400">Payload (7 chars)</span>
            <span className="font-mono text-slate-200">{labValidation.payload7 ?? '—'}</span>
          </div>
          <div className="flex items-center justify-between px-3.5 py-2.5">
            <span className="text-slate-400">Expected Mod-37 Check</span>
            <span className="font-mono text-[#00E5FF]">
              {labValidation.checkCharExpected ?? '—'}
            </span>
          </div>
          <div className="flex items-center justify-between px-3.5 py-2.5">
            <span className="text-slate-400">Actual Check Char</span>
            <span
              className={`font-mono ${
                labValidation.isValid ? 'text-emerald-400' : 'text-red-400'
              }`}
            >
              {labValidation.checkCharActual ?? '—'}
            </span>
          </div>
          <div className="flex items-center justify-between px-3.5 py-2.5">
            <span className="text-slate-400">Auto-Corrections</span>
            <span className="font-mono text-slate-300 text-right">
              {labValidation.corrections.length > 0 ? labValidation.corrections[0] : 'None'}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={() => {
              const id = generateMasterTerminalId();
              setLabInput(id);
              onToast('Generated Master ID', id, 'info');
            }}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-100 bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] rounded-lg transition-colors whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5 text-[#00E5FF]" />
            New Master ID
          </button>
          <button
            type="button"
            onClick={() => {
              const base = labValidation.masterBase ?? masterTerminal.terminalId;
              const id = generateSubTerminalId(base, Math.floor(1 + Math.random() * 19));
              setLabInput(id);
            }}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-100 bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] rounded-lg transition-colors whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5 text-[#F5C542]" />
            Sample Sub ID
          </button>
        </div>
      </div>
    </div>
  );
}
