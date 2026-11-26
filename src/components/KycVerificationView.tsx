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
  validateKycDateOfBirth,
  validateKycDocumentFile,
  type KycDocumentSlot,
  type LedgerRuntimeMode,
} from '../lib/ledgerEngine';
import { formatTimestamp } from '../lib/format';
import { useLocale } from '../context/LocaleContext';

interface KycVerificationViewProps {
  submission: KycSubmissionRecord | null;
  userId?: string;
  authMode: LedgerRuntimeMode;
  onSubmitKyc: (input: KycSubmissionInput) => Promise<void>;
  onNavigate?: (view: ActiveView) => void;
  onToast: (title: string, description?: string, variant?: 'success' | 'error' | 'info') => void;
}

const STEPS = [
  { id: 1, titleEn: 'Entity & Profile', titleAr: 'الكيان والملف' },
  { id: 2, titleEn: 'ID & Contact', titleAr: 'الهوية والتواصل' },
  { id: 3, titleEn: 'Document Vault', titleAr: 'خزنة المستندات' },
  { id: 4, titleEn: 'Review & Submit', titleAr: 'المراجعة والإرسال' },
] as const;

const SLOT_META: {
  slot: KycDocumentSlot;
  titleEn: string;
  titleAr: string;
  hintEn: string;
  hintAr: string;
  requiredForPassport: boolean;
}[] = [
  {
    slot: 'id_front',
    titleEn: 'Government ID / Incorporation Front',
    titleAr: 'الوجه الأمامي للهوية / شهادة التأسيس',
    hintEn:
      'Clear color scan or photo of passport bio page, front of national ID, or certificate of incorporation.',
    hintAr: 'مسح ملون واضح لصفحة الجواز أو الوجه الأمامي للهوية الوطنية أو شهادة التأسيس.',
    requiredForPassport: true,
  },
  {
    slot: 'id_back',
    titleEn: 'Government ID Back / Registry Addendum',
    titleAr: 'الوجه الخلفي للهوية / ملحق السجل',
    hintEn:
      'Back side of national ID or secondary commercial registry page (optional for passport).',
    hintAr: 'الوجه الخلفي للهوية الوطنية أو صفحة السجل التجاري الإضافية (اختياري للجواز).',
    requiredForPassport: false,
  },
  {
    slot: 'selfie',
    titleEn: 'Authorized Signatory Liveness Selfie',
    titleAr: 'صورة شخصية للمفوض بالتوقيع',
    hintEn:
      'Unedited portrait photo of the applicant or authorized corporate signatory holding their ID.',
    hintAr: 'صورة شخصية غير معدلة لمقدم الطلب أو المفوض بالتوقيع حاملاً الهوية.',
    requiredForPassport: true,
  },
  {
    slot: 'proof_of_address',
    titleEn: 'Proof of Address / Registered Office',
    titleAr: 'إثبات العنوان / المقر المسجل',
    hintEn: 'Recent utility bill, bank statement, or official registry extract issued within 90 days.',
    hintAr: 'فاتورة خدمات حديثة أو كشف حساب بنكي أو مستخرج سجل رسمي خلال آخر 90 يوماً.',
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
  const { tr } = useLocale();
  const kycStatus: KycStatus = submission?.status ?? 'unverified';
  const [isResubmitting, setIsResubmitting] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
    setDateOfBirth(submission.date_of_birth ?? '');
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
      onToast(tr('Document rejected', 'تم رفض المستند'), msg, 'error');
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
      onToast(
        tr('Document uploaded', 'تم رفع المستند'),
        `${file.name} stored in private KYC vault.`,
        'success'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to upload document.';
      setFormError(msg);
      onToast(tr('Upload failed', 'فشل الرفع'), msg, 'error');
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
      try {
        validateKycDateOfBirth(accountType, dateOfBirth);
      } catch (err) {
        return err instanceof Error ? err.message : 'Invalid date provided.';
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
        onToast(tr('Step incomplete', 'الخطوة غير مكتملة'), err, 'error');
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
        onToast(tr('Verification incomplete', 'التوثيق غير مكتمل'), err, 'error');
        return;
      }
    }

    setIsSubmitting(true);
    try {
      await onSubmitKyc({
        account_type: accountType,
        full_legal_name: fullLegalName.trim(),
        date_of_birth: dateOfBirth.trim() || null,
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
        tr('KYC / KYB Submitted', 'تم إرسال طلب التوثيق'),
        tr('Your verification dossier is now queued for compliance review.', 'ملف التوثيق الخاص بك قيد مراجعة الامتثال الآن.'),
        'success'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to submit KYC package.';
      setFormError(msg);
      onToast(tr('Submission failed', 'فشل الإرسال'), msg, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Status Banner */}
      <section
        className={`rounded-xl border p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4 shadow-xs ${
          kycStatus === 'approved'
            ? 'bg-emerald-50 border-emerald-200'
            : kycStatus === 'pending_review'
              ? 'bg-blue-50 border-blue-200'
              : kycStatus === 'rejected'
                ? 'bg-red-50 border-red-200'
                : 'bg-amber-50 border-amber-200'
        }`}
      >
        <div className="flex items-start gap-3.5 max-w-2xl">
          <div className="mt-0.5 shrink-0">
            {kycStatus === 'approved' ? (
              <ShieldCheck className="w-6 h-6 text-emerald-700" />
            ) : kycStatus === 'pending_review' ? (
              <Clock className="w-6 h-6 text-[#1E40AF]" />
            ) : kycStatus === 'rejected' ? (
              <ShieldAlert className="w-6 h-6 text-red-700" />
            ) : (
              <AlertCircle className="w-6 h-6 text-amber-700" />
            )}
          </div>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-base font-semibold text-[#0F172A]">
                {kycStatus === 'approved'
                  ? tr('KYC / KYB Verified', 'تم توثيق الهوية والشركات')
                  : kycStatus === 'pending_review'
                    ? tr('Pending Compliance Review', 'بانتظار مراجعة الامتثال')
                    : kycStatus === 'rejected'
                      ? tr('Verification Rejected', 'تم رفض التوثيق')
                      : tr('Identity Verification Required (Unverified)', 'التحقق من الهوية مطلوب (غير موثق)')}
              </h2>
              <span
                className={`font-mono text-[11px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded border ${
                  kycStatus === 'approved'
                    ? 'bg-white text-emerald-700 border-emerald-300'
                    : kycStatus === 'pending_review'
                      ? 'bg-white text-[#1E40AF] border-blue-300'
                      : kycStatus === 'rejected'
                        ? 'bg-white text-red-700 border-red-300'
                        : 'bg-white text-amber-800 border-amber-300'
                }`}
              >
                {kycStatus.replace('_', ' ')}
              </span>
            </div>
            <p className="text-xs text-slate-700 leading-relaxed">
              {kycStatus === 'approved'
                ? tr(
                    'Your institutional profile passed compliance screening. Master & Sub-Terminal provisioning and custody withdrawals are unlocked.',
                    'اجتاز ملفك المؤسسي فحص الامتثال. تم فتح إنشاء المحطات والسحوبات الخارجية.'
                  )
                : kycStatus === 'pending_review'
                  ? tr(
                      'Your identity package and encrypted documents are under active compliance review. Terminal provisioning and external withdrawals unlock upon approval.',
                      'ملف الهوية والمستندات المشفرة قيد المراجعة النشطة. ستُفتح الميزات فور الموافقة.'
                    )
                  : kycStatus === 'rejected'
                    ? submission?.rejection_reason ||
                      tr(
                        'Your submission was rejected by compliance. Review the note below and resubmit corrected documents.',
                        'تم رفض طلبك من قسم الامتثال. راجع الملاحظة وأعد إرسال المستندات المصححة.'
                      )
                    : tr(
                        'Complete Individual KYC or Corporate KYB onboarding to activate live treasury provisioning, Sub-Terminal creation, and external custody withdrawals.',
                        'أكمل التوثيق الفردي أو المؤسسي لتفعيل الخزينة وإنشاء المحطات الفرعية والسحوبات.'
                      )}
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
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors whitespace-nowrap"
            >
              {tr('Edit & Resubmit KYC', 'تعديل وإعادة إرسال الطلب')}
            </button>
          )}
          {authMode === 'local_demo' && kycStatus === 'pending_review' && onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate('admin_panel')}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#1E40AF] hover:bg-[#24489B] rounded-lg transition-colors whitespace-nowrap"
            >
              {tr('Review in Admin Compliance Queue', 'المراجعة في قائمة الامتثال')}
              <ChevronRight className="w-3.5 h-3.5 rtl:rotate-180" />
            </button>
          )}
          {kycStatus === 'approved' && onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate('deposit_withdraw')}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors whitespace-nowrap"
            >
              {tr('Proceed to Custody Withdrawals', 'الانتقال إلى السحوبات')}
              <ChevronRight className="w-3.5 h-3.5 rtl:rotate-180" />
            </button>
          )}
        </div>
      </section>

      {/* Submitted / Approved / Rejected Dossier Summary */}
      {submission && !showWizard && (
        <section className="bg-white border border-[#E2E8F0] rounded-xl overflow-hidden shadow-xs">
          <div className="px-6 py-4 border-b border-[#E2E8F0] bg-[#F8FAFC] flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[#0F172A]">
                {tr('Submitted Verification Dossier', 'ملف التوثيق المرسل')}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                {tr('Submission', 'الطلب')} {submission.id.slice(0, 8)} · {tr('Updated', 'محدث')}{' '}
                {formatTimestamp(submission.updated_at)}
              </p>
            </div>
            <span className="text-xs font-mono font-semibold text-[#1E40AF] uppercase bg-blue-50 border border-blue-200 px-2.5 py-1 rounded">
              {submission.account_type === 'corporate' ? 'Corporate KYB' : 'Individual KYC'}
            </span>
          </div>

          <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 text-xs">
            <div className="space-y-1">
              <span className="text-slate-500">{tr('Legal / Entity Name', 'الاسم القانوني / الكيان')}</span>
              <div className="text-[#0F172A] font-semibold">{submission.full_legal_name}</div>
            </div>
            <div className="space-y-1">
              <span className="text-slate-500">
                {submission.account_type === 'corporate'
                  ? tr('Incorporation Date', 'تاريخ التأسيس')
                  : tr('Date of Birth', 'تاريخ الميلاد')}
              </span>
              <div className="font-mono tabular-nums text-[#0F172A] font-medium">
                {submission.date_of_birth || tr('Not provided', 'غير متوفر')}
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-slate-500">{tr('Jurisdiction / Residence', 'الاختصاص / الإقامة')}</span>
              <div className="text-[#0F172A] font-medium">
                {submission.nationality} / {submission.country_of_residence}
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-slate-500">{tr('Identification Document', 'وثيقة الهوية')}</span>
              <div className="font-mono tabular-nums text-[#0F172A] font-medium">
                {submission.id_type.replace('_', ' ')} · {maskIdentifier(submission.id_number)}
              </div>
            </div>
            {submission.tax_or_reg_number && (
              <div className="space-y-1">
                <span className="text-slate-500">{tr('Tax / Registry Number', 'الرقم الضريبي / السجل')}</span>
                <div className="font-mono tabular-nums text-[#0F172A] font-medium">
                  {maskIdentifier(submission.tax_or_reg_number)}
                </div>
              </div>
            )}
            <div className="space-y-1">
              <span className="text-slate-500">{tr('Compliance Audit Timestamp', 'وقت مراجعة الامتثال')}</span>
              <div className="font-mono tabular-nums text-slate-700">
                {submission.reviewed_at
                  ? formatTimestamp(submission.reviewed_at)
                  : tr('Awaiting Review', 'بانتظار المراجعة')}
              </div>
            </div>
          </div>

          <div className="px-6 py-4 border-t border-[#E2E8F0] bg-[#F8FAFC] flex flex-wrap items-center gap-6 text-xs text-[#0F172A] font-medium">
            <span className="inline-flex items-center gap-1.5">
              <FileCheck2 className="w-4 h-4 text-emerald-700" />
              {tr('ID Front Vaulted', 'الوجه الأمامي محفوظ')}
            </span>
            {submission.id_back_path && (
              <span className="inline-flex items-center gap-1.5">
                <FileCheck2 className="w-4 h-4 text-emerald-700" />
                {tr('ID Back Vaulted', 'الوجه الخلفي محفوظ')}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <FileCheck2 className="w-4 h-4 text-emerald-700" />
              {tr('Liveness Selfie Vaulted', 'الصورة الشخصية محفوظة')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <FileCheck2 className="w-4 h-4 text-emerald-700" />
              {tr('Proof of Address Vaulted', 'إثبات العنوان محفوظ')}
            </span>
          </div>
        </section>
      )}

      {/* Multi-Step Onboarding Wizard */}
      {showWizard && (
        <section className="bg-white border border-[#E2E8F0] rounded-xl overflow-hidden shadow-xs">
          <div className="px-6 py-4 border-b border-[#E2E8F0] bg-[#F8FAFC] flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-[#0F172A] flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-[#1E40AF]" />
                {isResubmitting
                  ? tr('Resubmit KYC / KYB Package', 'إعادة إرسال ملف التوثيق')
                  : tr('KYC / KYB Compliance Onboarding', 'إجراءات امتثال التوثيق KYC / KYB')}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {tr(
                  'Private encrypted storage (kyc-documents) · PDF, JPG, or PNG up to 10 MB per file',
                  'تخزين خاص مشفر · PDF أو JPG أو PNG بحد أقصى 10 ميجابايت للملف'
                )}
              </p>
            </div>

            <div className="flex items-center gap-1.5 text-xs flex-wrap">
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
                    className={`px-2.5 py-1.5 rounded-md font-mono tabular-nums text-[11px] whitespace-nowrap border transition-colors ${
                      active
                        ? 'bg-[#1E40AF] border-[#1E40AF] text-white font-semibold shadow-xs'
                        : done
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-700 font-medium'
                          : 'bg-white border-[#E2E8F0] text-slate-500'
                    }`}
                  >
                    {s.id}. {tr(s.titleEn, s.titleAr)}
                  </button>
                );
              })}
            </div>
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-6 bg-white">
            {formError && (
              <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <span>{formError}</span>
              </div>
            )}

            {/* Step 1 */}
            {step === 1 && (
              <div className="space-y-5">
                <div className="space-y-2">
                  <span className="block text-xs font-semibold text-[#0F172A]">
                    {tr('Account Profile Type', 'نوع ملف الحساب')}
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setAccountType('individual');
                        if (idType === 'commercial_registry') setIdType('passport');
                      }}
                      className={`p-4 rounded-xl border text-start transition-colors flex items-start gap-3 ${
                        accountType === 'individual'
                          ? 'bg-blue-50/70 border-[#1E40AF] ring-1 ring-[#1E40AF]/20'
                          : 'bg-[#F8FAFC] border-[#E2E8F0] hover:border-slate-300'
                      }`}
                    >
                      <User className="w-4 h-4 text-[#1E40AF] mt-0.5 shrink-0" />
                      <div>
                        <div className="text-xs font-semibold text-[#0F172A]">
                          {tr('Individual (KYC)', 'فردي (KYC)')}
                        </div>
                        <p className="text-[11px] text-slate-600 mt-0.5">
                          {tr(
                            'Sole proprietor, trader, or private treasury operator',
                            'مالك فردي أو متداول أو مشغل خزينة خاصة'
                          )}
                        </p>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAccountType('corporate');
                        setIdType('commercial_registry');
                      }}
                      className={`p-4 rounded-xl border text-start transition-colors flex items-start gap-3 ${
                        accountType === 'corporate'
                          ? 'bg-blue-50/70 border-[#1E40AF] ring-1 ring-[#1E40AF]/20'
                          : 'bg-[#F8FAFC] border-[#E2E8F0] hover:border-slate-300'
                      }`}
                    >
                      <Building2 className="w-4 h-4 text-[#1E40AF] mt-0.5 shrink-0" />
                      <div>
                        <div className="text-xs font-semibold text-[#0F172A]">
                          {tr('Corporate (KYB)', 'شركات ومؤسسات (KYB)')}
                        </div>
                        <p className="text-[11px] text-slate-600 mt-0.5">
                          {tr(
                            'Institutional entity, fund, OTC desk, or corporate treasury',
                            'كيان مؤسسي أو صندوق استثمار أو مكتب تداول أو خزينة شركة'
                          )}
                        </p>
                      </div>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label htmlFor="kyc-legal-name" className="block text-xs font-semibold text-[#0F172A]">
                      {accountType === 'corporate'
                        ? tr('Registered Legal Entity Name', 'الاسم القانوني المسجل للكيان')
                        : tr('Full Legal Name', 'الاسم القانوني الكامل')}
                    </label>
                    <input
                      id="kyc-legal-name"
                      type="text"
                      value={fullLegalName}
                      onChange={(e) => setFullLegalName(e.target.value)}
                      placeholder={accountType === 'corporate' ? 'e.g. Apex Clearing AG' : 'e.g. Nadia Mansour'}
                      className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2.5 text-xs text-[#0F172A] placeholder:text-slate-400 focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="kyc-dob" className="block text-xs font-semibold text-[#0F172A]">
                      {accountType === 'corporate'
                        ? tr('Date of Incorporation (Optional)', 'تاريخ التأسيس (اختياري)')
                        : tr('Date of Birth (18+ required)', 'تاريخ الميلاد (18+ مطلوب)')}
                    </label>
                    <input
                      id="kyc-dob"
                      type="date"
                      value={dateOfBirth}
                      onChange={(e) => setDateOfBirth(e.target.value)}
                      className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2.5 font-mono tabular-nums text-xs text-[#0F172A] focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="kyc-nationality" className="block text-xs font-semibold text-[#0F172A]">
                      {accountType === 'corporate'
                        ? tr('Jurisdiction of Incorporation', 'دولة التأسيس')
                        : tr('Nationality', 'الجنسية')}
                    </label>
                    <input
                      id="kyc-nationality"
                      type="text"
                      value={nationality}
                      onChange={(e) => setNationality(e.target.value)}
                      placeholder="e.g. Switzerland"
                      className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2.5 text-xs text-[#0F172A] placeholder:text-slate-400 focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="kyc-residence" className="block text-xs font-semibold text-[#0F172A]">
                      {tr('Country of Residence / Operations', 'بلد الإقامة / العمليات')}
                    </label>
                    <input
                      id="kyc-residence"
                      type="text"
                      value={countryOfResidence}
                      onChange={(e) => setCountryOfResidence(e.target.value)}
                      placeholder="e.g. United Arab Emirates"
                      className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2.5 text-xs text-[#0F172A] placeholder:text-slate-400 focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Step 2 */}
            {step === 2 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label htmlFor="kyc-id-type" className="block text-xs font-semibold text-[#0F172A]">
                    {tr('Primary ID / Registry Document Type', 'نوع الوثيقة الأساسية')}
                  </label>
                  <select
                    id="kyc-id-type"
                    value={idType}
                    onChange={(e) => setIdType(e.target.value as KycIdType)}
                    className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2.5 text-xs text-[#0F172A] focus:outline-none"
                  >
                    <option value="passport">{tr('Passport', 'جواز سفر')}</option>
                    <option value="national_id">{tr('National ID Card', 'بطاقة هوية وطنية')}</option>
                    <option value="commercial_registry">
                      {tr('Commercial Registry Certificate', 'شهادة السجل التجاري')}
                    </option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="kyc-id-number" className="block text-xs font-semibold text-[#0F172A]">
                    {tr('ID / Registration Number', 'رقم الهوية / السجل')}
                  </label>
                  <input
                    id="kyc-id-number"
                    type="text"
                    value={idNumber}
                    onChange={(e) => setIdNumber(e.target.value)}
                    placeholder="e.g. P84920144"
                    className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2.5 font-mono tabular-nums text-xs text-[#0F172A] placeholder:text-slate-400 focus:outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="kyc-tax" className="block text-xs font-semibold text-[#0F172A]">
                    {tr('Tax / Commercial Reg. Number', 'الرقم الضريبي / التسجيل التجاري')}{' '}
                    {accountType === 'corporate'
                      ? tr('(Required for KYB)', '(مطلوب للشركات)')
                      : tr('(Optional)', '(اختياري)')}
                  </label>
                  <input
                    id="kyc-tax"
                    type="text"
                    value={taxOrRegNumber}
                    onChange={(e) => setTaxOrRegNumber(e.target.value)}
                    placeholder="e.g. CHE-419.802.311"
                    className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2.5 font-mono tabular-nums text-xs text-[#0F172A] placeholder:text-slate-400 focus:outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="kyc-phone" className="block text-xs font-semibold text-[#0F172A]">
                    {tr('Contact Phone Number', 'رقم هاتف التواصل')}
                  </label>
                  <input
                    id="kyc-phone"
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="e.g. +971 50 412 8890"
                    className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2.5 font-mono tabular-nums text-xs text-[#0F172A] placeholder:text-slate-400 focus:outline-none"
                  />
                </div>

                <div className="space-y-1.5 sm:col-span-2">
                  <label htmlFor="kyc-address" className="block text-xs font-semibold text-[#0F172A]">
                    {tr('Residential / Registered Office Address', 'عنوان الإقامة / المقر المسجل')}
                  </label>
                  <input
                    id="kyc-address"
                    type="text"
                    value={addressLine}
                    onChange={(e) => setAddressLine(e.target.value)}
                    placeholder={tr('Street, Suite, City, Postal Code, Country', 'الشارع، المكتب، المدينة، الرمز البريدي، الدولة')}
                    className="w-full bg-[#F8FAFC] border border-[#E2E8F0] focus:border-[#1E40AF] focus:bg-white rounded-lg px-3.5 py-2.5 text-xs text-[#0F172A] placeholder:text-slate-400 focus:outline-none"
                  />
                </div>
              </div>
            )}

            {/* Step 3 */}
            {step === 3 && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                  <span>
                    {tr('Accepted formats:', 'الصيغ المقبولة:')}{' '}
                    <code className="font-mono text-[#0F172A] font-semibold">PDF</code>,{' '}
                    <code className="font-mono text-[#0F172A] font-semibold">JPG</code>,{' '}
                    <code className="font-mono text-[#0F172A] font-semibold">PNG</code> (max 10 MB).
                  </span>
                  <span className="font-mono tabular-nums text-[#1E40AF] font-semibold">
                    {completedDocsCount} / {idBackRequired ? 4 : 3} {tr('Uploaded', 'مرفوع')}
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
                        className={`bg-[#F8FAFC] border rounded-xl p-4 flex flex-col justify-between gap-3 ${
                          currentPath ? 'border-emerald-300 bg-emerald-50/40' : 'border-[#E2E8F0]'
                        }`}
                      >
                        <div className="space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-[#0F172A]">
                              {tr(item.titleEn, item.titleAr)}
                            </span>
                            <span
                              className={`text-[11px] font-mono font-semibold ${
                                currentPath
                                  ? 'text-emerald-700'
                                  : required
                                    ? 'text-amber-700'
                                    : 'text-slate-500'
                              }`}
                            >
                              {currentPath
                                ? tr('Uploaded', 'مرفوع')
                                : required
                                  ? tr('Required', 'مطلوب')
                                  : tr('Optional', 'اختياري')}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-600 leading-relaxed">
                            {tr(item.hintEn, item.hintAr)}
                          </p>
                        </div>

                        <div className="flex items-center justify-between gap-3 pt-2 border-t border-[#E2E8F0]">
                          <div className="text-[11px] font-mono text-slate-600 truncate min-w-0">
                            {isUploading
                              ? tr('Uploading...', 'جاري الرفع...')
                              : docNames[item.slot]
                                ? docNames[item.slot]
                                : currentPath
                                  ? currentPath.split('/').pop()
                                  : tr('No file selected', 'لم يتم اختيار ملف')}
                          </div>
                          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[#1E40AF] hover:bg-[#24489B] rounded-lg cursor-pointer whitespace-nowrap shrink-0 transition-colors">
                            <Upload className="w-3.5 h-3.5 text-[#D6FF3D]" />
                            <span>
                              {currentPath
                                ? tr('Replace', 'استبدال')
                                : tr('Upload File', 'رفع ملف')}
                            </span>
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
                <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl divide-y divide-[#E2E8F0] text-xs">
                  <div className="px-4 py-3 flex items-center justify-between">
                    <span className="text-slate-500">{tr('Account Type', 'نوع الحساب')}</span>
                    <span className="font-semibold text-[#0F172A] capitalize">{accountType}</span>
                  </div>
                  <div className="px-4 py-3 flex items-center justify-between">
                    <span className="text-slate-500">{tr('Legal Name / Entity', 'الاسم القانوني / الكيان')}</span>
                    <span className="font-semibold text-[#0F172A]">{fullLegalName}</span>
                  </div>
                  <div className="px-4 py-3 flex items-center justify-between">
                    <span className="text-slate-500">
                      {accountType === 'corporate'
                        ? tr('Incorporation Date', 'تاريخ التأسيس')
                        : tr('Date of Birth', 'تاريخ الميلاد')}
                    </span>
                    <span className="font-mono tabular-nums text-[#0F172A]">
                      {dateOfBirth.trim() || tr('Not provided', 'غير متوفر')}
                    </span>
                  </div>
                  <div className="px-4 py-3 flex items-center justify-between">
                    <span className="text-slate-500">{tr('Jurisdiction / Residence', 'الاختصاص / الإقامة')}</span>
                    <span className="text-[#0F172A]">
                      {nationality} · {countryOfResidence}
                    </span>
                  </div>
                  <div className="px-4 py-3 flex items-center justify-between">
                    <span className="text-slate-500">{tr('ID / Registry Document', 'وثيقة الهوية / السجل')}</span>
                    <span className="font-mono tabular-nums text-[#0F172A]">
                      {idType.replace('_', ' ')} ({maskIdentifier(idNumber)})
                    </span>
                  </div>
                  <div className="px-4 py-3 flex items-center justify-between">
                    <span className="text-slate-500">{tr('Attached Documents', 'المستندات المرفقة')}</span>
                    <span className="inline-flex items-center gap-1.5 text-emerald-700 font-mono font-semibold">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {completedDocsCount} {tr('Vaulted Files', 'ملفات محفوظة')}
                    </span>
                  </div>
                </div>

                <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-[#F4F7FA] border border-[#E2E8F0] text-xs text-slate-700">
                  <FileText className="w-4 h-4 text-[#1E40AF] shrink-0 mt-0.5" />
                  <span>
                    {tr(
                      'I attest that the submitted corporate/personal identity records are accurate and authorize NTPS compliance officers to inspect the vaulted documents under private signed access.',
                      'أقر بصحة بيانات الهوية المؤسسية/الشخصية المقدمة وأفوض مسؤولي الامتثال في NTPS بفحص المستندات المحفوظة.'
                    )}
                  </span>
                </div>
              </div>
            )}

            {/* Wizard Footer Navigation */}
            <div className="flex items-center justify-between pt-4 border-t border-[#E2E8F0]">
              <button
                type="button"
                disabled={step === 1 || isSubmitting}
                onClick={() => {
                  setFormError(null);
                  setStep((prev) => Math.max(1, prev - 1) as 1 | 2 | 3 | 4);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-[#0F172A] bg-[#F4F7FA] hover:bg-slate-200/70 disabled:opacity-40 border border-[#E2E8F0] rounded-lg transition-colors whitespace-nowrap"
              >
                <ChevronLeft className="w-3.5 h-3.5 rtl:rotate-180" />
                {tr('Back', 'السابق')}
              </button>

              <div className="flex items-center gap-3">
                {isResubmitting && (
                  <button
                    type="button"
                    onClick={() => setIsResubmitting(false)}
                    className="px-3.5 py-2 text-xs text-slate-500 hover:text-[#0F172A]"
                  >
                    {tr('Cancel Edit', 'إلغاء التعديل')}
                  </button>
                )}

                {step < 4 ? (
                  <button
                    type="button"
                    disabled={uploadingSlot !== null}
                    onClick={handleNextStep}
                    className="inline-flex items-center gap-1.5 px-5 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shadow-xs"
                  >
                    {tr('Continue', 'متابعة')}
                    <ChevronRight className="w-3.5 h-3.5 rtl:rotate-180" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={isSubmitting || uploadingSlot !== null}
                    className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shadow-xs"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    {isSubmitting
                      ? tr('Submitting to Compliance...', 'جاري الإرسال للامتثال...')
                      : tr('Submit KYC / KYB Verification', 'إرسال طلب التوثيق')}
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
