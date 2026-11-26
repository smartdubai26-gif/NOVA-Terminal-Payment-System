import { AlertCircle, Copy, Database, X } from 'lucide-react';
import { SUPABASE_SQL_SCHEMA, isSupabaseConfigured } from '../lib/supabase';
import { useLocale } from '../context/LocaleContext';

interface SchemaModalProps {
  open: boolean;
  onClose: () => void;
  onCopy: (text: string, msg: string) => void;
}

export function SchemaModal({ open, onClose, onCopy }: SchemaModalProps) {
  const { tr } = useLocale();
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#0F172A]/65 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ntps-schema-title"
        className="w-full max-w-3xl bg-white border border-[#E2E8F0] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
      >
        <div className="cobalt-hero-surface flex items-center justify-between px-6 py-4 text-white border-b border-[#24489B]">
          <div className="flex items-center gap-3">
            <Database className="w-4 h-4 text-[#D6FF3D]" />
            <div>
              <h3 id="ntps-schema-title" className="text-sm font-semibold text-white">
                {tr('Supabase Double-Entry SQL Schema', 'مخطط SQL لدفتر القيد المزدوج')}
              </h3>
              <p className="text-xs text-blue-100/85 mt-0.5">
                {isSupabaseConfigured
                  ? tr('Connected to configured Supabase instance', 'متصل بنسخة Supabase المكونة')
                  : tr(
                      'Running local double-entry ledger engine · Configure VITE_SUPABASE_URL & VITE_SUPABASE_ANON_KEY to sync',
                      'يعمل بمحرك الدفتر المحلي · قم بإعداد متغيرات Supabase للمزامنة'
                    )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onCopy(SUPABASE_SQL_SCHEMA, tr('Copied Supabase SQL DDL to clipboard', 'تم نسخ مخطط SQL'))}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors whitespace-nowrap"
            >
              <Copy className="w-3.5 h-3.5" />
              {tr('Copy SQL', 'نسخ SQL')}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-blue-100 hover:text-white p-1.5 rounded-md transition-colors"
              aria-label={tr('Close SQL schema viewer', 'إغلاق عارض المخطط')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-6 py-3 bg-amber-50 border-b border-amber-200 flex items-start gap-2.5 text-xs text-amber-900">
          <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
          <p className="leading-relaxed">
            <span className="font-semibold">{tr('Base Schema Only:', 'المخطط الأساسي فقط:')}</span> This viewer displays{' '}
            <code className="font-mono text-[#0F172A] bg-white px-1 py-0.5 rounded border border-amber-200">
              supabase/schema.sql
            </code>
            . For production hardening, apply{' '}
            <code className="font-mono text-[#0F172A] bg-white px-1 py-0.5 rounded border border-amber-200">
              supabase/migrations/001_harden_rls.sql
            </code>{' '}
            through{' '}
            <code className="font-mono text-[#0F172A] bg-white px-1 py-0.5 rounded border border-amber-200">
              012_kyc_audit_round6_hardening.sql
            </code>{' '}
            in sequential order afterward.
          </p>
        </div>

        <div className="p-6 overflow-y-auto bg-[#F8FAFC]">
          <pre className="font-mono text-xs text-[#0F172A] leading-relaxed whitespace-pre-wrap">
            {SUPABASE_SQL_SCHEMA}
          </pre>
        </div>
      </div>
    </div>
  );
}
