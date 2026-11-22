import { useState, useEffect, useMemo } from 'react';
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Clock,
  FileCheck2,
  FileText,
  ShieldAlert,
  ShieldCheck,
  Upload,
  User,
  UserCheck,
  ChevronRight,
  ChevronLeft,
} from 'lucide-react';
import type {
  ActiveView,
  KycAccountType,
  KycIdType,
  KycStatus,
  KycSubmissionInput,
  KycSubmissionRecord,
} from '../types/ntps';
import {
  uploadKycDocument,
  validateKycDocumentFile,
  type KycDocumentSlot,
  type LedgerRuntimeMode,
} from '../lib/ledgerEngine';
import { formatTimestamp } from '../lib/format';

interface KycVerificationViewProps {
  submission: KycSubmissionRecord | null;
  userId?: string;
  authMode: LedgerRuntimeMode;
  onSubmitKyc: (input: KycSubmissionInput) => Promise<void>;
  onNavigate?: (view: ActiveView) => void;
  onToast: (title: string, description?: string, variant?: 'success' | 'error' | 'info') => void;
}

const STEPS = [
  { id: 1, title: 'Entity & Profile' },
  { id: 2, title: 'ID & Contact' },
  { id: 3, title: 'Document Vault' },
  { id: 4, title: 'Review & Submit' },
] as const;

const SLOT_META: {
  slot: KycDocumentSlot;
  title: string;
  hint: string;
  requiredForPassport: boolean;
}[] = [
  {
    slot: 'id_front',
    title: 'Government ID / Incorporation Front',
    hint: 'Clear color scan or photo of passport bio page, front of national ID, or certificate of incorporation.',
    requiredForPassport: true,
  },
  {
    slot: 'id_back',
    title: 'Government ID Back / Registry Addendum',
    hint: 'Back side of national ID or secondary commercial registry page (optional for passport).',
    requiredForPassport: false,
  },
  {
    slot: 'selfie',
    title: 'Authorized Signatory Liveness Selfie',
    hint: 'Unedited portrait photo of the applicant or authorized corporate signatory holding their ID.',
    requiredForPassport: true,
  },
  {
    slot: 'proof_of_address',
    title: 'Proof of Address / Registered Office',
    hint: 'Recent utility bill, bank statement, or official registry extract issued within 90 days.',
    requiredForPassport: true,
  },
];

