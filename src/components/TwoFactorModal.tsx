import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Lock,
  QrCode,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useTwoFactorRuntime } from '../context/TwoFactorContext';
import {
  clearDemoTwoFactorGuard,
  createTotpEnrollmentMaterial,
  enrollUserTotp,
  fetchTotpStatus,
  generateRandomDemoOtp,
  readDemoTwoFactorGuard,
  recordDemoTwoFactorFailure,
  TOTP_MAX_ATTEMPTS,
  verifyUserTotp,
  type TotpEnrollmentMaterial,
} from '../lib/totp';

interface TwoFactorModalProps {
  open: boolean;
  title: string;
  subtitle: string;
  summaryRows: {
    label: string;
    value: string;
    mono?: boolean;
    highlight?: 'cyan' | 'gold' | 'emerald';
  }[];
  confirmLabel: string;
  isSubmitting?: boolean;
  onClose: () => void;
  onConfirm: (code: string) => Promise<void> | void;
}

type LivePhase = 'loading' | 'enroll' | 'verify' | 'error';

function formatCountdown(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function TwoFactorModal({
  open,
  title,
  subtitle,
  summaryRows,
  confirmLabel,
  isSubmitting = false,
  onClose,
  onConfirm,
}: TwoFactorModalProps) {
  const { authMode, userEmail, onRecordSimulatedAudit } = useTwoFactorRuntime();
  const isLiveMode = authMode === 'supabase';

  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  // Live Supabase TOTP state
  const [livePhase, setLivePhase] = useState<LivePhase>('loading');
  const [enrollmentMaterial, setEnrollmentMaterial] = useState<TotpEnrollmentMaterial | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  // Shared lockout / attempts state
  const [lockedRemainingSeconds, setLockedRemainingSeconds] = useState(0);
  const [remainingAttempts, setRemainingAttempts] = useState<number>(TOTP_MAX_ATTEMPTS);

  // Local Demo simulated challenge state (random per modal session, never hardcoded)
  const [demoChallenge, setDemoChallenge] = useState<string>('');

  const initializeModalState = async () => {
    setCode('');
    setError(null);
    setCopiedSecret(false);
    setIsVerifying(false);

    if (!isLiveMode) {
      const guard = readDemoTwoFactorGuard();
      setLockedRemainingSeconds(guard.lockedRemainingSeconds);
      setRemainingAttempts(Math.max(0, TOTP_MAX_ATTEMPTS - guard.failedAttempts));
      setDemoChallenge(generateRandomDemoOtp());
      setEnrollmentMaterial(null);
      return;
    }

    setLivePhase('loading');
    setEnrollmentMaterial(null);
    try {
      const status = await fetchTotpStatus();
      setLockedRemainingSeconds(status.lockedRemainingSeconds);
      setRemainingAttempts(Math.max(0, TOTP_MAX_ATTEMPTS - status.failedAttempts));
      if (!status.enrolled) {
        const material = await createTotpEnrollmentMaterial(userEmail);
        setEnrollmentMaterial(material);
        setLivePhase('enroll');
      } else {
        setLivePhase('verify');
      }
    } catch (err) {
      setLivePhase('error');
      setError(
        err instanceof Error
          ? err.message
          : 'Unable to initialize 2FA status from Supabase.'
      );
    }
  };

  useEffect(() => {
    if (!open) {
      setEnrollmentMaterial(null);
      setCode('');
      setError(null);
      return;
    }
    void initializeModalState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isLiveMode, userEmail]);

  // Live countdown ticker when locked out
  useEffect(() => {
    if (!open || lockedRemainingSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setLockedRemainingSeconds((prev) => {
        if (prev <= 1) {
          if (!isLiveMode) {
            const guard = readDemoTwoFactorGuard();
            setRemainingAttempts(Math.max(0, TOTP_MAX_ATTEMPTS - guard.failedAttempts));
          } else {
            setRemainingAttempts(TOTP_MAX_ATTEMPTS);
          }
          setError(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [open, lockedRemainingSeconds, isLiveMode]);

  if (!open) return null;

  const isLocked = lockedRemainingSeconds > 0;
  const busy = isSubmitting || isVerifying;

  const handleCopySecret = async () => {
    if (!enrollmentMaterial) return;
    try {
      await navigator.clipboard.writeText(enrollmentMaterial.secret);
      setCopiedSecret(true);
      window.setTimeout(() => setCopiedSecret(false), 2000);
    } catch {
      setError('Clipboard access denied. Copy the Base32 key manually.');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || isLocked) return;

    const clean = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(clean)) {
      setError('Enter a valid 6-digit authenticator code.');
      return;
    }

    setError(null);
    setIsVerifying(true);

    try {
      if (!isLiveMode) {
        const guard = readDemoTwoFactorGuard();
        if (guard.lockedRemainingSeconds > 0) {
          setLockedRemainingSeconds(guard.lockedRemainingSeconds);
          setError(
            `Simulated 2FA is locked for ${formatCountdown(guard.lockedRemainingSeconds)} after ${TOTP_MAX_ATTEMPTS} failed attempts.`
          );
          await onRecordSimulatedAudit?.({
            eventType: 'TOTP_SIMULATED_LOCKED_ATTEMPT',
            actor: userEmail,
            details: `Blocked simulated 2FA attempt for "${title}" during active 15-minute lockout.`,
            severity: 'warn',
          });
          return;
        }

        if (clean !== demoChallenge) {
          const failure = recordDemoTwoFactorFailure();
          setRemainingAttempts(failure.remainingAttempts);
          setLockedRemainingSeconds(failure.lockedRemainingSeconds);
          setCode('');
          const lockedNow = failure.lockedRemainingSeconds > 0;
          setError(
            lockedNow
              ? `Too many failed 2FA attempts. Locked for 15 minutes (${formatCountdown(failure.lockedRemainingSeconds)}).`
              : `Invalid session challenge code. ${failure.remainingAttempts} attempt${failure.remainingAttempts === 1 ? '' : 's'} remaining before 15-minute lockout.`
          );
          await onRecordSimulatedAudit?.({
            eventType: lockedNow ? 'TOTP_SIMULATED_LOCKOUT' : 'TOTP_SIMULATED_FAILED',
            actor: userEmail,
            details: lockedNow
              ? `Simulated 2FA locked for 15 minutes after ${TOTP_MAX_ATTEMPTS} invalid codes on "${title}".`
              : `Simulated 2FA mismatch on "${title}". ${failure.remainingAttempts} attempts remaining.`,
            severity: lockedNow ? 'critical' : 'warn',
          });
          return;
        }

        clearDemoTwoFactorGuard();
        await onRecordSimulatedAudit?.({
          eventType: 'TOTP_SIMULATED_VERIFIED',
          actor: userEmail,
          details: `Simulated Local Demo 2FA challenge verified for "${title}".`,
          severity: 'info',
        });
        await onConfirm(clean);
        return;
      }

      // Live Supabase Mode
      if (livePhase === 'enroll') {
        if (!enrollmentMaterial) {
          setError('Enrollment secret missing. Reload the authenticator setup.');
          return;
        }
        await enrollUserTotp(enrollmentMaterial.secret, clean);
        // Immediately drop raw secret from client memory once encrypted on-server
        setEnrollmentMaterial(null);
        await onConfirm(clean);
        return;
      }

      const result = await verifyUserTotp(clean, title);
      if (!result.ok) {
        setRemainingAttempts(result.remainingAttempts);
        setLockedRemainingSeconds(result.lockedRemainingSeconds);
        setCode('');
        setError(result.message);
        return;
      }

      await onConfirm(clean);
    } catch (err) {
      setError(err instanceof Error ? err.message : '2FA verification failed.');
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ntps-2fa-title"
        className="w-full max-w-md bg-[#0B0F16] border border-white/[0.1] rounded-xl shadow-2xl overflow-hidden my-auto"
      >
        <div className="flex items-start justify-between px-6 py-5 border-b border-white/[0.08]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#00E5FF]/10 border border-[#00E5FF]/25 flex items-center justify-center shrink-0">
              {isLiveMode && livePhase === 'enroll' ? (
                <QrCode className="w-4 h-4 text-[#00E5FF]" />
              ) : (
                <ShieldCheck className="w-4 h-4 text-[#00E5FF]" />
              )}
            </div>
            <div>
              <h3 id="ntps-2fa-title" className="text-base font-semibold text-slate-100">
                {isLiveMode && livePhase === 'enroll'
                  ? 'Enroll Authenticator App (2FA)'
                  : title}
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {isLiveMode && livePhase === 'enroll'
                  ? 'Scan QR code once, then enter the 6-digit TOTP code to activate & authorize'
                  : subtitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-slate-400 hover:text-slate-100 p-1 rounded-md transition-colors"
            aria-label="Close confirmation dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Summary Rows */}
          <div className="bg-[#05070A] border border-white/[0.07] rounded-lg divide-y divide-white/[0.06]">
            {summaryRows.map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between px-4 py-2.5 text-xs gap-4"
              >
                <span className="text-slate-400 shrink-0">{row.label}</span>
                <span
                  className={`text-right truncate ${
                    row.mono ? 'font-mono tabular-nums' : 'font-medium'
                  } ${
                    row.highlight === 'cyan'
                      ? 'text-[#00E5FF]'
                      : row.highlight === 'gold'
                        ? 'text-[#F5C542]'
                        : row.highlight === 'emerald'
                          ? 'text-emerald-400'
                          : 'text-slate-100'
                  }`}
                >
                  {row.value}
                </span>
              </div>
            ))}
          </div>

          {/* Mode-specific 2FA body */}
          {!isLiveMode ? (
            <div className="rounded-lg border border-[#F5C542]/35 bg-[#F5C542]/10 p-3.5 space-y-2.5">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-[#F5C542] shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-[#F5C542]">
                    Simulated 2FA — Local Demo Mode
                  </p>
                  <p className="text-[11px] leading-relaxed text-slate-300">
                    Live server-side TOTP is disabled in Local Demo Mode. Type the one-time
                    session code below manually to test verification and audit logging.
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-between bg-[#05070A] border border-white/[0.08] rounded-md px-3 py-2">
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 block">
                    Session Challenge Code
                  </span>
                  <span className="font-mono text-base font-semibold tracking-[0.35em] text-[#F5C542] tabular-nums">
                    {demoChallenge}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setDemoChallenge(generateRandomDemoOtp());
                    setCode('');
                    setError(null);
                  }}
                  disabled={busy || isLocked}
                  className="inline-flex items-center gap-1.5 text-[11px] text-slate-300 hover:text-[#00E5FF] disabled:opacity-40 transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                  New Code
                </button>
              </div>
            </div>
          ) : livePhase === 'loading' ? (
            <div className="py-8 flex flex-col items-center justify-center gap-2 text-xs text-slate-400">
              <RefreshCw className="w-5 h-5 text-[#00E5FF] animate-spin" />
              <span>Checking server-side authenticator status...</span>
            </div>
          ) : livePhase === 'error' ? (
            <div className="rounded-lg border border-[#FF4D6A]/35 bg-[#FF4D6A]/10 p-4 space-y-3">
              <p className="text-xs text-[#FF4D6A]">{error}</p>
              <button
                type="button"
                onClick={() => void initializeModalState()}
                className="px-3 py-1.5 text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] text-slate-200 rounded-md transition-colors"
              >
                Retry Status Check
              </button>
            </div>
          ) : livePhase === 'enroll' && enrollmentMaterial ? (
            <div className="rounded-lg border border-[#00E5FF]/25 bg-[#05070A] p-4 space-y-3">
              <div className="flex flex-col sm:flex-row items-center gap-4">
                <div className="bg-white p-2 rounded-lg shrink-0">
                  <img
                    src={enrollmentMaterial.qrDataUrl}
                    alt="Scan TOTP enrollment QR code"
                    className="w-32 h-32 block"
                  />
                </div>
                <div className="space-y-2 text-xs text-slate-300 min-w-0 flex-1">
                  <p className="font-medium text-slate-100">
                    Scan with Google Authenticator, Authy, or 1Password
                  </p>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Once confirmed below, your secret is AES-256 encrypted on-server and never
                    readable from the browser again.
                  </p>
                  <div className="pt-1">
                    <span className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">
                      Manual Setup Key (Base32)
                    </span>
                    <div className="flex items-center gap-1.5 bg-[#0B0F16] border border-white/[0.08] rounded px-2.5 py-1.5">
                      <code className="text-[11px] font-mono text-[#00E5FF] truncate flex-1">
                        {enrollmentMaterial.secret}
                      </code>
                      <button
                        type="button"
                        onClick={handleCopySecret}
                        className="text-slate-400 hover:text-white shrink-0"
                        aria-label="Copy Base32 setup key"
                      >
                        {copiedSecret ? (
                          <Check className="w-3.5 h-3.5 text-[#00E39A]" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* Active Lockout Banner */}
          {isLocked && (
            <div className="rounded-lg border border-[#FF4D6A]/40 bg-[#FF4D6A]/10 px-4 py-3 flex items-start gap-2.5">
              <ShieldAlert className="w-4 h-4 text-[#FF4D6A] shrink-0 mt-0.5" />
              <div className="text-xs space-y-0.5">
                <p className="font-semibold text-[#FF4D6A]">
                  2FA Locked ({formatCountdown(lockedRemainingSeconds)})
                </p>
                <p className="text-slate-300 text-[11px]">
                  Exceeded {TOTP_MAX_ATTEMPTS} failed verification attempts. Retry once the
                  15-minute cooldown expires.
                </p>
              </div>
            </div>
          )}

          {/* 6-Digit Code Input */}
          {(!isLiveMode || livePhase === 'enroll' || livePhase === 'verify') && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="ntps-totp-input"
                  className="text-xs font-medium text-slate-300 flex items-center gap-1.5"
                >
                  <Lock className="w-3.5 h-3.5 text-slate-400" />
                  {isLiveMode && livePhase === 'enroll'
                    ? 'Confirm First 6-Digit Code'
                    : 'Authenticator 6-Digit Code'}
                </label>
                {!isLocked && remainingAttempts < TOTP_MAX_ATTEMPTS && (
                  <span className="text-[11px] font-mono text-[#F5C542]">
                    {remainingAttempts}/{TOTP_MAX_ATTEMPTS} attempts left
                  </span>
                )}
              </div>

              <input
                id="ntps-totp-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                disabled={busy || isLocked}
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                  if (error) setError(null);
                }}
                placeholder="000000"
                className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] disabled:opacity-45 rounded-lg px-4 py-3 text-center font-mono text-xl tracking-[0.45em] text-slate-100 placeholder:text-slate-600 focus:outline-none transition-colors"
              />
              {error && !isLocked && <p className="text-xs text-[#FF4D6A]">{error}</p>}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-4 py-2.5 text-xs font-medium text-slate-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={
                busy ||
                isLocked ||
                code.length !== 6 ||
                (isLiveMode && livePhase !== 'enroll' && livePhase !== 'verify')
              }
              className="px-5 py-2.5 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] disabled:opacity-45 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              {busy
                ? 'Verifying...'
                : isLiveMode && livePhase === 'enroll'
                  ? 'Activate & Confirm'
                  : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
