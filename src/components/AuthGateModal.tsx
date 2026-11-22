import { useState, type FormEvent } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  Lock,
  LogIn,
  LogOut,
  ShieldCheck,
  Terminal,
  UserCheck,
  X,
} from 'lucide-react';
import { LOCAL_DEMO_EMAIL, LOCAL_DEMO_USER_ID, type AuthMode } from '../hooks/useSupabaseAuth';
import type { ToastItem } from '../types/ntps';

interface AuthGateModalProps {
  open: boolean;
  canDismiss: boolean;
  isSupabaseConfigured: boolean;
  authMode: AuthMode;
  session: Session | null;
  user: User | null;
  demoModeEnabled: boolean;
  onToggleDemoMode: (enabled: boolean) => void;
  onSignIn: (email: string, password: string) => Promise<{ error: string | null }>;
  onSignUp: (
    email: string,
    password: string
  ) => Promise<{ error: string | null; requiresEmailConfirmation: boolean }>;
  onSignOut: () => Promise<{ error: string | null }>;
  onClose: () => void;
  onToast: (title: string, description?: string, variant?: ToastItem['variant']) => void;
}

export function AuthGateModal({
  open,
  canDismiss,
  isSupabaseConfigured,
  authMode,
  session,
  user,
  demoModeEnabled,
  onToggleDemoMode,
  onSignIn,
  onSignUp,
  onSignOut,
  onClose,
  onToast,
}: AuthGateModalProps) {
  const [tab, setTab] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setInfoMessage(null);

    if (!email.trim() || !password) {
      setErrorMessage('Enter both email address and password.');
      return;
    }

    if (password.length < 6) {
      setErrorMessage('Password must be at least 6 characters.');
      return;
    }

    setSubmitting(true);
    try {
      if (tab === 'signin') {
        const res = await onSignIn(email, password);
        if (res.error) {
          setErrorMessage(res.error);
        } else {
          onToast('Supabase session active', email.trim(), 'success');
          onClose();
        }
      } else {
        const res = await onSignUp(email, password);
        if (res.error) {
          setErrorMessage(res.error);
        } else if (res.requiresEmailConfirmation) {
          setInfoMessage(
            'Account created. Check your inbox to confirm your email address before signing in.'
          );
          onToast('Confirmation email sent', email.trim(), 'info');
        } else {
          onToast('Operator account provisioned', email.trim(), 'success');
          onClose();
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleEnableDemo = () => {
    onToggleDemoMode(true);
    onToast('Local Demo Mode enabled', 'Operating with sandboxed double-entry ledger', 'info');
    onClose();
  };

  const handleSignOut = async () => {
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const res = await onSignOut();
      if (res.error) {
        setErrorMessage(res.error);
      } else {
        onToast('Signed out of Supabase', 'Session terminated cleanly', 'info');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const sessionExpiry = session?.expires_at
    ? new Date(session.expires_at * 1000).toLocaleString()
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ntps-auth-title"
        className="w-full max-w-md bg-[#0B0F16] border border-white/[0.1] rounded-xl shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08]">
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-lg bg-[#00E5FF]/12 border border-[#00E5FF]/30 flex items-center justify-center">
              {authMode === 'supabase' ? (
                <ShieldCheck className="w-4 h-4 text-[#00E39A]" />
              ) : (
                <Lock className="w-4 h-4 text-[#00E5FF]" />
              )}
            </span>
            <div>
              <h3 id="ntps-auth-title" className="text-sm font-semibold text-slate-100">
                {isSupabaseConfigured
                  ? session
                    ? 'Operator Session & RLS Identity'
                    : 'Authenticate NTPS Session'
                  : 'Local Demo Mode (localStorage)'}
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {isSupabaseConfigured
                  ? 'Row Level Security enforces auth.uid() isolation'
                  : 'Supabase env vars not set · Browser localStorage sandbox only'}
              </p>
            </div>
          </div>
          {canDismiss && (
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-white p-1.5 rounded-md transition-colors"
              aria-label="Close session modal"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="p-6 space-y-5">
          {!isSupabaseConfigured ? (
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-[#05070A] border border-white/[0.08] space-y-2.5">
                <div className="flex items-center gap-2 text-xs font-medium text-[#F5C542]">
                  <Terminal className="w-3.5 h-3.5" />
                  <span>Sandboxed Browser localStorage Ledger</span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  All terminal, wallet, invoice, and ledger operations persist locally in browser{' '}
                  <code className="font-mono text-slate-200">localStorage</code> only—no live
                  Supabase database writes or on-chain TRC-20 transfers are executed. Configure{' '}
                  <code className="font-mono text-slate-200">VITE_SUPABASE_URL</code> and{' '}
                  <code className="font-mono text-slate-200">VITE_SUPABASE_ANON_KEY</code> to
                  activate live <code className="font-mono text-slate-200">supabase.auth</code>{' '}
                  operator login and PostgreSQL RLS enforcement.
                </p>
              </div>

              <div className="p-3.5 rounded-lg bg-[#05070A] border border-white/[0.06] space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-400">Demo Storage Scope</span>
                  <span className="font-mono text-[#F5C542]">window.localStorage (local only)</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-400">Preview Operator</span>
                  <span className="font-mono text-slate-200">{LOCAL_DEMO_EMAIL}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-400">Scoped owner_user_id</span>
                  <span className="font-mono text-slate-300 truncate max-w-[210px]">
                    {LOCAL_DEMO_USER_ID}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="w-full py-2.5 px-4 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] rounded-lg transition-colors"
              >
                Continue in Local Demo Mode
              </button>
            </div>
          ) : session && user ? (
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-[#05070A] border border-white/[0.08] space-y-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-400">Authenticated User</span>
                  <span className="font-mono text-slate-100">{user.email ?? 'Authenticated'}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-400">auth.uid()</span>
                  <span className="font-mono text-[#00E5FF] truncate max-w-[220px]">{user.id}</span>
                </div>
                {sessionExpiry && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-400">Token Expires</span>
                    <span className="font-mono text-slate-300">{sessionExpiry}</span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 pt-1 border-t border-white/[0.06]">
                  <span className="text-slate-400">Active Workspace Mode</span>
                  <span
                    className={`font-mono font-medium ${
                      authMode === 'supabase' ? 'text-[#00E39A]' : 'text-[#F5C542]'
                    }`}
                  >
                    {authMode === 'supabase' ? 'Connected Supabase Session' : 'Local Demo Override'}
                  </span>
                </div>
              </div>

              {errorMessage && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-[#FF4D6A]/10 border border-[#FF4D6A]/30 text-xs text-[#FF4D6A]">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{errorMessage}</span>
                </div>
              )}

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const nextDemo = !demoModeEnabled;
                    onToggleDemoMode(nextDemo);
                    onToast(
                      nextDemo ? 'Switched to Local Demo Mode' : 'Restored Supabase Session Mode',
                      nextDemo
                        ? 'Using sandboxed local ledger state'
                        : `Scoped to ${user.email ?? user.id}`,
                      'info'
                    );
                  }}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-medium text-slate-200 bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.1] rounded-lg transition-colors"
                >
                  <UserCheck className="w-3.5 h-3.5 text-[#00E5FF]" />
                  {demoModeEnabled ? 'Use Connected Supabase Session' : 'Switch to Local Demo Mode'}
                </button>

                <button
                  type="button"
                  disabled={submitting}
                  onClick={handleSignOut}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-medium text-[#FF4D6A] bg-[#FF4D6A]/10 hover:bg-[#FF4D6A]/15 border border-[#FF4D6A]/25 rounded-lg transition-colors disabled:opacity-50"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  {submitting ? 'Signing out...' : 'Sign Out'}
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 p-1 rounded-lg bg-[#05070A] border border-white/[0.08]">
                <button
                  type="button"
                  onClick={() => {
                    setTab('signin');
                    setErrorMessage(null);
                    setInfoMessage(null);
                  }}
                  className={`py-2 text-xs font-medium rounded-md transition-colors ${
                    tab === 'signin'
                      ? 'bg-[#00E5FF]/15 text-[#00E5FF] border border-[#00E5FF]/30'
                      : 'text-slate-400 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTab('signup');
                    setErrorMessage(null);
                    setInfoMessage(null);
                  }}
                  className={`py-2 text-xs font-medium rounded-md transition-colors ${
                    tab === 'signup'
                      ? 'bg-[#00E5FF]/15 text-[#00E5FF] border border-[#00E5FF]/30'
                      : 'text-slate-400 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  Create Account
                </button>
              </div>

              <div className="space-y-3">
                <div>
                  <label
                    htmlFor="ntps-auth-email"
                    className="block text-xs font-medium text-slate-300 mb-1.5"
                  >
                    Operator Email
                  </label>
                  <input
                    id="ntps-auth-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="treasury@institution.com"
                    className="w-full px-3.5 py-2.5 bg-[#05070A] border border-white/[0.1] focus:border-[#00E5FF] focus:outline-none rounded-lg text-xs text-slate-100 placeholder:text-slate-600"
                  />
                </div>

                <div>
                  <label
                    htmlFor="ntps-auth-password"
                    className="block text-xs font-medium text-slate-300 mb-1.5"
                  >
                    Password
                  </label>
                  <input
                    id="ntps-auth-password"
                    type="password"
                    autoComplete={tab === 'signin' ? 'current-password' : 'new-password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 6 characters"
                    className="w-full px-3.5 py-2.5 bg-[#05070A] border border-white/[0.1] focus:border-[#00E5FF] focus:outline-none rounded-lg text-xs text-slate-100 placeholder:text-slate-600"
                  />
                </div>
              </div>

              {errorMessage && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-[#FF4D6A]/10 border border-[#FF4D6A]/30 text-xs text-[#FF4D6A]">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{errorMessage}</span>
                </div>
              )}

              {infoMessage && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-[#00E39A]/10 border border-[#00E39A]/30 text-xs text-[#00E39A]">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{infoMessage}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] rounded-lg transition-colors disabled:opacity-50"
              >
                {tab === 'signin' ? (
                  <>
                    <LogIn className="w-3.5 h-3.5" />
                    {submitting ? 'Authenticating...' : 'Sign In to Terminal'}
                  </>
                ) : (
                  <>
                    <KeyRound className="w-3.5 h-3.5" />
                    {submitting ? 'Provisioning...' : 'Create Operator Account'}
                  </>
                )}
              </button>

              <div className="pt-3 border-t border-white/[0.08]">
                <button
                  type="button"
                  onClick={handleEnableDemo}
                  className="w-full py-2 px-3 text-xs font-medium text-slate-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] rounded-lg transition-colors"
                >
                  Continue in Local Demo Mode
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