function maskIdentifier(val: string): string {
  const clean = val.trim();
  if (clean.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(8, clean.length - 4))}${clean.slice(-4)}`;
}

export function KycVerificationView({
  submission,
  userId,
  authMode,
  onSubmitKyc,
  onNavigate,
  onToast,
}: KycVerificationViewProps) {
  const kycStatus: KycStatus = submission?.status ?? 'unverified';
  const [isResubmitting, setIsResubmitting] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Form state
  const [accountType, setAccountType] = useState<KycAccountType>(
    submission?.account_type ?? 'individual'
  );
  const [fullLegalName, setFullLegalName] = useState(submission?.full_legal_name ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(submission?.date_of_birth ?? '');
  const [nationality, setNationality] = useState(submission?.nationality ?? '');
  const [countryOfResidence, setCountryOfResidence] = useState(
    submission?.country_of_residence ?? ''
  );
  const [idType, setIdType] = useState<KycIdType>(submission?.id_type ?? 'passport');
  const [idNumber, setIdNumber] = useState(submission?.id_number ?? '');
  const [taxOrRegNumber, setTaxOrRegNumber] = useState(submission?.tax_or_reg_number ?? '');
  const [phoneNumber, setPhoneNumber] = useState(submission?.phone_number ?? '');
  const [addressLine, setAddressLine] = useState(submission?.address_line ?? '');

  // Uploaded Storage Paths + local filenames
  const [docPaths, setDocPaths] = useState<Partial<Record<KycDocumentSlot, string>>>({
    id_front: submission?.id_front_path || undefined,
    id_back: submission?.id_back_path || undefined,
    selfie: submission?.selfie_path || undefined,
    proof_of_address: submission?.proof_of_address_path || undefined,
  });
  const [docNames, setDocNames] = useState<Partial<Record<KycDocumentSlot, string>>>({});
  const [uploadingSlot, setUploadingSlot] = useState<KycDocumentSlot | null>(null);

  useEffect(() => {
    if (!submission) {
      setIsResubmitting(false);
      return;
    }
    setAccountType(submission.account_type);
    setFullLegalName(submission.full_legal_name);
    setDateOfBirth(submission.date_of_birth);
    setNationality(submission.nationality);
    setCountryOfResidence(submission.country_of_residence);
    setIdType(submission.id_type);
    setIdNumber(submission.id_number);
    setTaxOrRegNumber(submission.tax_or_reg_number ?? '');
    setPhoneNumber(submission.phone_number);
    setAddressLine(submission.address_line);
    setDocPaths({
      id_front: submission.id_front_path || undefined,
      id_back: submission.id_back_path || undefined,
      selfie: submission.selfie_path || undefined,
      proof_of_address: submission.proof_of_address_path || undefined,
    });
    if (submission.status !== 'rejected') {
      setIsResubmitting(false);
    }
  }, [submission]);

  const showWizard = kycStatus === 'unverified' || (kycStatus === 'rejected' && isResubmitting);

  const idBackRequired = idType !== 'passport';

  const completedDocsCount = useMemo(() => {
    let count = 0;
    if (docPaths.id_front) count += 1;
    if (docPaths.id_back) count += 1;
    if (docPaths.selfie) count += 1;
    if (docPaths.proof_of_address) count += 1;
    return count;
  }, [docPaths]);

  const handleFileSelect = async (slot: KycDocumentSlot, file: File | null) => {
    if (!file) return;
    setFormError(null);
    try {
      validateKycDocumentFile(file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid file selected.';
      setFormError(msg);
      onToast('Document rejected', msg, 'error');
      return;
    }

    setUploadingSlot(slot);
    try {
      const uploadedPath = await uploadKycDocument({
        file,
        slot,
        userId: userId ?? 'local-demo-operator',
        authMode,
      });
      setDocPaths((prev) => ({ ...prev, [slot]: uploadedPath }));
      setDocNames((prev) => ({ ...prev, [slot]: file.name }));
      onToast('Document uploaded', `${file.name} stored in private KYC vault.`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to upload document.';
      setFormError(msg);
      onToast('Upload failed', msg, 'error');
    } finally {
      setUploadingSlot(null);
    }
  };

  const validateStep = (currentStep: 1 | 2 | 3): string | null => {
    if (currentStep === 1) {
      if (fullLegalName.trim().length < 2) {
        return accountType === 'corporate'
          ? 'Registered legal entity name is required.'
          : 'Full legal name is required.';
      }
      if (!dateOfBirth.trim()) {
        return accountType === 'corporate'
          ? 'Date of incorporation is required.'
          : 'Date of birth is required.';
      }
      if (!nationality.trim() || !countryOfResidence.trim()) {
        return 'Nationality / jurisdiction and country of residence are required.';
      }
      return null;
    }

    if (currentStep === 2) {
      if (idNumber.trim().length < 3) {
        return 'Enter a valid document or commercial registration number.';
      }
      if (accountType === 'corporate' && !taxOrRegNumber.trim()) {
        return 'Tax or commercial registration number is required for Corporate KYB.';
      }
      if (phoneNumber.trim().length < 5) {
        return 'Enter a valid phone number with country code.';
      }
      if (addressLine.trim().length < 5) {
        return 'Enter a complete residential or registered business address.';
      }
      return null;
    }

    if (currentStep === 3) {
      if (!docPaths.id_front) return 'Upload ID Front / Incorporation document.';
      if (idBackRequired && !docPaths.id_back) {
        return 'Upload ID Back / Commercial Registry addendum.';
      }
      if (!docPaths.selfie) return 'Upload Authorized Signatory Liveness Selfie.';
      if (!docPaths.proof_of_address) return 'Upload Proof of Address document.';
      return null;
    }

    return null;
  };

  const handleNextStep = () => {
    setFormError(null);
    if (step < 4) {
      const err = validateStep(step as 1 | 2 | 3);
      if (err) {
        setFormError(err);
        onToast('Step incomplete', err, 'error');
        return;
      }
      setStep((prev) => (prev + 1) as 1 | 2 | 3 | 4);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    for (const s of [1, 2, 3] as const) {
      const err = validateStep(s);
      if (err) {
        setFormError(err);
        setStep(s);
        onToast('Verification incomplete', err, 'error');
        return;
      }
    }

    setIsSubmitting(true);
    try {
      await onSubmitKyc({
        account_type: accountType,
        full_legal_name: fullLegalName.trim(),
        date_of_birth: dateOfBirth.trim(),
        nationality: nationality.trim(),
        country_of_residence: countryOfResidence.trim(),
        id_type: idType,
        id_number: idNumber.trim(),
        tax_or_reg_number: taxOrRegNumber.trim() || undefined,
        phone_number: phoneNumber.trim(),
        address_line: addressLine.trim(),
        id_front_path: docPaths.id_front ?? '',
        id_back_path: docPaths.id_back,
        selfie_path: docPaths.selfie ?? '',
        proof_of_address_path: docPaths.proof_of_address ?? '',
      });
      setIsResubmitting(false);
      setStep(1);
      onToast(
        'KYC / KYB Submitted',
        'Your verification dossier is now queued for compliance review.',
        'success'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to submit KYC package.';
      setFormError(msg);
      onToast('Submission failed', msg, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Status Banner */}
      <section
        className={`rounded-xl border p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4 ${
          kycStatus === 'approved'
            ? 'bg-emerald-500/10 border-emerald-500/30'
            : kycStatus === 'pending_review'
              ? 'bg-[#00E5FF]/10 border-[#00E5FF]/30'
              : kycStatus === 'rejected'
                ? 'bg-red-500/10 border-red-500/30'
                : 'bg-amber-500/10 border-amber-500/30'
        }`}
      >
        <div className="flex items-start gap-3.5 max-w-2xl">
          <div className="mt-0.5 shrink-0">
            {kycStatus === 'approved' ? (
              <ShieldCheck className="w-6 h-6 text-emerald-400" />
            ) : kycStatus === 'pending_review' ? (
              <Clock className="w-6 h-6 text-[#00E5FF]" />
            ) : kycStatus === 'rejected' ? (
              <ShieldAlert className="w-6 h-6 text-red-400" />
            ) : (
              <AlertCircle className="w-6 h-6 text-[#F5C542]" />
            )}
          </div>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-base font-semibold text-slate-100">
                {kycStatus === 'approved'
                  ? 'KYC / KYB Verified'
                  : kycStatus === 'pending_review'
                    ? 'Pending Compliance Review'
                    : kycStatus === 'rejected'
                      ? 'Verification Rejected'
                      : 'Identity Verification Required (Unverified)'}
              </h2>
              <span
                className={`font-mono text-[11px] uppercase tracking-wider font-semibold ${
                  kycStatus === 'approved'
                    ? 'text-emerald-400'
                    : kycStatus === 'pending_review'
                      ? 'text-[#00E5FF]'
                      : kycStatus === 'rejected'
                        ? 'text-red-400'
                        : 'text-[#F5C542]'
                }`}
              >
                {kycStatus.replace('_', ' ')}
              </span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              {kycStatus === 'approved'
                ? 'Your institutional profile passed compliance screening. Master & Sub-Terminal provisioning and custody withdrawals are unlocked.'
                : kycStatus === 'pending_review'
                  ? 'Your identity package and encrypted documents are under active compliance review. Terminal provisioning and external withdrawals unlock upon approval.'
                  : kycStatus === 'rejected'
                    ? submission?.rejection_reason ||
                      'Your submission was rejected by compliance. Review the note below and resubmit corrected documents.'
                    : 'Complete Individual KYC or Corporate KYB onboarding to activate live treasury provisioning, Sub-Terminal creation, and external custody withdrawals.'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {kycStatus === 'rejected' && !isResubmitting && (
            <button
              type="button"
              onClick={() => {
                setIsResubmitting(true);
                setStep(1);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] rounded-lg transition-colors whitespace-nowrap"
            >
              Edit & Resubmit KYC
            </button>
          )}
          {authMode === 'local_demo' && kycStatus === 'pending_review' && onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate('admin_panel')}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-100 bg-white/[0.08] hover:bg-white/[0.14] border border-white/[0.14] rounded-lg transition-colors whitespace-nowrap"
            >
              Review in Admin Compliance Queue
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}
          {kycStatus === 'approved' && onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate('deposit_withdraw')}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#05070A] bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors whitespace-nowrap"
            >
              Proceed to Custody Withdrawals
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </section>

      {/* Submitted / Approved / Rejected Dossier Summary */}
      {submission && !showWizard && (
        <section className="bg-[#0B0F16] border border-white/[0.08] rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Submitted Verification Dossier
              </h3>
              <p className="text-xs text-slate-400 mt-0.5 font-mono tabular-nums">
                Submission {submission.id.slice(0, 8)} · Updated {formatTimestamp(submission.updated_at)}
              </p>
            </div>
            <span className="text-xs font-mono text-slate-300 uppercase">
              {submission.account_type === 'corporate' ? 'Corporate KYB' : 'Individual KYC'}
            </span>
          </div>

          <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 text-xs">
            <div className="space-y-1">
              <span className="text-slate-400">Legal / Entity Name</span>
              <div className="text-slate-100 font-medium">{submission.full_legal_name}</div>
            </div>
            <div className="space-y-1">
              <span className="text-slate-400">
                {submission.account_type === 'corporate' ? 'Incorporation Date' : 'Date of Birth'}
              </span>
              <div className="font-mono tabular-nums text-slate-100">{submission.date_of_birth}</div>
            </div>
            <div className="space-y-1">
              <span className="text-slate-400">Jurisdiction / Residence</span>
              <div className="text-slate-100">
                {submission.nationality} / {submission.country_of_residence}
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-slate-400">Identification Document</span>
              <div className="font-mono text-slate-100">
                {submission.id_type.replace('_', ' ')} · {maskIdentifier(submission.id_number)}
              </div>
            </div>
            {submission.tax_or_reg_number && (
              <div className="space-y-1">
                <span className="text-slate-400">Tax / Registry Number</span>
                <div className="font-mono text-slate-100">
                  {maskIdentifier(submission.tax_or_reg_number)}
                </div>
              </div>
            )}
            <div className="space-y-1">
              <span className="text-slate-400">Compliance Audit Timestamp</span>
              <div className="font-mono tabular-nums text-slate-200">
                {submission.reviewed_at ? formatTimestamp(submission.reviewed_at) : 'Awaiting Review'}
              </div>
            </div>
          </div>

          <div className="px-6 py-4 border-t border-white/[0.06] bg-[#05070A]/60 flex flex-wrap items-center gap-6 text-xs text-slate-300">
            <span className="inline-flex items-center gap-1.5">
              <FileCheck2 className="w-4 h-4 text-emerald-400" />
              ID Front Vaulted
            </span>
            {submission.id_back_path && (
              <span className="inline-flex items-center gap-1.5">
                <FileCheck2 className="w-4 h-4 text-emerald-400" />
                ID Back Vaulted
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <FileCheck2 className="w-4 h-4 text-emerald-400" />
              Liveness Selfie Vaulted
            </span>
            <span className="inline-flex items-center gap-1.5">
              <FileCheck2 className="w-4 h-4 text-emerald-400" />
              Proof of Address Vaulted
            </span>
          </div>
        </section>
      )}

      {/* Multi-Step Onboarding Wizard */}
      {showWizard && (
        <section className="bg-[#0B0F16] border border-white/[0.08] rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-[#00E5FF]" />
                {isResubmitting ? 'Resubmit KYC / KYB Package' : 'KYC / KYB Compliance Onboarding'}
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Private encrypted storage (`kyc-documents`) · PDF, JPG, or PNG up to 10 MB per file
              </p>
            </div>

            <div className="flex items-center gap-1.5 text-xs">
              {STEPS.map((s) => {
                const active = step === s.id;
                const done = step > s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      if (s.id < step) setStep(s.id);
                    }}
                    className={`px-2.5 py-1.5 rounded-md font-mono text-[11px] whitespace-nowrap border transition-colors ${
                      active
                        ? 'bg-[#00E5FF]/15 border-[#00E5FF]/40 text-[#00E5FF] font-semibold'
                        : done
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                          : 'bg-[#05070A] border-white/[0.07] text-slate-500'
                    }`}
                  >
                    {s.id}. {s.title}
                  </button>
                );
              })}
            </div>
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-6">
            {formError && (
              <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{formError}</span>
              </div>
            )}

            {/* Step 1 */}
            {step === 1 && (
              <div className="space-y-5">
                <div className="space-y-2">
                  <span className="block text-xs font-medium text-slate-300">Account Profile Type</span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setAccountType('individual');
                        if (idType === 'commercial_registry') setIdType('passport');
                      }}
                      className={`p-4 rounded-xl border text-left transition-colors flex items-start gap-3 ${
                        accountType === 'individual'
                          ? 'bg-[#00E5FF]/10 border-[#00E5FF]/40'
                          : 'bg-[#05070A] border-white/[0.08] hover:border-white/[0.16]'
                      }`}
                    >
                      <User className="w-4 h-4 text-[#00E5FF] mt-0.5 shrink-0" />
                      <div>
                        <div className="text-xs font-semibold text-slate-100">Individual (KYC)</div>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          Sole proprietor, trader, or private treasury operator
                        </p>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAccountType('corporate');
                        setIdType('commercial_registry');
                      }}
                      className={`p-4 rounded-xl border text-left transition-colors flex items-start gap-3 ${
                        accountType === 'corporate'
                          ? 'bg-[#00E5FF]/10 border-[#00E5FF]/40'
                          : 'bg-[#05070A] border-white/[0.08] hover:border-white/[0.16]'
                      }`}
                    >
                      <Building2 className="w-4 h-4 text-[#F5C542] mt-0.5 shrink-0" />
                      <div>
                        <div className="text-xs font-semibold text-slate-100">Corporate (KYB)</div>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          Institutional entity, fund, OTC desk, or corporate treasury
                        </p>
                      </div>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label htmlFor="kyc-legal-name" className="block text-xs font-medium text-slate-300">
                      {accountType === 'corporate' ? 'Registered Legal Entity Name' : 'Full Legal Name'}
                    </label>
                    <input
                      id="kyc-legal-name"
                      type="text"
                      value={fullLegalName}
                      onChange={(e) => setFullLegalName(e.target.value)}
                      placeholder={accountType === 'corporate' ? 'e.g. Apex Clearing AG' : 'e.g. Nadia Mansour'}
                      className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 text-xs text-slate-100 focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="kyc-dob" className="block text-xs font-medium text-slate-300">
                      {accountType === 'corporate' ? 'Date of Incorporation' : 'Date of Birth'}
                    </label>
                    <input
                      id="kyc-dob"
                      type="date"
                      value={dateOfBirth}
                      onChange={(e) => setDateOfBirth(e.target.value)}
                      className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 font-mono text-xs text-slate-100 focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="kyc-nationality" className="block text-xs font-medium text-slate-300">
                      {accountType === 'corporate' ? 'Jurisdiction of Incorporation' : 'Nationality'}
                    </label>
                    <input
                      id="kyc-nationality"
                      type="text"
                      value={nationality}
                      onChange={(e) => setNationality(e.target.value)}
                      placeholder="e.g. Switzerland"
                      className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 text-xs text-slate-100 focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="kyc-residence" className="block text-xs font-medium text-slate-300">
                      Country of Residence / Operations
                    </label>
                    <input
                      id="kyc-residence"
                      type="text"
                      value={countryOfResidence}
                      onChange={(e) => setCountryOfResidence(e.target.value)}
                      placeholder="e.g. United Arab Emirates"
                      className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 text-xs text-slate-100 focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Step 2 */}
            {step === 2 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label htmlFor="kyc-id-type" className="block text-xs font-medium text-slate-300">
                    Primary ID / Registry Document Type
                  </label>
                  <select
                    id="kyc-id-type"
                    value={idType}
                    onChange={(e) => setIdType(e.target.value as KycIdType)}
                    className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 text-xs text-slate-100 focus:outline-none"
                  >
                    <option value="passport">Passport</option>
                    <option value="national_id">National ID Card</option>
                    <option value="commercial_registry">Commercial Registry Certificate</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="kyc-id-number" className="block text-xs font-medium text-slate-300">
                    ID / Registration Number
                  </label>
                  <input
                    id="kyc-id-number"
                    type="text"
                    value={idNumber}
                    onChange={(e) => setIdNumber(e.target.value)}
                    placeholder="e.g. P84920144"
                    className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 font-mono text-xs text-slate-100 focus:outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="kyc-tax" className="block text-xs font-medium text-slate-300">
                    Tax / Commercial Reg. Number{' '}
                    {accountType === 'corporate' ? '(Required for KYB)' : '(Optional)'}
                  </label>
                  <input
                    id="kyc-tax"
                    type="text"
                    value={taxOrRegNumber}
                    onChange={(e) => setTaxOrRegNumber(e.target.value)}
                    placeholder="e.g. CHE-419.802.311"
                    className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 font-mono text-xs text-slate-100 focus:outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="kyc-phone" className="block text-xs font-medium text-slate-300">
                    Contact Phone Number
                  </label>
                  <input
                    id="kyc-phone"
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="e.g. +971 50 412 8890"
                    className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 font-mono text-xs text-slate-100 focus:outline-none"
                  />
                </div>

                <div className="space-y-1.5 sm:col-span-2">
                  <label htmlFor="kyc-address" className="block text-xs font-medium text-slate-300">
                    Residential / Registered Office Address
                  </label>
                  <input
                    id="kyc-address"
                    type="text"
                    value={addressLine}
                    onChange={(e) => setAddressLine(e.target.value)}
                    placeholder="Street, Suite, City, Postal Code, Country"
                    className="w-full bg-[#05070A] border border-white/[0.12] focus:border-[#00E5FF] rounded-lg px-3.5 py-2.5 text-xs text-slate-100 focus:outline-none"
                  />
                </div>
              </div>
            )}

            {/* Step 3 */}
            {step === 3 && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                  <span>
                    Accepted formats: <code className="font-mono text-slate-200">PDF</code>,{' '}
                    <code className="font-mono text-slate-200">JPG</code>,{' '}
                    <code className="font-mono text-slate-200">PNG</code> (max 10 MB per file).
                  </span>
                  <span className="font-mono tabular-nums text-[#00E5FF]">
                    {completedDocsCount} / {idBackRequired ? 4 : 3} Uploaded
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {SLOT_META.map((item) => {
                    const currentPath = docPaths[item.slot];
                    const isUploading = uploadingSlot === item.slot;
                    const required = item.requiredForPassport || idBackRequired;

                    return (
                      <div
                        key={item.slot}
                        className={`bg-[#05070A] border rounded-xl p-4 flex flex-col justify-between gap-3 ${
                          currentPath ? 'border-emerald-500/35' : 'border-white/[0.08]'
                        }`}
                      >
                        <div className="space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-slate-100">
                              {item.title}
                            </span>
                            <span
                              className={`text-[11px] font-mono ${
                                currentPath
                                  ? 'text-emerald-400'
                                  : required
                                    ? 'text-amber-400'
                                    : 'text-slate-500'
                              }`}
                            >
                              {currentPath ? 'Uploaded' : required ? 'Required' : 'Optional'}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-400 leading-relaxed">{item.hint}</p>
                        </div>

                        <div className="flex items-center justify-between gap-3 pt-2 border-t border-white/[0.06]">
                          <div className="text-[11px] font-mono text-slate-400 truncate min-w-0">
                            {isUploading
                              ? 'Uploading...'
                              : docNames[item.slot]
                                ? docNames[item.slot]
                                : currentPath
                                  ? currentPath.split('/').pop()
                                  : 'No file selected'}
                          </div>
                          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#00E5FF] bg-[#00E5FF]/10 hover:bg-[#00E5FF]/20 border border-[#00E5FF]/25 rounded-lg cursor-pointer whitespace-nowrap shrink-0 transition-colors">
                            <Upload className="w-3.5 h-3.5" />
                            <span>{currentPath ? 'Replace' : 'Upload File'}</span>
                            <input
                              type="file"
                              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                              disabled={isUploading}
                              className="sr-only"
                              onChange={(e) => {
                                const file = e.target.files?.[0] ?? null;
                                void handleFileSelect(item.slot, file);
                                e.currentTarget.value = '';
                              }}
                            />
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Step 4 */}
            {step === 4 && (
              <div className="space-y-5">
                <div className="bg-[#05070A] border border-white/[0.08] rounded-xl divide-y divide-white/[0.06] text-xs">
                  <div className="px-4 py-3 flex items-center justify-between">
                    <span className="text-slate-400">Account Type</span>
                    <span className="font-medium text-slate-100 capitalize">{accountType}</span>
                  </div>
                  <div className="px-4 py-3 flex items-center justify-between">
                    <span className="text-slate-400">Legal Name / Entity</span>
                    <span className="font-medium text-slate-100">{fullLegalName}</span>
                  </div>
                  <div className="px-4 py-3 flex items-center justify-between">
                    <span className="text-slate-400">
                      {accountType === 'corporate' ? 'Incorporation Date' : 'Date of Birth'}
                    </span>
                    <span className="font-mono tabular-nums text-slate-100">{dateOfBirth}</span>
                  </div>
                  <div className="px-4 py-3 flex items-center justify-between">
                    <span className="text-slate-400">Jurisdiction / Residence</span>
                    <span className="text-slate-100">
                      {nationality} · {countryOfResidence}
                    </span>
                  </div>
                  <div className="px-4 py-3 flex items-center justify-between">
                    <span className="text-slate-400">ID / Registry Document</span>
                    <span className="font-mono text-slate-100">
                      {idType.replace('_', ' ')} ({maskIdentifier(idNumber)})
                    </span>
                  </div>
                  <div className="px-4 py-3 flex items-center justify-between">
                    <span className="text-slate-400">Attached Documents</span>
                    <span className="inline-flex items-center gap-1.5 text-emerald-400 font-mono">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {completedDocsCount} Vaulted Files
                    </span>
                  </div>
                </div>

                <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-[#05070A] border border-white/[0.08] text-xs text-slate-300">
                  <FileText className="w-4 h-4 text-[#00E5FF] shrink-0 mt-0.5" />
                  <span>
                    I attest that the submitted corporate/personal identity records are accurate and
                    authorize NTPS compliance officers to inspect the vaulted documents under private
                    signed access.
                  </span>
                </div>
              </div>
            )}

            {/* Wizard Footer Navigation */}
            <div className="flex items-center justify-between pt-4 border-t border-white/[0.08]">
              <button
                type="button"
                disabled={step === 1 || isSubmitting}
                onClick={() => {
                  setFormError(null);
                  setStep((prev) => Math.max(1, prev - 1) as 1 | 2 | 3 | 4);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-300 bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-40 border border-white/[0.08] rounded-lg transition-colors whitespace-nowrap"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Back
              </button>

              <div className="flex items-center gap-3">
                {isResubmitting && (
                  <button
                    type="button"
                    onClick={() => setIsResubmitting(false)}
                    className="px-3.5 py-2 text-xs text-slate-400 hover:text-slate-100"
                  >
                    Cancel Edit
                  </button>
                )}

                {step < 4 ? (
                  <button
                    type="button"
                    disabled={uploadingSlot !== null}
                    onClick={handleNextStep}
                    className="inline-flex items-center gap-1.5 px-5 py-2 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
                  >
                    Continue
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={isSubmitting || uploadingSlot !== null}
                    className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-[#05070A] bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    {isSubmitting ? 'Submitting to Compliance...' : 'Submit KYC / KYB Verification'}
                  </button>
                )}
              </div>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
