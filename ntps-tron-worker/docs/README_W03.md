# W-03 — إصلاح فحص AML الذي يفشل مفتوحًا

## المشكلة (قبل)

`ntps-tron-worker/src/aml.ts` — آخر سطرين في `screenWithdrawalDestination`:

```ts
// Gracefully degrade to env + built-in checks if migration 004 has not been applied yet
if (!error && dbMatch) {
  return { allowed: false, /* ... */ };
}

return { allowed: true };   // ← أي خطأ يوصل هنا = سماح
```

الشرط `!error && dbMatch` معناه: لو الاستعلام رجع **خطأ**، الشرط بيفشل، والكود
بيكمل لـ `return { allowed: true }`. يعني:

- انقطاع شبكة → سماح
- قاعدة البيانات واقعى → سماح
- جدول `aml_blocked_addresses` مش موجود → سماح
- صلاحيات `service_role` اتسحبت → سماح
- استثناء متزامن (JSON غير صالح) → سماح

النتيجة: التحويلات لعناوين محظورة بتعدّي **بالظبط** وقت الأعطال — وده الوقت اللي
المهاجم بيختاره لو عارف إن النظام بيفشل مفتوحًا.

## الإصلاح (بعد)

### 1. `guards.ts` — دالة تصنيف نقية

```ts
export type AmlDbErrorClass = 'table_missing' | 'transient' | 'unknown';
export function classifyAmlDbError(err: unknown): AmlDbErrorClass
```

بتفرّق بين:
| التصنيف | أمثلة | المعنى |
|---|---|---|
| `table_missing` | `42P01`, `PGRST205`, "does not exist" | migration 004 ما اتطبّقتش |
| `transient` | `ETIMEDOUT`, `ECONNRESET`, `fetch failed`, `PGRST301` | عطل شبكة/توفّر عابر |
| `unknown` | `PGRST116`, `XX000`, أي حاجة تانية | مش معروف — بنفشل مغلق |

### 2. `aml.ts` — إعادة كتابة البوابة

- الاستعلام ملفوف في `try/catch` (الاستثناء المتزامن بقى بيتعامل معاه).
- **أي** `dbError` → `allowed: false` مع `degraded: true` و`riskLevel: 'unavailable'`.
- الاستثناء الوحيد: `table_missing` **و** `AML_ALLOW_DEGRADED_MODE=true` صراحةً.
- `degraded: true` بتفرّق "مش قادرين نفحص" عن "العنوان محظور فعلاً".

### 3. `index.ts` — دلالة مختلفة لكل حالة

| الحالة | eventType | المعنى |
|---|---|---|
| محظور فعلاً | `WITHDRAWAL_AML_BLOCKED` | قرار امتثال نهائي — تدخل بشري مطلوب |
| مش قادرين نفحص | `WITHDRAWAL_AML_UNAVAILABLE` | عطل تقني — الطلب يترجع للمراجعة مؤقتًا |

الاتنين بيمنعوا البث. الفرق إن التاني بيقول للمشغّل "صلّح العطل" بدل "افتح الطلب".

### 4. `.env.example` — توثيق المتغير الجديد

```
AML_ALLOW_DEGRADED_MODE="false"
```

## الاختبارات

```bash
cd ntps-tron-worker
npx tsc --noEmit          # exit 0
npm run build
node dist/guards.test.js  # 38 نجح، 0 فشل
node dist/aml.test.js     # 13 نجح، 0 فشل
```

`aml.test.js` بيغطي 13 حالة بـ Supabase مزيّف، منها 10 حالات فشل لازم تمنع البث.

## التحقق على testnet

1. **عطّل الشبكة مؤقتًا** (أو وجّه `SUPABASE_URL` لمضيف غير موجود):
   ```bash
   SUPABASE_URL="https://nonexistent.invalid" npm start
   ```
   المتوقع في اللوج: `[AML UNAVAILABLE] ... class=transient` والطلب يترجع `review`
   مع `last_error` بيبدأ بـ `AML_UNAVAILABLE:`.

2. **احذف الجدول** على نسخة staging:
   ```sql
   DROP TABLE public.aml_blocked_addresses;
   ```
   المتوقع: `class=table_missing` + رفض، **إلا** لو `AML_ALLOW_DEGRADED_MODE=true`.

3. **أضف عنوان محظور** وأعمل سحب عليه:
   ```sql
   INSERT INTO public.aml_blocked_addresses (address, network, reason, risk_level)
   VALUES ('<عنوان تجريبي>', 'TRC20', 'test block', 'blocked');
   ```
   المتوقع: `WITHDRAWAL_AML_BLOCKED` (مش `UNAVAILABLE`) والطلب يفضل `review`.

4. **تأكد إن مفيش بث** في كل الحالات اللي فوق — راجع `transactions.tx_hash` = NULL.

## ملاحظة على التطبيق

الإصلاح ده **مستقل** عن migration 004 — مفيش تغيير في قاعدة البيانات. بس لازم
migration 004 تكون متطبّقة في الإنتاج، وإلا النظام هيرفض كل السحوبات (وده
السلوك الصحيح، بس هتحتاج تفعّل `AML_ALLOW_DEGRADED_MODE` مؤقتًا لو مش قادر
تطبّقها فورًا).
