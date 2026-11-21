/**
 * دوال حراسة نقية (pure) — بدون أي اعتماد على الشبكة أو قاعدة البيانات.
 * فصلها هنا بيخلّيها قابلة للاختبار مباشرة، وبيقلّل مساحة الخطأ في index.ts.
 */

export const USDT_DECIMALS = 6;

/**
 * تحويل المبلغ إلى وحدات العملة الصحيحة (integer units) بدون أي تقريب صامت.
 *
 * ليه ده مهم: الكود القديم كان بيستخدم `Math.floor(amount * 1e6)`، و`amount`
 * جاي من عمود `numeric` في Postgres فبيتحوّل لـ float64 في JS. `Math.floor`
 * على float بيقص أي خطأ تقريب لتحت — يعني مبلغ زي 1.0000009 بيتحوّل لـ
 * 1000000 بدل ما يترفض، ومبلغ زي 0.1+0.2 بيدّي 299999 بدل 300000.
 * في نظام مدفوعات، تقريب مبلغ بالصمت غير مقبول: إحنا بنرفض بدل ما نقرّب.
 *
 * @returns عدد صحيح موجب بالوحدات، أو 0 لو المبلغ غير صالح/غير قابل للتمثيل بدقة.
 */
export function toTokenUnits(amount: number, decimals: number = USDT_DECIMALS): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  const factor = 10 ** decimals;
  const scaled = amount * factor;
  const rounded = Math.round(scaled);

  // أي كسر أصغر من وحدة واحدة = المبلغ مش قابل للتمثيل بدقة العملة → نرفض
  if (Math.abs(scaled - rounded) > 1e-6) return 0;

  if (!Number.isSafeInteger(rounded) || rounded <= 0) return 0;

  return rounded;
}

/**
 * استخراج txid (64 hex) من كائن خطأ صادر من TronWeb.
 *
 * لازم يتنفّذ **قبل** `sanitizeErrorMessage`، لأن الأخيرة بتحجب أي 64-hex
 * (وهو نفس شكل الـ txid) فبتضيّع الدليل على إن البث ممكن يكون نجح.
 */
export function extractTxIdFromError(err: unknown): string | null {
  if (err && typeof err === 'object') {
    const anyErr = err as Record<string, unknown>;
    const nested = anyErr.transaction as Record<string, unknown> | undefined;
    const response = anyErr.response as Record<string, unknown> | undefined;
    const data = anyErr.data as Record<string, unknown> | undefined;

    const candidates = [
      anyErr.txid,
      anyErr.txId,
      nested?.txID,
      response?.txid,
      data?.txid,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && /^[0-9a-fA-F]{64}$/.test(candidate)) {
        return candidate;
      }
    }
  }

  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/\b[0-9a-fA-F]{64}\b/);
  return match ? match[0] : null;
}

/**
 * W-03: تصنيف خطأ قاعدة البيانات اللي رجع من استعلام سجل الـ AML.
 *
 * ليه ده مهم: الكود القديم كان بيعتبر **أي** خطأ = "اسمح بالتحويل" (fail-open).
 * يعني وقت أي عطل في قاعدة البيانات، العناوين المحظورة بتعدّي. التصنيف هنا
 * بيخلّينا نفرّق بين:
 *   - `table_missing`: الجدول نفسه مش موجود (migration 004 ما اتطبّقتش) — حالة إعداد،
 *     مش عطل عابر. مسموح نتجاوزها **فقط** لو المشغّل فعّل `AML_ALLOW_DEGRADED_MODE=true`
 *     صراحةً، وده بيتسجّل في اللوج كل مرة.
 *   - `transient`: الشبكة/الاتصال/المهلة — عطل عابر، بنفشل مغلق.
 *   - `unknown`: أي حاجة تانية (بما فيها PGRST116 = أكتر من صف) — بنفشل مغلق.
 */
export type AmlDbErrorClass = 'table_missing' | 'transient' | 'unknown';

export function classifyAmlDbError(err: unknown): AmlDbErrorClass {
  if (!err || typeof err !== 'object') return 'unknown';

  const e = err as Record<string, unknown>;
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : String(err);

  // Postgres undefined_table (42P01) أو PostgREST schema-cache miss (PGRST205)
  if (code === '42P01' || code === 'PGRST205') return 'table_missing';
  if (/relation .* does not exist/i.test(message)) return 'table_missing';
  if (/could not find the table|schema cache/i.test(message)) return 'table_missing';

  // أعطال نقل/توفّر عابرة
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'PGRST301' ||
    /fetch failed|network|timeout|timed out|socket hang up|ECONNRESET/i.test(message)
  ) {
    return 'transient';
  }

  return 'unknown';
}

export interface DestinationLike {
  address: string;
  network: string;
  verified?: boolean | null;
}

export interface TrustVerdict {
  trusted: boolean;
  reason?: string;
}

/**
 * W-01: تقييم ثقة العنوان المستهدف — الجزء النقي من البوابة.
 *
 * بيترفض:
 *  1. عنوان فاضي
 *  2. أي صف مش موثّق **صراحةً** (`verified !== true`) — مش بنعتمد على
 *     القيمة الافتراضية للعمود، لأنها `true` في الـ schema
 *  3. عنوان مش صالح (بـ validator بيتحقن من بره عشان الدالة تفضل نقية)
 *  4. عنوان اتغيّر بعد الموافقة (TOCTOU) — بمقارنته بالـ snapshot
 */
export function assessDestinationTrust(
  dest: DestinationLike,
  snapshot: string | null | undefined,
  isAddress: (addr: string) => boolean
): TrustVerdict {
  const address = String(dest.address ?? '').trim();

  if (!address) {
    return { trusted: false, reason: 'destination address is empty' };
  }

  if (dest.verified !== true) {
    return {
      trusted: false,
      reason: `whitelist row is not explicitly verified (verified=${String(dest.verified)})`,
    };
  }

  if (!isAddress(address)) {
    return { trusted: false, reason: 'destination failed TRON Base58Check validation' };
  }

  if (snapshot && snapshot.trim().length > 0 && snapshot.trim() !== address) {
    return {
      trusted: false,
      reason: `destination changed after approval (approved=${snapshot.trim()}, current=${address})`,
    };
  }

  return { trusted: true };
}
