import type { SupabaseClient } from '@supabase/supabase-js';
import type { TronWeb } from 'tronweb';
import { classifyAmlDbError } from './guards';

export interface AmlScreeningResult {
  allowed: boolean;
  reason?: string;
  riskLevel?: 'high' | 'sanctioned' | 'blocked' | 'invalid' | 'unavailable';
  source?: string;
  /**
   * W-03: `true` لما القرار يكون مبني على فشل في قراءة السجل مش على نتيجة فحص فعلية.
   * الـ caller لازم يعاملها كـ "مش قادرين نفحص" — يعني يوقف الطلب للمراجعة،
   * مش يعدّيه ومش يعتبره "محظور" نهائي (ده ممكن يبقى عطل مؤقت).
   */
  degraded?: boolean;
}

// Well-known TRON burn / zero blackhole addresses that should never receive customer payouts
const BUILTIN_RESTRICTED_TRON_ADDRESSES = new Set<string>([
  'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', // TRON zero/burn address
]);

function parseEnvBlockedSet(): Set<string> {
  const raw = process.env.AML_BLOCKED_ADDRESSES ?? '';
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  );
}

/**
 * W-03: هل المشغّل سمح صراحةً بالعمل في وضع "منقوص" لو جدول الـ AML مش موجود؟
 *
 * الافتراضي **false**. السبب: الجدول جزء من migration 004، وغيابه معناه إن
 * قائمة الحظر الرسمية مش موجودة أصلًا — يعني أي تحويل بيعدّي من غير فحص.
 * لو المشغّل عايز يشغّل قبل تطبيق الـ migration، لازم يقولها بنفسه صراحةً
 * (`AML_ALLOW_DEGRADED_MODE=true`) وده بيتسجّل في اللوج كل مرة.
 */
function allowDegradedMode(): boolean {
  return String(process.env.AML_ALLOW_DEGRADED_MODE ?? '').toLowerCase() === 'true';
}

/**
 * Lightweight pre-broadcast AML and destination sanity screening.
 * Combines TRON Base58Check address validation, built-in burn blackholes,
 * env-configured `AML_BLOCKED_ADDRESSES`, and `public.aml_blocked_addresses`.
 *
 * W-03 — قاعدة الفشل: **fail-closed**.
 * أي حالة مش "فحصنا السجل ولقينا مفيش تطابق" بترجع `allowed: false`.
 * الاستثناء الوحيد هو غياب الجدول مع تفعيل `AML_ALLOW_DEGRADED_MODE=true` صراحةً.
 */
export async function screenWithdrawalDestination(
  supabase: SupabaseClient,
  tronWeb: TronWeb,
  address: string,
  network: string
): Promise<AmlScreeningResult> {
  const cleanAddress = address.trim();

  // 1) تحقق شكلي — مستقل عن أي I/O، ومينفعش يتخطّى
  if (!tronWeb.isAddress(cleanAddress)) {
    return {
      allowed: false,
      reason: `Destination address "${cleanAddress}" failed TRON Base58Check validation.`,
      riskLevel: 'invalid',
      source: 'address_validator',
    };
  }

  // 2) قائمة الحرق المدمجة
  if (BUILTIN_RESTRICTED_TRON_ADDRESSES.has(cleanAddress)) {
    return {
      allowed: false,
      reason: `Destination address ${cleanAddress} is a restricted TRON burn/blackhole address.`,
      riskLevel: 'blocked',
      source: 'builtin_policy',
    };
  }

  // 3) قائمة البيئة
  const envBlocked = parseEnvBlockedSet();
  if (envBlocked.has(cleanAddress)) {
    return {
      allowed: false,
      reason: `Destination address ${cleanAddress} matched AML_BLOCKED_ADDRESSES policy list.`,
      riskLevel: 'blocked',
      source: 'env_aml_list',
    };
  }

  // 4) سجل الحظر في قاعدة البيانات — هنا كانت الثغرة
  let dbMatch: Record<string, unknown> | null = null;
  let dbError: unknown = null;

  try {
    const res = await supabase
      .from('aml_blocked_addresses')
      .select('address, reason, risk_level, source')
      .eq('address', cleanAddress)
      .eq('network', network)
      .eq('active', true)
      .maybeSingle();

    dbMatch = (res.data as Record<string, unknown> | null) ?? null;
    dbError = res.error ?? null;
  } catch (thrown) {
    // استثناء متزامن (شبكة/JSON) — يتعامل معاه كخطأ عابر
    dbError = thrown;
  }

  if (dbError) {
    const errorClass = classifyAmlDbError(dbError);
    const detail =
      dbError && typeof dbError === 'object' && 'message' in dbError
        ? String((dbError as Record<string, unknown>).message)
        : String(dbError);

    // الحالة الوحيدة المسموح فيها بالتجاوز: الجدول مش موجود + تفعيل صريح
    if (errorClass === 'table_missing' && allowDegradedMode()) {
      console.warn(
        `[AML DEGRADED] aml_blocked_addresses is missing and AML_ALLOW_DEGRADED_MODE=true; ` +
          `screening ${cleanAddress} with built-in + env lists only. Apply migration 004 to close this gap.`
      );
      return {
        allowed: true,
        degraded: true,
        source: 'degraded_no_registry',
        reason: 'AML registry table missing; degraded mode explicitly enabled.',
      };
    }

    // كل ما عدا كده: فشل مغلق
    console.error(
      `[AML UNAVAILABLE] Could not read aml_blocked_addresses (class=${errorClass}): ${detail}`
    );

    return {
      allowed: false,
      degraded: true,
      riskLevel: 'unavailable',
      source: 'aml_registry_unavailable',
      reason:
        errorClass === 'table_missing'
          ? 'AML registry table is missing (migration 004 not applied) and degraded mode is not enabled.'
          : `AML registry lookup failed (${errorClass}); refusing to broadcast without screening.`,
    };
  }

  // 5) فحصنا السجل بنجاح — لو فيه تطابق، نحظر
  if (dbMatch) {
    return {
      allowed: false,
      reason: `Destination ${cleanAddress} blocked by AML registry: ${String(dbMatch.reason)}`,
      riskLevel: (dbMatch.risk_level as AmlScreeningResult['riskLevel']) ?? 'blocked',
      source: String(dbMatch.source ?? 'aml_blocked_addresses'),
    };
  }

  // 6) فحص ناجح ومفيش تطابق
  return { allowed: true, source: 'aml_registry_clear' };
}
