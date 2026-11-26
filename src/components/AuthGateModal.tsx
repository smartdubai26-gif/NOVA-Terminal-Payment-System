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
import { useLocale } from '../context/LocaleContext';

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
  const { tr } = useLocale();

  if (!open) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setInfoMessage(null);

    if (!email.trim() || !password) {
      setErrorMessage(tr('Enter both email address and password.', 'أدخل البريد الإلكتروني وكلمة المرور.'));
      return;
    }

    if (password.length < 6) {
      setErrorMessage(tr('Password must be at least 6 characters.', 'يجب أن تتكون كلمة المرور من 6 أحرف على الأقل.'));
      return;
    }

    setSubmitting(true);
    try {
      if (tab === 'signin') {
        const res = await onSignIn(email, password);
        if (res.error) {
          setErrorMessage(res.error);
        } else {
          onToast(tr('Supabase session active', 'جلسة Supabase نشطة'), email.trim(), 'success');
          onClose();
        }
      } else {
        const res = await onSignUp(email, password);
        if (res.error) {
          setErrorMessage(res.error);
        } else if (res.requiresEmailConfirmation) {
          setInfoMessage(
            tr(
              'Account created. Check your inbox to confirm your email address before signing in.',
              'تم إنشاء الحساب. تحقق من بريدك الإلكتروني لتأكيد عنوانك قبل تسجيل الدخول.'
            )
          );
          onToast(tr('Confirmation email sent', 'تم إرسال بريد التأكيد'), email.trim(), 'info');
        } else {
          onToast(tr('Operator account provisioned', 'تم إنشاء حساب المشغل'), email.trim(), 'success');
          onClose();
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleEnableDemo = () => {
    onToggleDemoMode(true);
    onToast(
      tr('Local Demo Mode enabled', 'تم تفعيل وضع العرض المحلي'),
      tr('Operating with sandboxed double-entry ledger', 'التشغيل بدفتر القيد المزدوج التجريبي'),
      'info'
    );
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
        onToast(
          tr('Signed out of Supabase', 'تم تسجيل الخروج من Supabase'),
          tr('Session terminated cleanly', 'تم إنهاء الجلسة بنجاح'),
          'info'
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const sessionExpiry = session?.expires_at
    ? new Date(session.expires_at * 1000).toLocaleString()
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#0F172A]/65 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ntps-auth-title"
        className="w-full max-w-md bg-white border border-[#E2E8F0] rounded-xl shadow-2xl overflow-hidden"
      >
        {/* Cobalt Blue Institutional Hero Header */}
        <div className="cobalt-hero-surface flex items-center justify-between px-6 py-5 text-white border-b border-[#24489B]">
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-lg bg-[#D6FF3D] flex items-center justify-center shrink-0 shadow-sm">
              {authMode === 'supabase' ? (
                <ShieldCheck className="w-4 h-4 text-[#0F172A]" />
              ) : (
                <Lock className="w-4 h-4 text-[#0F172A]" />
              )}
            </span>
            <div>
              <h3 id="ntps-auth-title" className="text-sm font-semibold text-white">
                {isSupabaseConfigured
                  ? session
                    ? tr('Operator Session & RLS Identity', 'جلسة المشغل وهوية RLS')
                    : tr('Authenticate NTPS Session', 'مصادقة جلسة NTPS')
                  : tr('Local Demo Mode (localStorage)', 'وضع العرض المحلي (localStorage)')}
              </h3>
              <p className="text-xs text-blue-100/85 mt-0.5">
                {isSupabaseConfigured
                  ? tr('Row Level Security enforces auth.uid() isolation', 'عزل البيانات على مستوى الصفوف عبر auth.uid()')
                  : tr('Supabase env vars not set · Browser localStorage sandbox only', 'بيئة عرض محلية بالمتصفح فقط')}
              </p>
            </div>
          </div>
          {canDismiss && (
            <button
              type="button"
              onClick={onClose}
              className="text-blue-100 hover:text-white p-1.5 rounded-md transition-colors"
              aria-label={tr('Close session modal', 'إغلاق نافذة الجلسة')}
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Snow White Form Body */}
        <div className="p-6 space-y-5 bg-white">
          {!isSupabaseConfigured ? (
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-[#F4F7FA] border border-[#E2E8F0] space-y-2.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#1E40AF]">
                  <Terminal className="w-3.5 h-3.5" />
                  <span>{tr('Sandboxed Browser localStorage Ledger', 'دفتر محلي معزول في المتصفح')}</span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  All terminal, wallet, invoice, and ledger operations persist locally in browser{' '}
                  <code className="font-mono text-[#0F172A] bg-white px-1 py-0.5 rounded border border-[#E2E8F0]">
                    localStorage
                  </code>{' '}
                  only—no live Supabase database writes or on-chain TRC-20 transfers are executed. Configure{' '}
                  <code className="font-mono text-[#0F172A] bg-white px-1 py-0.5 rounded border border-[#E2E8F0]">
                    VITE_SUPABASE_URL
                  </code>{' '}
                  and{' '}
                  <code className="font-mono text-[#0F172A] bg-white px-1 py-0.5 rounded border border-[#E2E8F0]">
                    VITE_SUPABASE_ANON_KEY
                  </code>{' '}
                  to activate live{' '}
                  <code className="font-mono text-[#0F172A] bg-white px-1 py-0.5 rounded border border-[#E2E8F0]">
                    supabase.auth
                  </code>{' '}
                  operator login and PostgreSQL RLS enforcement.
                </p>
              </div>

              <div className="p-3.5 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">{tr('Demo Storage Scope', 'نطاق التخزين')}</span>
                  <span className="font-mono text-[#1E40AF] font-medium">window.localStorage</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">{tr('Preview Operator', 'حساب المعاينة')}</span>
                  <span className="font-mono text-[#0F172A]">{LOCAL_DEMO_EMAIL}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">{tr('Scoped owner_user_id', 'معرف المالك')}</span>
                  <span className="font-mono tabular-nums text-slate-700 truncate max-w-[210px]">
                    {LOCAL_DEMO_USER_ID}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="w-full py-2.5 px-4 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors shadow-xs"
              >
                {tr('Continue in Local Demo Mode', 'المتابعة في وضع العرض المحلي')}
              </button>
            </div>
          ) : session && user ? (
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] space-y-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">{tr('Authenticated User', 'المستخدم المصادق')}</span>
                  <span className="font-mono text-[#0F172A] font-medium">{user.email ?? 'Authenticated'}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">auth.uid()</span>
                  <span className="font-mono tabular-nums text-[#1E40AF] truncate max-w-[220px]">{user.id}</span>
                </div>
                {sessionExpiry && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">{tr('Token Expires', 'انتهاء الجلسة')}</span>
                    <span className="font-mono tabular-nums text-slate-700">{sessionExpiry}</span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 pt-2 border-t border-[#E2E8F0]">
                  <span className="text-slate-500">{tr('Active Workspace Mode', 'وضع مساحة العمل')}</span>
                  <span
                    className={`font-mono font-semibold ${
                      authMode === 'supabase' ? 'text-emerald-700' : 'text-amber-700'
                    }`}
                  >
                    {authMode === 'supabase'
                      ? tr('Connected Supabase Session', 'جلسة Supabase متصلة')
                      : tr('Local Demo Override', 'تجاوز العرض المحلي')}
                  </span>
                </div>
              </div>

              {errorMessage && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
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
                      nextDemo
                        ? tr('Switched to Local Demo Mode', 'تم التبديل لوضع العرض المحلي')
                        : tr('Restored Supabase Session Mode', 'تمت استعادة جلسة Supabase'),
                      nextDemo
                        ? tr('Using sandboxed local ledger state', 'استخدام حالة الدفتر المحلي')
                        : `Scoped to ${user.email ?? user.id}`,
                      'info'
                    );
                  }}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-medium text-[#0F172A] bg-[#F4F7FA] hover:bg-slate-200/70 border border-[#E2E8F0] rounded-lg transition-colors"
                >
                  <UserCheck className="w-3.5 h-3.5 text-[#1E40AF]" />
                  {demoModeEnabled
                    ? tr('Use Connected Supabase Session', 'استخدام جلسة Supabase المتصلة')
                    : tr('Switch to Local Demo Mode', 'التبديل لوضع العرض المحلي')}
                </button>

                <button
                  type="button"
                  disabled={submitting}
                  onClick={handleSignOut}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-colors disabled:opacity-50"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  {submitting ? tr('Signing out...', 'جاري الخروج...') : tr('Sign Out', 'تسجيل الخروج')}
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 p-1 rounded-lg bg-[#F4F7FA] border border-[#E2E8F0]">
                <button
                  type="button"
                  onClick={() => {
                    setTab('signin');
                    setErrorMessage(null);
                    setInfoMessage(null);
                  }}
                  className={`py-2 text-xs font-semibold rounded-md transition-colors ${
                    tab === 'signin'
                      ? 'bg-[#1E40AF] text-white shadow-xs'
                      : 'text-slate-600 hover:text-[#0F172A]'
                  }`}
                >
                  {tr('Sign In', 'تسجيل الدخول')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTab('signup');
                    setErrorMessage(null);
                    setInfoMessage(null);
                  }}
                  className={`py-2 text-xs font-semibold rounded-md transition-colors ${
                    tab === 'signup'
                      ? 'bg-[#1E40AF] text-white shadow-xs'
                      : 'text-slate-600 hover:text-[#0F172A]'
                  }`}
                >
                  {tr('Create Account', 'إنشاء حساب')}
                </button>
              </div>

              <div className="space-y-3">
                <div>
                  <label
                    htmlFor="ntps-auth-email"
                    className="block text-xs font-semibold text-[#0F172A] mb-1.5"
                  >
                    {tr('Operator Email', 'البريد الإلكتروني للمشغل')}
                  </label>
                  <input
                    id="ntps-auth-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="treasury@institution.com"
                    className="w-full px-3.5 py-2.5 bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white focus:outline-none rounded-lg text-xs text-[#0F172A] placeholder:text-slate-400"
                  />
                </div>

                <div>
                  <label
                    htmlFor="ntps-auth-password"
                    className="block text-xs font-semibold text-[#0F172A] mb-1.5"
                  >
                    {tr('Password', 'كلمة المرور')}
                  </label>
                  <input
                    id="ntps-auth-password"
                    type="password"
                    autoComplete={tab === 'signin' ? 'current-password' : 'new-password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={tr('Minimum 6 characters', '6 أحرف على الأقل')}
                    className="w-full px-3.5 py-2.5 bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white focus:outline-none rounded-lg text-xs text-[#0F172A] placeholder:text-slate-400"
                  />
                </div>
              </div>

              {errorMessage && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{errorMessage}</span>
                </div>
              )}

              {infoMessage && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-700">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{infoMessage}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors disabled:opacity-50 shadow-xs"
              >
                {tab === 'signin' ? (
                  <>
                    <LogIn className="w-3.5 h-3.5" />
                    {submitting
                      ? tr('Authenticating...', 'جاري التحقق...')
                      : tr('Sign In to Terminal', 'تسجيل الدخول للمحطة')}
                  </>
                ) : (
                  <>
                    <KeyRound className="w-3.5 h-3.5" />
                    {submitting
                      ? tr('Provisioning...', 'جاري الإنشاء...')
                      : tr('Create Operator Account', 'إنشاء حساب مشغل')}
                  </>
                )}
              </button>

              <div className="pt-3 border-t border-[#E2E8F0]">
                <button
                  type="button"
                  onClick={handleEnableDemo}
                  className="w-full py-2 px-3 text-xs font-medium text-slate-600 hover:text-[#0F172A] bg-[#F4F7FA] hover:bg-slate-200/70 border border-[#E2E8F0] rounded-lg transition-colors"
                >
                  {tr('Continue in Local Demo Mode', 'المتابعة في وضع العرض المحلي')}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
