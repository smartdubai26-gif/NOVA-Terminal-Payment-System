import { QRCodeSVG } from 'qrcode.react';
import { Copy, Share2, X } from 'lucide-react';

interface TerminalQrModalProps {
  open: boolean;
  terminalId: string;
  label: string;
  onClose: () => void;
  onCopy: (text: string, msg: string) => void;
}

export function TerminalQrModal({
  open,
  terminalId,
  label,
  onClose,
  onCopy,
}: TerminalQrModalProps) {
  if (!open) return null;

  const paymentUri = `ntps://terminal/${terminalId}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ntps-qr-title"
        className="w-full max-w-sm bg-[#0B0F16] border border-white/[0.1] rounded-xl shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08]">
          <div>
            <h3 id="ntps-qr-title" className="text-sm font-semibold text-slate-100">
              Terminal Payment QR
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">{label}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-md transition-colors"
            aria-label="Close QR modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 flex flex-col items-center gap-5">
          <div className="p-4 bg-white rounded-xl shadow-inner">
            <QRCodeSVG
              value={paymentUri}
              size={188}
              level="M"
              bgColor="#FFFFFF"
              fgColor="#05070A"
            />
          </div>

          <div className="w-full text-center space-y-1">
            <p className="font-mono text-sm font-semibold text-[#00E5FF] tracking-wide">
              {terminalId}
            </p>
            <p className="text-xs text-slate-400">
              Scan from any NTPS-enabled counterparty desk for zero-fee settlement.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 w-full">
            <button
              type="button"
              onClick={() => onCopy(terminalId, 'Copied Terminal ID to clipboard')}
              className="flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-medium text-slate-200 bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] rounded-lg transition-colors whitespace-nowrap"
            >
              <Copy className="w-3.5 h-3.5" />
              Copy ID
            </button>
            <button
              type="button"
              onClick={() => onCopy(paymentUri, 'Copied NTPS payment URI')}
              className="flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] rounded-lg transition-colors whitespace-nowrap"
            >
              <Share2 className="w-3.5 h-3.5" />
              Copy URI
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
