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
import { useLocale } from '../context/LocaleContext';

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
  const { tr } = useLocale();
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
    onToast(
      tr('Generated valid Crockford Mod-37 Terminal ID', 'تم توليد معرف محطة صالح'),
      fresh,
      'info'
    );
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
        tr('Transfer completed successfully', 'تمت التسوية بنجاح'),
        `${formatAssetAmount(parsedAmount, asset)} ${asset} settled to ${validation.normalized}`,
        'success'
      );
    } catch (err) {
      onToast(
        tr('Settlement failed', 'فشلت التسوية'),
        err instanceof Error ? err.message : 'Unable to settle internal transfer',
        'error'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const borderClass = validation.isEmpty
    ? 'border-[#E2E8F0] focus-within:border-[#1E40AF]'
    : validation.isValid && !isSelfTransfer
      ? 'border-emerald-500 ring-1 ring-emerald-500/20'
      : 'border-red-500 ring-1 ring-red-500/20';

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* Start 7 cols: Transfer Composer */}
      <div className="xl:col-span-7 bg-white border border-[#E2E8F0] rounded-xl p-6 space-y-6 shadow-xs">
        <div className="flex items-start justify-between gap-4 border-b border-[#E2E8F0] pb-4">
          <div>
            <h2 className="text-base font-semibold text-[#0F172A]">
              {tr('Internal Terminal Settlement', 'التسوية الداخلية بين المحطات')}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {tr(
                'Zero-fee, sub-second double-entry settlement between verified NTPS terminals',
                'تسوية فورية بدون رسوم عبر القيد المزدوج بين محطات NTPS الموثقة'
              )}
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 text-xs font-mono font-semibold text-[#0F172A] bg-[#D6FF3D] px-2.5 py-1 rounded-md shrink-0">
            <Zap className="w-3.5 h-3.5" />
            {tr('$0.00 Fee', 'رسوم $0.00')}
          </span>
        </div>

        {/* Source Terminal */}
        <div className="space-y-2">
          <label htmlFor="ntps-source-term" className="block text-xs font-semibold text-[#0F172A]">
            {tr('Source Terminal', 'المحطة المصدر')}
          </label>
          <select
            id="ntps-source-term"
            value={sourceTerminal?.id ?? ''}
            onChange={(e) => setSourceTerminalUuid(e.target.value)}
            className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2.5 text-sm text-[#0F172A] font-mono focus:outline-none transition-colors"
          >
            {activeTerminals.map((t) => (
              <option key={t.id} value={t.id}>
                {t.terminalId} — {t.label} ({t.type === 'master' ? tr('Master', 'رئيسية') : tr('Sub', 'فرعية')})
              </option>
            ))}
          </select>
        </div>

        {/* Recipient Terminal Prompt */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="ntps-recipient-id" className="text-xs font-semibold text-[#0F172A]">
              {tr('Recipient Terminal ID (Crockford Mod-37)', 'معرف المحطة المستلمة (Crockford Mod-37)')}
            </label>
            <button
              type="button"
              onClick={handleGenerateRandomValid}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[#1E40AF] hover:text-[#24489B] transition-colors"
            >
              <Sparkles className="w-3 h-3" />
              {tr('Generate Valid Test ID', 'توليد معرف تجريبي صالح')}
            </button>
          </div>

          <div
            className={`flex items-center bg-[#F8FAFC] border rounded-lg px-3.5 py-2.5 transition-all ${borderClass}`}
          >
            <span className="font-mono text-sm font-bold text-[#1E40AF] me-2 select-none">
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
              className="flex-1 bg-transparent font-mono tabular-nums text-sm sm:text-base text-[#0F172A] placeholder:text-slate-400 focus:outline-none tracking-wider"
            />
            {!validation.isEmpty && (
              <span className="ms-2 shrink-0">
                {validation.isValid && !isSelfTransfer ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-red-600" />
                )}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs min-h-[18px]">
            {validation.isEmpty ? (
              <span className="text-slate-500">
                {tr(
                  'Auto-normalizes spaces, uppercase, and O/I/L Crockford typos',
                  'تطبيع تلقائي للمسافات والأحرف الكبيرة وأخطاء O/I/L'
                )}
              </span>
            ) : isSelfTransfer ? (
              <span className="text-red-600 font-medium">
                {tr(
                  'Recipient Terminal ID must differ from Source Terminal ID.',
                  'يجب أن يختلف معرف المحطة المستلمة عن المحطة المصدر.'
                )}
              </span>
            ) : validation.isValid ? (
              <span className="text-emerald-700 font-mono font-medium">
                {tr('Valid Mod-37 checksum', 'تحقق Mod-37 صالح')} ({validation.type === 'sub' ? tr('Sub-Terminal', 'محطة فرعية') : tr('Master Terminal', 'محطة رئيسية')})
              </span>
            ) : (
              <span className="text-red-600 font-medium">{validation.error}</span>
            )}

            {validation.corrections.length > 0 && (
              <span className="text-slate-500 font-mono text-[11px]">
                {validation.corrections[0]}
              </span>
            )}
          </div>
        </div>

        {/* Asset & Amount */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
          <div className="sm:col-span-4 space-y-2">
            <span className="block text-xs font-semibold text-[#0F172A]">{tr('Asset', 'الأصل')}</span>
            <div className="grid grid-cols-3 gap-1.5 bg-[#F4F7FA] p-1 border border-[#E2E8F0] rounded-lg">
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
                        ? 'bg-[#1E40AF] text-white shadow-xs'
                        : enabled
                          ? 'text-slate-700 hover:text-[#0F172A] hover:bg-white'
                          : 'text-slate-400 cursor-not-allowed'
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
              <label htmlFor="ntps-transfer-amt" className="font-semibold text-[#0F172A]">
                {tr('Settlement Amount', 'مبلغ التسوية')}
              </label>
              <button
                type="button"
                onClick={() => setAmountInput(String(availableBalance))}
                className="font-mono tabular-nums text-[#1E40AF] hover:text-[#24489B] font-medium transition-colors"
              >
                {tr('Avail:', 'المتاح:')} {formatAssetAmount(availableBalance, asset)} {asset} ({tr('Max', 'الحد الأقصى')})
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
                className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg ps-3.5 pe-16 py-2.5 font-mono tabular-nums text-sm text-[#0F172A] placeholder:text-slate-400 focus:outline-none transition-colors"
              />
              <span className="absolute end-3.5 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-500 font-semibold">
                {asset}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="font-mono tabular-nums text-[#1E40AF] font-semibold">
                ≈ {formatUsd(usdEquivalent)}
              </span>
              {exceedsBalance && (
                <span className="text-red-600 font-medium">
                  {tr('Exceeds available balance', 'يتجاوز الرصيد المتاح')}
                </span>
              )}
              {!exceedsBalance && exceedsPerTx && (
                <span className="text-red-600 font-medium">
                  {tr('Exceeds per-tx cap', 'يتجاوز حد المعاملة الواحدة')} ({formatUsd(sourceTerminal.per_tx_limit_usd)})
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Settlement Memo */}
        <div className="space-y-2">
          <label htmlFor="ntps-transfer-memo" className="block text-xs font-semibold text-[#0F172A]">
            {tr('Ledger Reference / Memo (Optional)', 'المرجع / الملاحظة (اختياري)')}
          </label>
          <input
            id="ntps-transfer-memo"
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder={tr('e.g. OTC Desk Settlement Tranche B', 'مثال: تسوية مكتب التداول خارج المنصة')}
            maxLength={96}
            className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2.5 text-sm text-[#0F172A] placeholder:text-slate-400 focus:outline-none transition-colors"
          />
        </div>

        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => setIs2FaOpen(true)}
          className="w-full flex items-center justify-center gap-2 py-3 px-5 text-sm font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors shadow-xs"
        >
          {tr('Review & Authorize Settlement', 'مراجعة واعتماد التسوية')}
          <ArrowRight className="w-4 h-4 rtl:rotate-180" />
        </button>
      </div>

      {/* End 5 cols: Masked Recipient Preview & Counterparty Directory */}
      <div className="xl:col-span-5 space-y-5">
        <div className="bg-white border border-[#E2E8F0] rounded-xl p-6 space-y-4 shadow-xs">
          <h3 className="text-sm font-semibold text-[#0F172A]">
            {tr('Verified Counterparty Preview', 'معاينة الطرف المقابل الموثق')}
          </h3>

          {counterpartyPreview && !isSelfTransfer ? (
            <div className="space-y-4">
              <div className="bg-[#F8FAFC] border border-emerald-200 rounded-lg p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-mono font-bold text-[#0F172A] tracking-wide">
                        {counterpartyPreview.masked_name}
                      </span>
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                        <BadgeCheck className="w-4 h-4" />
                        {tr('Verified', 'موثق')}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 mt-1">
                      {counterpartyPreview.entity_type}
                    </p>
                  </div>
                  <span className="text-xs font-mono font-semibold text-[#1E40AF] bg-blue-50 border border-blue-200 px-2 py-0.5 rounded">
                    {counterpartyPreview.tier}
                  </span>
                </div>

                <div className="pt-2.5 border-t border-[#E2E8F0] flex items-center justify-between text-xs">
                  <span className="text-slate-500">{tr('Target Terminal', 'المحطة المستهدفة')}</span>
                  <span className="font-mono tabular-nums text-[#1E40AF] font-semibold">
                    {counterpartyPreview.terminalId}
                  </span>
                </div>
              </div>

              <div className="divide-y divide-[#E2E8F0] text-xs">
                <div className="flex items-center justify-between py-2">
                  <span className="text-slate-500">{tr('Settlement Rail', 'مسار التسوية')}</span>
                  <span className="text-[#0F172A] font-medium">NTPS Internal Ledger</span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-slate-500">{tr('Protocol Fee', 'رسوم البروتوكول')}</span>
                  <span className="font-mono text-emerald-700 font-semibold">$0.00 (Zero-Fee)</span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-slate-500">{tr('Finality', 'النهائية')}</span>
                  <span className="text-[#0F172A] font-medium">
                    {tr('Atomic Sub-Second', 'ذرية في أجزاء من الثانية')}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-[#F4F7FA] border border-[#E2E8F0] rounded-lg p-5 text-center space-y-2">
              <Terminal className="w-6 h-6 text-[#1E40AF] mx-auto" />
              <p className="text-xs text-slate-600">
                {tr(
                  'Enter a valid NT-OMEGA-XXXX-XXXX ID to reveal masked recipient identity before authorizing funds.',
                  'أدخل معرف NT-OMEGA-XXXX-XXXX صالحاً لإظهار هوية المستلم المقنّعة قبل اعتماد التحويل.'
                )}
              </p>
            </div>
          )}
        </div>

        {/* Quick Counterparty Directory */}
        <div className="bg-white border border-[#E2E8F0] rounded-xl overflow-hidden shadow-xs">
          <div className="px-5 py-3.5 border-b border-[#E2E8F0] bg-[#F8FAFC]">
            <h3 className="text-xs font-semibold text-[#0F172A]">
              {tr('Verified Counterparty & Desk Directory', 'دليل الأطراف والمكاتب الموثقة')}
            </h3>
          </div>
          <div className="divide-y divide-[#E2E8F0]">
            {COUNTERPARTY_DIRECTORY.map((cp) => (
              <button
                key={cp.terminalId}
                type="button"
                onClick={() => setRecipientInput(cp.terminalId)}
                className="w-full text-start px-5 py-3 hover:bg-[#F8FAFC] transition-colors flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-[#0F172A] truncate">
                      {cp.entity_type}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500">
                      ({cp.masked_name})
                    </span>
                  </div>
                  <p className="font-mono tabular-nums text-xs text-[#1E40AF] mt-0.5">
                    {cp.terminalId}
                  </p>
                </div>
                <span className="text-xs font-semibold text-[#1E40AF] shrink-0">
                  {tr('Select', 'اختيار')}
                </span>
              </button>
            ))}

            {terminals
              .filter((t) => t.id !== sourceTerminal?.id)
              .map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setRecipientInput(t.terminalId)}
                  className="w-full text-start px-5 py-3 hover:bg-[#F8FAFC] transition-colors flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-[#0F172A] truncate">
                        {t.label}
                      </span>
                      <span className="text-[11px] font-semibold text-[#1E40AF] bg-blue-50 px-1.5 py-0.5 rounded">
                        {tr('Internal', 'داخلي')}
                      </span>
                    </div>
                    <p className="font-mono tabular-nums text-xs text-slate-600 mt-0.5">
                      {t.terminalId}
                    </p>
                  </div>
                  <span className="text-xs font-semibold text-[#1E40AF] shrink-0">
                    {tr('Select', 'اختيار')}
                  </span>
                </button>
              ))}
          </div>
        </div>
      </div>

      <TwoFactorModal
        open={is2FaOpen}
        title={tr('Authorize Internal Settlement', 'اعتماد التسوية الداخلية')}
        subtitle={tr(
          '2FA step-up verification required before double-entry ledger commit',
          'التحقق الثنائي مطلوب قبل تسجيل القيد المزدوج'
        )}
        confirmLabel={tr('Confirm Settlement', 'تأكيد التسوية')}
        isSubmitting={isSubmitting}
        onClose={() => setIs2FaOpen(false)}
        onConfirm={handleConfirm2Fa}
        summaryRows={[
          { label: tr('Source Terminal', 'المحطة المصدر'), value: sourceTerminal?.terminalId ?? '', mono: true },
          { label: tr('Recipient Terminal', 'المحطة المستلمة'), value: validation.normalized, mono: true, highlight: 'cyan' },
          {
            label: tr('Masked Recipient', 'المستلم المقنّع'),
            value: counterpartyPreview?.masked_name ?? 'Verified',
            highlight: 'emerald',
          },
          {
            label: tr('Amount', 'المبلغ'),
            value: `${formatAssetAmount(parsedAmount || 0, asset)} ${asset} (${formatUsd(usdEquivalent)})`,
            mono: true,
            highlight: 'gold',
          },
          { label: tr('Settlement Fee', 'رسوم التسوية'), value: '$0.00 (NTPS Internal)', mono: true, highlight: 'emerald' },
        ]}
      />
    </div>
  );
}
