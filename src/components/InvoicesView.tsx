import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Copy,
  FileText,
  Plus,
  QrCode,
  Zap,
  X,
  CheckCircle2,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import type { AssetSymbol, InvoiceRecord, TerminalRecord, WalletBalance } from '../types/ntps';
import { resolveTerminalCode } from '../lib/ledgerEngine';
import { formatAssetAmount, formatTimestamp } from '../lib/format';
import { TwoFactorModal } from './TwoFactorModal';
import { useLocale } from '../context/LocaleContext';

interface InvoicesViewProps {
  terminals: TerminalRecord[];
  wallets: WalletBalance[];
  invoices: InvoiceRecord[];
  onCreateInvoice: (params: {
    terminalUuid: string;
    payerTerminalId?: string;
    asset: AssetSymbol;
    amount: number;
    description: string;
    expiryHours?: number;
  }) => Promise<void>;
  onPayInvoice: (params: { invoiceId: string; payerTerminalUuid: string }) => Promise<void>;
  onCopy: (text: string, label: string) => void;
  onToast: (title: string, description?: string, variant?: 'success' | 'error' | 'info') => void;
}

export function InvoicesView({
  terminals,
  invoices,
  onCreateInvoice,
  onPayInvoice,
  onCopy,
  onToast,
}: InvoicesViewProps) {
  const { tr } = useLocale();
  const masterTerminal = terminals.find((t) => t.type === 'master') ?? terminals[0];
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [asset, setAsset] = useState<AssetSymbol>('USDT');
  const [amount, setAmount] = useState('50000');
  const [description, setDescription] = useState('Q4 Liquidity Tranche Settlement');
  const [expiryHours, setExpiryHours] = useState('24');
  const [payerTerminalUuid, setPayerTerminalUuid] = useState(
    terminals[1]?.id ?? terminals[0]?.id ?? ''
  );
  const [isCreating, setIsCreating] = useState(false);

  const [inspectingInvoice, setInspectingInvoice] = useState<InvoiceRecord | null>(null);
  const [payingInvoice, setPayingInvoice] = useState<InvoiceRecord | null>(null);
  const [isPaying, setIsPaying] = useState(false);

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const num = Number(amount);
    if (!masterTerminal || Number.isNaN(num) || num <= 0) {
      onToast(
        tr('Invalid invoice amount', 'مبلغ الفاتورة غير صالح'),
        tr('Enter a positive numeric amount.', 'أدخل مبلغاً رقمياً موجباً.'),
        'error'
      );
      return;
    }
    const payerTerm = terminals.find((t) => t.id === payerTerminalUuid);
    setIsCreating(true);
    try {
      await onCreateInvoice({
        terminalUuid: masterTerminal.id,
        payerTerminalId: payerTerm?.terminalId || undefined,
        asset,
        amount: num,
        description: description.trim() || 'NTPS Invoice',
        expiryHours: Number(expiryHours) || 24,
      });
      setShowCreateModal(false);
      setAmount('10000');
      onToast(
        tr('Invoice created & signed', 'تم إنشاء وتوقيع الفاتورة'),
        tr('Signed QR URI generated successfully.', 'تم إنشاء رابط QR الموقع بنجاح.'),
        'success'
      );
    } catch (err) {
      onToast(
        tr('Failed to create invoice', 'فشل إنشاء الفاتورة'),
        err instanceof Error ? err.message : 'Error',
        'error'
      );
    } finally {
      setIsCreating(false);
    }
  };

  const handleConfirmPayInvoice = async () => {
    if (!payingInvoice) return;
    const fallbackPayer =
      terminals.find((t) => t.id === payerTerminalUuid && t.id !== payingInvoice.terminalUuid) ??
      terminals.find((t) => t.id !== payingInvoice.terminalUuid) ??
      masterTerminal;
    if (!fallbackPayer) return;

    setIsPaying(true);
    try {
      await onPayInvoice({
        invoiceId: payingInvoice.id,
        payerTerminalUuid: fallbackPayer.id,
      });
      setPayingInvoice(null);
      setInspectingInvoice(null);
      onToast(
        tr('Invoice settled successfully', 'تمت تسوية الفاتورة بنجاح'),
        `${formatAssetAmount(payingInvoice.amount, payingInvoice.asset)} ${payingInvoice.asset} transferred via ledger.`,
        'success'
      );
    } catch (err) {
      onToast(tr('Payment failed', 'فشل الدفع'), err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setIsPaying(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="bg-white border border-[#E2E8F0] rounded-xl p-6 flex flex-wrap items-center justify-between gap-4 shadow-xs">
        <div>
          <h2 className="text-base font-semibold text-[#0F172A]">
            {tr('Payment Requests & Signed QR Invoices', 'طلبات الدفع وفواتير QR الموقعة')}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {tr(
              'Cryptographically signed payment URIs with automated double-entry ledger settlement',
              'روابط دفع موقعة تشفيرياً مع تسوية آلية عبر دفتر القيد المزدوج'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors whitespace-nowrap shadow-xs"
        >
          <Plus className="w-3.5 h-3.5" />
          {tr('Create Signed Invoice', 'إنشاء فاتورة موقعة')}
        </button>
      </div>

      {/* Invoices Table */}
      <div className="bg-white border border-[#E2E8F0] rounded-xl overflow-hidden shadow-xs">
        <div className="px-5 py-4 border-b border-[#E2E8F0]">
          <h3 className="text-sm font-semibold text-[#0F172A]">
            {tr('Active & Settled Invoices', 'الفواتير النشطة والمسواة')}
          </h3>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-start border-collapse">
            <thead>
              <tr className="border-b border-[#E2E8F0] text-[11px] font-semibold text-[#0F172A] bg-[#F8FAFC]">
                <th className="py-2.5 px-4 text-start">{tr('Invoice #', 'رقم الفاتورة')}</th>
                <th className="py-2.5 px-3 text-start">{tr('Description', 'الوصف')}</th>
                <th className="py-2.5 px-3 text-start">{tr('Recipient Terminal', 'المحطة المستلمة')}</th>
                <th className="py-2.5 px-3 text-end">{tr('Amount', 'المبلغ')}</th>
                <th className="py-2.5 px-3 text-start">{tr('Expires', 'تنتهي في')}</th>
                <th className="py-2.5 px-3 text-start">{tr('Status', 'الحالة')}</th>
                <th className="py-2.5 px-4 text-end">{tr('Actions', 'الإجراءات')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0] text-xs bg-white">
              {invoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-[#F8FAFC] transition-colors">
                  <td className="py-3 px-4 font-mono tabular-nums font-semibold text-[#0F172A] whitespace-nowrap">
                    {inv.invoice_number}
                  </td>
                  <td className="py-3 px-3 text-slate-700 max-w-xs truncate">{inv.description}</td>
                  <td className="py-3 px-3 font-mono tabular-nums text-[#1E40AF] font-medium whitespace-nowrap">
                    {resolveTerminalCode(terminals, inv.terminalUuid)}
                  </td>
                  <td className="py-3 px-3 font-mono tabular-nums text-end text-[#0F172A] font-semibold whitespace-nowrap">
                    {formatAssetAmount(inv.amount, inv.asset)}{' '}
                    <span className="text-slate-500 font-normal">{inv.asset}</span>
                  </td>
                  <td className="py-3 px-3 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                    {formatTimestamp(inv.expires_at)}
                  </td>
                  <td className="py-3 px-3 whitespace-nowrap">
                    <span
                      className={`inline-flex items-center gap-1 font-semibold capitalize px-2 py-0.5 rounded-md text-[11px] border ${
                        inv.status === 'paid'
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : inv.status === 'open'
                            ? 'bg-blue-50 text-[#1E40AF] border-blue-200'
                            : 'bg-red-50 text-red-700 border-red-200'
                      }`}
                    >
                      {inv.status === 'paid' && <CheckCircle2 className="w-3 h-3" />}
                      {inv.status === 'open' && <Clock className="w-3 h-3" />}
                      {inv.status === 'expired' && <AlertTriangle className="w-3 h-3" />}
                      {inv.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-end whitespace-nowrap">
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setInspectingInvoice(inv)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-[#0F172A] bg-[#F4F7FA] hover:bg-slate-200/70 border border-[#E2E8F0] rounded-md transition-colors"
                      >
                        <QrCode className="w-3 h-3 text-[#1E40AF]" />
                        QR / URI
                      </button>
                      {inv.status === 'open' && (
                        <button
                          type="button"
                          onClick={() => setPayingInvoice(inv)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-md transition-colors"
                        >
                          <Zap className="w-3 h-3" />
                          {tr('Simulate Pay', 'محاكاة الدفع')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Invoice Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#0F172A]/65 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-white border border-[#E2E8F0] rounded-xl shadow-2xl overflow-hidden">
            <div className="cobalt-hero-surface flex items-center justify-between px-6 py-4 text-white border-b border-[#24489B]">
              <div className="flex items-center gap-2.5">
                <FileText className="w-4 h-4 text-[#D6FF3D]" />
                <h3 className="text-sm font-semibold text-white">
                  {tr('Create Signed Invoice', 'إنشاء فاتورة موقعة')}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="text-blue-100 hover:text-white p-1"
                aria-label={tr('Close modal', 'إغلاق النافذة')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="p-6 space-y-4 bg-white">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-[#0F172A]">
                    {tr('Asset', 'الأصل')}
                  </label>
                  <select
                    value={asset}
                    onChange={(e) => setAsset(e.target.value as AssetSymbol)}
                    className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3 py-2 text-xs font-mono text-[#0F172A] focus:outline-none"
                  >
                    <option value="USDT">USDT</option>
                    <option value="BTC">BTC</option>
                    <option value="ETH">ETH</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-[#0F172A]">
                    {tr('Amount', 'المبلغ')}
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3 py-2 text-xs font-mono tabular-nums text-[#0F172A] focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-[#0F172A]">
                  {tr('Description / Purpose', 'الوصف / الغرض')}
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Q4 Settlement Tranche"
                  className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3 py-2 text-xs text-[#0F172A] placeholder:text-slate-400 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-[#0F172A]">
                    {tr('Expiry (Hours)', 'الصلاحية (ساعات)')}
                  </label>
                  <input
                    type="number"
                    value={expiryHours}
                    onChange={(e) => setExpiryHours(e.target.value)}
                    className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3 py-2 text-xs font-mono tabular-nums text-[#0F172A] focus:outline-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-[#0F172A]">
                    {tr('Target Payer Terminal', 'المحطة الدافعة المستهدفة')}
                  </label>
                  <select
                    value={payerTerminalUuid}
                    onChange={(e) => setPayerTerminalUuid(e.target.value)}
                    className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3 py-2 text-xs font-mono text-[#0F172A] focus:outline-none"
                  >
                    {terminals.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.terminalId} ({t.label})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-[#E2E8F0]">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-600 bg-[#F4F7FA] hover:bg-slate-200/70 border border-[#E2E8F0] rounded-lg"
                >
                  {tr('Cancel', 'إلغاء')}
                </button>
                <button
                  type="submit"
                  disabled={isCreating}
                  className="px-5 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg shadow-xs"
                >
                  {isCreating
                    ? tr('Signing & Creating...', 'جاري التوقيع والإنشاء...')
                    : tr('Generate Signed QR', 'إنشاء رمز QR موقع')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* QR Code & Signed URI Modal */}
      {inspectingInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#0F172A]/65 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-white border border-[#E2E8F0] rounded-xl shadow-2xl overflow-hidden">
            <div className="cobalt-hero-surface flex items-center justify-between px-5 py-4 text-white border-b border-[#24489B]">
              <div>
                <h3 className="text-sm font-semibold text-white">
                  {inspectingInvoice.invoice_number}
                </h3>
                <p className="text-xs text-blue-100/85">{inspectingInvoice.description}</p>
              </div>
              <button
                type="button"
                onClick={() => setInspectingInvoice(null)}
                className="text-blue-100 hover:text-white p-1"
                aria-label={tr('Close modal', 'إغلاق النافذة')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 flex flex-col items-center gap-5 bg-white">
              <div className="p-4 bg-white rounded-xl border border-[#E2E8F0] shadow-xs">
                <QRCodeSVG
                  value={inspectingInvoice.signed_uri}
                  size={180}
                  level="M"
                  bgColor="#FFFFFF"
                  fgColor="#0F172A"
                />
              </div>

              <div className="w-full space-y-2 text-center">
                <p className="font-mono tabular-nums text-lg font-bold text-[#1E40AF]">
                  {formatAssetAmount(inspectingInvoice.amount, inspectingInvoice.asset)}{' '}
                  {inspectingInvoice.asset}
                </p>
                <p className="text-[11px] font-mono text-slate-600 break-all bg-[#F4F7FA] p-2.5 rounded-lg border border-[#E2E8F0]">
                  {inspectingInvoice.signed_uri}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 w-full">
                <button
                  type="button"
                  onClick={() =>
                    onCopy(
                      inspectingInvoice.signed_uri,
                      tr('Copied signed invoice URI', 'تم نسخ رابط الفاتورة الموقع')
                    )
                  }
                  className="flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-medium text-[#0F172A] bg-[#F4F7FA] hover:bg-slate-200/70 border border-[#E2E8F0] rounded-lg"
                >
                  <Copy className="w-3.5 h-3.5 text-[#1E40AF]" />
                  {tr('Copy URI', 'نسخ الرابط')}
                </button>
                {inspectingInvoice.status === 'open' && (
                  <button
                    type="button"
                    onClick={() => {
                      setPayingInvoice(inspectingInvoice);
                    }}
                    className="flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg shadow-xs"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    {tr('Pay Now', 'ادفع الآن')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 2FA Modal for Paying Invoice */}
      <TwoFactorModal
        open={Boolean(payingInvoice)}
        title={tr('Authorize Invoice Settlement', 'اعتماد تسوية الفاتورة')}
        subtitle={`${tr('Settle', 'تسوية')} ${payingInvoice?.invoice_number} ${tr('via double-entry ledger', 'عبر دفتر القيد المزدوج')}`}
        confirmLabel={tr('Confirm & Pay Invoice', 'تأكيد ودفع الفاتورة')}
        isSubmitting={isPaying}
        onClose={() => setPayingInvoice(null)}
        onConfirm={handleConfirmPayInvoice}
        summaryRows={[
          { label: tr('Invoice #', 'رقم الفاتورة'), value: payingInvoice?.invoice_number ?? '', mono: true },
          { label: tr('Description', 'الوصف'), value: payingInvoice?.description ?? '' },
          {
            label: tr('Recipient Terminal', 'المحطة المستلمة'),
            value: resolveTerminalCode(terminals, payingInvoice?.terminalUuid),
            mono: true,
            highlight: 'cyan',
          },
          {
            label: tr('Total Amount', 'المبلغ الإجمالي'),
            value: `${formatAssetAmount(payingInvoice?.amount ?? 0, payingInvoice?.asset ?? 'USDT')} ${payingInvoice?.asset ?? 'USDT'}`,
            mono: true,
            highlight: 'gold',
          },
          {
            label: tr('Settlement Fee', 'رسوم التسوية'),
            value: tr('$0.00 (Zero-Fee Internal)', '$0.00 (داخلي بدون رسوم)'),
            highlight: 'emerald',
          },
        ]}
      />
    </div>
  );
}
