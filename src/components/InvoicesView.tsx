import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Copy,
  FileText,
  Plus,
  QrCode,
  ShieldCheck,
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

  // QR Modal inspection state
  const [inspectingInvoice, setInspectingInvoice] = useState<InvoiceRecord | null>(null);

  // Pay Invoice 2FA state
  const [payingInvoice, setPayingInvoice] = useState<InvoiceRecord | null>(null);
  const [isPaying, setIsPaying] = useState(false);

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const num = Number(amount);
    if (!masterTerminal || Number.isNaN(num) || num <= 0) {
      onToast('Invalid invoice amount', 'Enter a positive numeric amount.', 'error');
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
      onToast('Invoice created & signed', 'Signed QR URI generated successfully.', 'success');
    } catch (err) {
      onToast('Failed to create invoice', err instanceof Error ? err.message : 'Error', 'error');
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
        'Invoice settled successfully',
        `${formatAssetAmount(payingInvoice.amount, payingInvoice.asset)} ${payingInvoice.asset} transferred via ledger.`,
        'success'
      );
    } catch (err) {
      onToast('Payment failed', err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setIsPaying(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Payment Requests & Signed QR Invoices
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Cryptographically signed payment URIs with automated double-entry ledger settlement
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] rounded-lg transition-colors whitespace-nowrap"
        >
          <Plus className="w-3.5 h-3.5" />
          Create Signed Invoice
        </button>
      </div>

      {/* Invoices Table */}
      <div className="bg-[#0B0F16] border border-white/[0.08] rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/[0.08]">
          <h3 className="text-sm font-semibold text-slate-100">Active & Settled Invoices</h3>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/[0.08] text-[11px] font-medium text-slate-400 bg-[#05070A]/60">
                <th className="py-2.5 px-4">Invoice #</th>
                <th className="py-2.5 px-3">Description</th>
                <th className="py-2.5 px-3">Recipient Terminal</th>
                <th className="py-2.5 px-3 text-right">Amount</th>
                <th className="py-2.5 px-3">Expires</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05] text-xs">
              {invoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-white/[0.025] transition-colors">
                  <td className="py-3 px-4 font-mono font-semibold text-slate-200 whitespace-nowrap">
                    {inv.invoice_number}
                  </td>
                  <td className="py-3 px-3 text-slate-300 max-w-xs truncate">{inv.description}</td>
                  <td className="py-3 px-3 font-mono text-[#00E5FF] whitespace-nowrap">
                    {resolveTerminalCode(terminals, inv.terminalUuid)}
                  </td>
                  <td className="py-3 px-3 font-mono tabular-nums text-right text-slate-100 font-medium whitespace-nowrap">
                    {formatAssetAmount(inv.amount, inv.asset)} <span className="text-slate-400">{inv.asset}</span>
                  </td>
                  <td className="py-3 px-3 font-mono text-slate-400 whitespace-nowrap">
                    {formatTimestamp(inv.expires_at)}
                  </td>
                  <td className="py-3 px-3 whitespace-nowrap">
                    <span
                      className={`inline-flex items-center gap-1 font-medium capitalize px-2 py-0.5 rounded text-[11px] ${
                        inv.status === 'paid'
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : inv.status === 'open'
                            ? 'bg-[#00E5FF]/10 text-[#00E5FF] border border-[#00E5FF]/20'
                            : 'bg-red-500/10 text-red-400 border border-red-500/20'
                      }`}
                    >
                      {inv.status === 'paid' && <CheckCircle2 className="w-3 h-3" />}
                      {inv.status === 'open' && <Clock className="w-3 h-3" />}
                      {inv.status === 'expired' && <AlertTriangle className="w-3 h-3" />}
                      {inv.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right whitespace-nowrap space-x-2">
                    <button
                      type="button"
                      onClick={() => setInspectingInvoice(inv)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-200 bg-white/[0.05] hover:bg-white/[0.10] border border-white/[0.08] rounded-md transition-colors"
                    >
                      <QrCode className="w-3 h-3 text-[#00E5FF]" />
                      QR / URI
                    </button>
                    {inv.status === 'open' && (
                      <button
                        type="button"
                        onClick={() => setPayingInvoice(inv)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] rounded-md transition-colors"
                      >
                        <Zap className="w-3 h-3" />
                        Simulate Pay
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Invoice Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-[#0B0F16] border border-white/[0.1] rounded-xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08]">
              <div className="flex items-center gap-2.5">
                <FileText className="w-4 h-4 text-[#00E5FF]" />
                <h3 className="text-sm font-semibold text-slate-100">Create Signed Invoice</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-white p-1"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-300">Asset</label>
                  <select
                    value={asset}
                    onChange={(e) => setAsset(e.target.value as AssetSymbol)}
                    className="w-full bg-[#05070A] border border-white/[0.12] rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none"
                  >
                    <option value="USDT">USDT</option>
                    <option value="BTC">BTC</option>
                    <option value="ETH">ETH</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-300">Amount</label>
                  <input
                    type="number"
                    step="any"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full bg-[#05070A] border border-white/[0.12] rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Description / Purpose</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Q4 Settlement Tranche"
                  className="w-full bg-[#05070A] border border-white/[0.12] rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-300">Expiry (Hours)</label>
                  <input
                    type="number"
                    value={expiryHours}
                    onChange={(e) => setExpiryHours(e.target.value)}
                    className="w-full bg-[#05070A] border border-white/[0.12] rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-300">Target Payer Terminal</label>
                  <select
                    value={payerTerminalUuid}
                    onChange={(e) => setPayerTerminalUuid(e.target.value)}
                    className="w-full bg-[#05070A] border border-white/[0.12] rounded-lg px-3 py-2 text-xs font-mono text-slate-100 focus:outline-none"
                  >
                    {terminals.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.terminalId} ({t.label})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-white/[0.08]">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-xs text-slate-300 bg-white/[0.05] rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreating}
                  className="px-5 py-2 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] rounded-lg"
                >
                  {isCreating ? 'Signing & Creating...' : 'Generate Signed QR'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* QR Code & Signed URI Modal */}
      {inspectingInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-[#0B0F16] border border-white/[0.1] rounded-xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.08]">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  {inspectingInvoice.invoice_number}
                </h3>
                <p className="text-xs text-slate-400">{inspectingInvoice.description}</p>
              </div>
              <button
                type="button"
                onClick={() => setInspectingInvoice(null)}
                className="text-slate-400 hover:text-white p-1"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 flex flex-col items-center gap-5">
              <div className="p-4 bg-white rounded-xl">
                <QRCodeSVG value={inspectingInvoice.signed_uri} size={180} level="M" bgColor="#FFFFFF" fgColor="#05070A" />
              </div>

              <div className="w-full space-y-1.5 text-center">
                <p className="font-mono text-lg font-bold text-[#F5C542]">
                  {formatAssetAmount(inspectingInvoice.amount, inspectingInvoice.asset)} {inspectingInvoice.asset}
                </p>
                <p className="text-[11px] font-mono text-slate-400 break-all bg-[#05070A] p-2.5 rounded border border-white/[0.07]">
                  {inspectingInvoice.signed_uri}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 w-full">
                <button
                  type="button"
                  onClick={() => onCopy(inspectingInvoice.signed_uri, 'Copied signed invoice URI')}
                  className="flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-medium text-slate-100 bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] rounded-lg"
                >
                  <Copy className="w-3.5 h-3.5 text-[#00E5FF]" />
                  Copy URI
                </button>
                {inspectingInvoice.status === 'open' && (
                  <button
                    type="button"
                    onClick={() => {
                      setPayingInvoice(inspectingInvoice);
                    }}
                    className="flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] rounded-lg"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    Pay Now
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
        title="Authorize Invoice Settlement"
        subtitle={`Settle ${payingInvoice?.invoice_number} via double-entry ledger`}
        confirmLabel="Confirm & Pay Invoice"
        isSubmitting={isPaying}
        onClose={() => setPayingInvoice(null)}
        onConfirm={handleConfirmPayInvoice}
        summaryRows={[
          { label: 'Invoice #', value: payingInvoice?.invoice_number ?? '', mono: true },
          { label: 'Description', value: payingInvoice?.description ?? '' },
          {
            label: 'Recipient Terminal',
            value: resolveTerminalCode(terminals, payingInvoice?.terminalUuid),
            mono: true,
            highlight: 'cyan',
          },
          {
            label: 'Total Amount',
            value: `${formatAssetAmount(payingInvoice?.amount ?? 0, payingInvoice?.asset ?? 'USDT')} ${payingInvoice?.asset ?? 'USDT'}`,
            mono: true,
            highlight: 'gold',
          },
          { label: 'Settlement Fee', value: '$0.00 (Zero-Fee Internal)', highlight: 'emerald' },
        ]}
      />
    </div>
  );
}
