import { AlertCircle, Copy, Database, X } from 'lucide-react';
import { SUPABASE_SQL_SCHEMA, isSupabaseConfigured } from '../lib/supabase';

interface SchemaModalProps {
  open: boolean;
  onClose: () => void;
  onCopy: (text: string, msg: string) => void;
}

export function SchemaModal({ open, onClose, onCopy }: SchemaModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ntps-schema-title"
        className="w-full max-w-3xl bg-[#0B0F16] border border-white/[0.1] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08]">
          <div className="flex items-center gap-3">
            <Database className="w-4 h-4 text-[#00E5FF]" />
            <div>
              <h3 id="ntps-schema-title" className="text-sm font-semibold text-slate-100">
                Supabase Double-Entry SQL Schema
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {isSupabaseConfigured
                  ? 'Connected to configured Supabase instance'
                  : 'Running local double-entry ledger engine · Configure VITE_SUPABASE_URL & VITE_SUPABASE_ANON_KEY to sync'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onCopy(SUPABASE_SQL_SCHEMA, 'Copied Supabase SQL DDL to clipboard')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#00E5FF] bg-[#00E5FF]/10 hover:bg-[#00E5FF]/20 border border-[#00E5FF]/25 rounded-lg transition-colors whitespace-nowrap"
            >
              <Copy className="w-3.5 h-3.5" />
              Copy SQL
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-white p-1.5 rounded-md transition-colors"
              aria-label="Close SQL schema viewer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-6 py-3 bg-amber-500/10 border-b border-amber-500/20 flex items-start gap-2.5 text-xs text-amber-200">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="leading-relaxed">
            <span className="font-semibold">Base Schema Only:</span> This viewer displays{' '}
            <code className="font-mono text-white">supabase/schema.sql</code>. For production
            hardening, apply{' '}
            <code className="font-mono text-white">supabase/migrations/001_harden_rls.sql</code>{' '}
            through{' '}
            <code className="font-mono text-white">012_kyc_audit_round6_hardening.sql</code> in
            sequential order afterward.
          </p>
        </div>

        <div className="p-6 overflow-y-auto bg-[#05070A]">
          <pre className="font-mono text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">
            {SUPABASE_SQL_SCHEMA}
          </pre>
        </div>
      </div>
    </div>
  );
}
