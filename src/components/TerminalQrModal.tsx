import { QRCodeSVG } from 'qrcode.react';
import { Copy, Share2, X } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

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
  const { tr } = useLocale();
  if (!open) return null;

  const paymentUri = `ntps://terminal/${terminalId}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#0F172A]/65 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ntps-qr-title"
        className="w-full max-w-sm bg-white border border-[#E2E8F0] rounded-xl shadow-2xl overflow-hidden"
      >
        <div className="cobalt-hero-surface flex items-center justify-between px-6 py-4 text-white border-b border-[#24489B]">
          <div>
            <h3 id="ntps-qr-title" className="text-sm font-semibold text-white">
              {tr('Terminal Payment QR', 'رمز الدفع للمحطة')}
            </h3>
            <p className="text-xs text-blue-100/85 mt-0.5">{label}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-blue-100 hover:text-white p-1 rounded-md transition-colors"
            aria-label={tr('Close QR modal', 'إغلاق نافذة الرمز')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 flex flex-col items-center gap-5 bg-white">
          <div className="p-4 bg-white rounded-xl border border-[#E2E8F0] shadow-xs">
            <QRCodeSVG
              value={paymentUri}
              size={188}
              level="M"
              bgColor="#FFFFFF"
              fgColor="#0F172A"
            />
          </div>

          <div className="w-full text-center space-y-1">
            <p className="font-mono tabular-nums text-sm font-bold text-[#1E40AF] tracking-wide">
              {terminalId}
            </p>
            <p className="text-xs text-slate-600">
              {tr(
                'Scan from any NTPS-enabled counterparty desk for zero-fee settlement.',
                'امسح الرمز من أي مكتب مقابل يدعم NTPS لتسوية بدون رسوم.'
              )}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 w-full">
            <button
              type="button"
              onClick={() => onCopy(terminalId, tr('Copied Terminal ID to clipboard', 'تم نسخ معرف المحطة'))}
              className="flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-medium text-[#0F172A] bg-[#F4F7FA] hover:bg-slate-200/70 border border-[#E2E8F0] rounded-lg transition-colors whitespace-nowrap"
            >
              <Copy className="w-3.5 h-3.5 text-[#1E40AF]" />
              {tr('Copy ID', 'نسخ المعرف')}
            </button>
            <button
              type="button"
              onClick={() => onCopy(paymentUri, tr('Copied NTPS payment URI', 'تم نسخ رابط الدفع'))}
              className="flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors whitespace-nowrap shadow-xs"
            >
              <Share2 className="w-3.5 h-3.5" />
              {tr('Copy URI', 'نسخ الرابط')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
