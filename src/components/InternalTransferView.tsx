import { useState, useMemo } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react';
import type { AssetRateMap, AssetSymbol, TerminalRecord, WalletBalance } from '../types/ntps';
import {
  ASSET_USD_RATES,
  COUNTERPARTY_DIRECTORY,
  getTerminalAssetTotal,
  resolveCounterpartyPreview,
} from '../lib/ledgerEngine';
import {
  generateMasterTerminalId,
  normalizeTerminalIdInput,
  validateTerminalId,
} from '../lib/terminalId';
import { formatAssetAmount, formatUsd } from '../lib/format';
import { TwoFactorModal } from './TwoFactorModal';

interface InternalTransferViewProps {
  terminals: TerminalRecord[];
  wallets: WalletBalance[];
  assetRates?: AssetRateMap;
  preselectedAsset?: AssetSymbol;
  onExecuteTransfer: (params: {
    sourceTerminalUuid: string;
    recipientTerminalId: string;
    asset: AssetSymbol;
    amount: number;
    memo: string;
  }) => Promise<void>;
  onToast: (title: string, description?: string, variant?: 'success' | 'error' | 'info') => void;
}

export function InternalTransferView({
  terminals,
  wallets,
  assetRates = ASSET_USD_RATES,
  preselectedAsset = 'USDT',
  onExecuteTransfer,
  onToast,
}: InternalTransferViewProps) {
  const activeTerminals = terminals.filter((t) => t.status === 'active');
  const [sourceTerminalUuid, setSourceTerminalUuid] = useState(
    activeTerminals[0]?.id ?? ''
  );
  const [recipientInput, setRecipientInput] = useState(COUNTERPARTY_DIRECTORY[0].terminalId);
  const [asset, setAsset] = useState<AssetSymbol>(preselectedAsset);
  const [amountInput, setAmountInput] = useState('');
  const [memo, setMemo] = useState('');
  const [is2FaOpen, setIs2FaOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const sourceTerminal = terminals.find((t) => t.id === sourceTerminalUuid) ?? terminals[0];
  const availableBalance = sourceTerminal
    ? getTerminalAssetTotal(wallets, sourceTerminal.id, asset).available
    : 0;

  const validation = useMemo(() => validateTerminalId(recipientInput), [recipientInput]);
  const counterpartyPreview = useMemo(
    () => (validation.isValid ? resolveCounterpartyPreview(validation.normalized, terminals) : null),
    [validation, terminals]
  );

  const parsedAmount = Number(amountInput);
  const usdEquivalent =
    !Number.isNaN(parsedAmount) && parsedAmount > 0
      ? parsedAmount * assetRates[asset]
      : 0;

  const isSelfTransfer =
    validation.isValid && sourceTerminal && validation.normalized === sourceTerminal.terminalId;
  const exceedsBalance = !Number.isNaN(parsedAmount) && parsedAmount > availableBalance;
  const exceedsPerTx =
    sourceTerminal && usdEquivalent > sourceTerminal.per_tx_limit_usd;
  const assetDisallowed =
    sourceTerminal && !sourceTerminal.allowed_assets.includes(asset);

  const canSubmit =
    validation.isValid &&
    !isSelfTransfer &&
    !Number.isNaN(parsedAmount) &&
    parsedAmount > 0 &&
    !exceedsBalance &&
    !exceedsPerTx &&
    !assetDisallowed;

  const handleRecipientChange = (raw: string) => {
    const { normalized } = normalizeTerminalIdInput(raw);
    setRecipientInput(normalized || raw.toUpperCase());
  };

  const handleGenerateRandomValid = () => {
    const fresh = generateMasterTerminalId();
    setRecipientInput(fresh);
    onToast('Generated valid Crockford Mod-37 Terminal ID', fresh, 'info');
  };

  const handleConfirm2Fa = async () => {
    if (!sourceTerminal) return;
    setIsSubmitting(true);
    try {
      await onExecuteTransfer({
        sourceTerminalUuid: sourceTerminal.id,
        recipientTerminalId: validation.normalized,
        asset,
        amount: parsedAmount,
        memo: memo.trim(),
      });
      setIs2FaOpen(false);
      setAmountInput('');
      setMemo('');
      onToast(
        'Transfer completed successfully',
        `${formatAssetAmount(parsedAmount, asset)} ${asset} settled to ${validation.normalized}`,
        'success'
      );
    } catch (err) {
      onToast(
        'Settlement failed',
        err instanceof Error ? err.message : 'Unable to settle internal transfer',
        'error'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const borderClass = validation.isEmpty
    ? 'border-white/[0.12] focus-within:border-[#00E5FF]'
    : validation.isValid && !isSelfTransfer
      ? 'border-emerald-500/80 shadow-[0_0_0_1px_rgba(16,185,129,0.25)]'
      : 'border-red-500/80 shadow-[0_0_0_1px_rgba(239,68,68,0.25)]';

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* Left: Transfer Composer */}
      <div className="xl:col-span-7 bg-[#0B0F16] border border-white/[0.08] rounded-xl p-6 space-y-6">
        <div className="flex items-start justify-between gap-4 border-b border-white/[0.07] pb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Internal Terminal Settlement
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Zero-fee, sub-second double-entry settlement between verified NTPS terminals
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-[#00E5FF] shrink-0">
            <Zap className="w-3.5 h-3.5" />
            $0.00 Fee
          </span>
        </div>

        {/* Source Terminal */}
        <div className="space-y-2">
          <label htmlFor="ntps-source-term" className="block text-xs font-medium text-slate-300">
            Source Terminal
          </label>
          <select
            id="ntps-source-term"
            value={sourceTerminal?.id ?? ''}
            onChange={(e) => setSourceTerminalUuid(e.target.value)}
            className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 text-sm text-slate-100 font-mono focus:outline-none transition-colors"
          >
            {activeTerminals.map((t) => (
              <option key={t.id} value={t.id}>
                {t.terminalId} — {t.label} ({t.type === 'master' ? 'Master' : 'Sub'})
              </option>
            ))}
          </select>
        </div>

        {/* Recipient Terminal Prompt */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="ntps-recipient-id" className="text-xs font-medium text-slate-300">
              Recipient Terminal ID (Crockford Mod-37)
            </label>
            <button
              type="button"
              onClick={handleGenerateRandomValid}
              className="inline-flex items-center gap-1 text-xs text-[#00E5FF] hover:text-[#5ceeff] transition-colors"
            >
              <Sparkles className="w-3 h-3" />
              Generate Valid Test ID
            </button>
          </div>

          <div
            className={`flex items-center bg-[#05070A] border rounded-lg px-3.5 py-2.5 transition-all ${borderClass}`}
          >
            <span className="font-mono text-sm font-bold text-[#00E5FF] mr-2 select-none">
              &gt;
            </span>
            <input
              id="ntps-recipient-id"
              type="text"
              value={recipientInput}
              onChange={(e) => handleRecipientChange(e.target.value)}
              placeholder="NT-OMEGA-XXXX-XXXX"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 bg-transparent font-mono text-sm sm:text-base text-slate-100 placeholder:text-slate-600 focus:outline-none tracking-wider"
            />
            {!validation.isEmpty && (
              <span className="ml-2 shrink-0">
                {validation.isValid && !isSelfTransfer ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-red-400" />
                )}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs min-h-[18px]">
            {validation.isEmpty ? (
              <span className="text-slate-500">
                Auto-normalizes spaces, uppercase, and O/I/L Crockford typos
              </span>
            ) : isSelfTransfer ? (
              <span className="text-red-400">
                Recipient Terminal ID must differ from Source Terminal ID.
              </span>
            ) : validation.isValid ? (
              <span className="text-emerald-400 font-mono">
                Valid Mod-37 checksum ({validation.type === 'sub' ? 'Sub-Terminal' : 'Master Terminal'})
              </span>
            ) : (
              <span className="text-red-400">{validation.error}</span>
            )}

            {validation.corrections.length > 0 && (
              <span className="text-slate-400 font-mono text-[11px]">
                {validation.corrections[0]}
              </span>
            )}
          </div>
        </div>

        {/* Asset & Amount */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
          <div className="sm:col-span-4 space-y-2">
            <span className="block text-xs font-medium text-slate-300">Asset</span>
            <div className="grid grid-cols-3 gap-1.5 bg-[#05070A] p-1 border border-white/[0.1] rounded-lg">
              {(['USDT', 'BTC', 'ETH'] as AssetSymbol[]).map((sym) => {
                const enabled = sourceTerminal?.allowed_assets.includes(sym) ?? true;
                return (
                  <button
                    key={sym}
                    type="button"
                    disabled={!enabled}
                    onClick={() => setAsset(sym)}
                    className={`py-2 text-xs font-mono font-semibold rounded-md transition-colors ${
                      asset === sym
                        ? 'bg-[#00E5FF] text-[#05070A]'
                        : enabled
                          ? 'text-slate-300 hover:text-white hover:bg-white/[0.05]'
                          : 'text-slate-600 cursor-not-allowed'
                    }`}
                  >
                    {sym}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="sm:col-span-8 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="ntps-transfer-amt" className="font-medium text-slate-300">
                Settlement Amount
              </label>
              <button
                type="button"
                onClick={() => setAmountInput(String(availableBalance))}
                className="font-mono tabular-nums text-slate-400 hover:text-[#00E5FF] transition-colors"
              >
                Avail: {formatAssetAmount(availableBalance, asset)} {asset} (Max)
              </button>
            </div>
            <div className="relative">
              <input
                id="ntps-transfer-amt"
                type="number"
                step="any"
                min="0"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                placeholder="0.00"
                className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 pr-16 font-mono tabular-nums text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none transition-colors"
              />
              <span className="absolute right-3.5 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                {asset}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="font-mono tabular-nums text-[#F5C542]">
                ≈ {formatUsd(usdEquivalent)}
              </span>
              {exceedsBalance && (
                <span className="text-red-400">Exceeds available balance</span>
              )}
              {!exceedsBalance && exceedsPerTx && (
                <span className="text-red-400">
                  Exceeds per-tx cap ({formatUsd(sourceTerminal.per_tx_limit_usd)})
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Settlement Memo */}
        <div className="space-y-2">
          <label htmlFor="ntps-transfer-memo" className="block text-xs font-medium text-slate-300">
            Ledger Reference / Memo (Optional)
          </label>
          <input
            id="ntps-transfer-memo"
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="e.g. OTC Desk Settlement Tranche B"
            maxLength={96}
            className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none transition-colors"
          />
        </div>

        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => setIs2FaOpen(true)}
          className="w-full flex items-center justify-center gap-2 py-3 px-5 text-sm font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors"
        >
          Review & Authorize Settlement
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      {/* Right: Masked Recipient Preview & Counterparty Directory */}
      <div className="xl:col-span-5 space-y-5">
        <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-semibold text-slate-100">
            Verified Counterparty Preview
          </h3>

          {counterpartyPreview && !isSelfTransfer ? (
            <div className="space-y-4">
              <div className="bg-[#05070A] border border-emerald-500/30 rounded-lg p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-mono font-bold text-slate-100 tracking-wide">
                        {counterpartyPreview.masked_name}
                      </span>
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                        <BadgeCheck className="w-4 h-4" />
                        Verified
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      {counterpartyPreview.entity_type}
                    </p>
                  </div>
                  <span className="text-xs font-mono text-[#F5C542]">
                    {counterpartyPreview.tier}
                  </span>
                </div>

                <div className="pt-2.5 border-t border-white/[0.06] flex items-center justify-between text-xs">
                  <span className="text-slate-500">Target Terminal</span>
                  <span className="font-mono text-[#00E5FF]">
                    {counterpartyPreview.terminalId}
                  </span>
                </div>
              </div>

              <div className="divide-y divide-white/[0.06] text-xs">
                <div className="flex items-center justify-between py-2">
                  <span className="text-slate-400">Settlement Rail</span>
                  <span className="text-slate-200 font-medium">NTPS Internal Ledger</span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-slate-400">Protocol Fee</span>
                  <span className="font-mono text-emerald-400">$0.00 (Zero-Fee)</span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-slate-400">Finality</span>
                  <span className="text-slate-200">Atomic Sub-Second</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-[#05070A] border border-white/[0.07] rounded-lg p-5 text-center space-y-2">
              <Terminal className="w-6 h-6 text-slate-500 mx-auto" />
              <p className="text-xs text-slate-400">
                Enter a valid <span className="font-mono text-slate-200">NT-OMEGA-XXXX-XXXX</span>{' '}
                ID to reveal masked recipient identity before authorizing funds.
              </p>
            </div>
          )}
        </div>

        {/* Quick Counterparty Directory */}
        <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-white/[0.08]">
            <h3 className="text-xs font-semibold text-slate-200">
              Verified Counterparty & Desk Directory
            </h3>
          </div>
          <div className="divide-y divide-white/[0.06]">
            {COUNTERPARTY_DIRECTORY.map((cp) => (
              <button
                key={cp.terminalId}
                type="button"
                onClick={() => setRecipientInput(cp.terminalId)}
                className="w-full text-left px-5 py-3 hover:bg-white/[0.03] transition-colors flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-slate-100 truncate">
                      {cp.entity_type}
                    </span>
                    <span className="font-mono text-[11px] text-slate-400">
                      ({cp.masked_name})
                    </span>
                  </div>
                  <p className="font-mono text-xs text-[#00E5FF] mt-0.5">{cp.terminalId}</p>
                </div>
                <span className="text-xs text-slate-400 shrink-0">Select</span>
              </button>
            ))}

            {terminals
              .filter((t) => t.id !== sourceTerminal?.id)
              .map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setRecipientInput(t.terminalId)}
                  className="w-full text-left px-5 py-3 hover:bg-white/[0.03] transition-colors flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-slate-100 truncate">
                        {t.label}
                      </span>
                      <span className="text-[11px] text-[#F5C542]">Internal</span>
                    </div>
                    <p className="font-mono text-xs text-slate-300 mt-0.5">{t.terminalId}</p>
                  </div>
                  <span className="text-xs text-slate-400 shrink-0">Select</span>
                </button>
              ))}
          </div>
        </div>
      </div>

      <TwoFactorModal
        open={is2FaOpen}
        title="Authorize Internal Settlement"
        subtitle="2FA step-up verification required before double-entry ledger commit"
        confirmLabel="Confirm Settlement"
        isSubmitting={isSubmitting}
        onClose={() => setIs2FaOpen(false)}
        onConfirm={handleConfirm2Fa}
        summaryRows={[
          { label: 'Source Terminal', value: sourceTerminal?.terminalId ?? '', mono: true },
          { label: 'Recipient Terminal', value: validation.normalized, mono: true, highlight: 'cyan' },
          {
            label: 'Masked Recipient',
            value: counterpartyPreview?.masked_name ?? 'Verified',
            highlight: 'emerald',
          },
          {
            label: 'Amount',
            value: `${formatAssetAmount(parsedAmount || 0, asset)} ${asset} (${formatUsd(usdEquivalent)})`,
            mono: true,
            highlight: 'gold',
          },
          { label: 'Settlement Fee', value: '$0.00 (NTPS Internal)', mono: true, highlight: 'emerald' },
        ]}
      />
    </div>
  );
}
