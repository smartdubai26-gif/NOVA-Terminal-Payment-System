import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import type { ToastItem } from '../types/ntps';

interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed bottom-5 right-5 z-50 flex flex-col gap-2.5 max-w-sm w-full pointer-events-none"
    >
      {toasts.map((toast) => {
        const icon =
          toast.variant === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          ) : toast.variant === 'error' ? (
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          ) : (
            <Info className="w-4 h-4 text-[#00E5FF] shrink-0 mt-0.5" />
          );

        return (
          <div
            key={toast.id}
            className="pointer-events-auto flex items-start gap-3 bg-[#0B0F16]/95 backdrop-blur-md border border-white/[0.1] rounded-lg px-4 py-3 shadow-2xl transition-all duration-150"
          >
            {icon}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-100 leading-snug">{toast.title}</p>
              {toast.description && (
                <p className="text-xs text-slate-400 mt-0.5 leading-relaxed break-words">
                  {toast.description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="text-slate-500 hover:text-slate-200 transition-colors p-0.5 rounded"
              aria-label="Dismiss notification"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
