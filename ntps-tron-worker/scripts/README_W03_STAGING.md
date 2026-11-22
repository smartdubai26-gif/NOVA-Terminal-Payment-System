# W-03 — سكربت اختبار آلي لسيناريوهات فحص AML

سكربت واحد بيشغّل **7 سيناريوهات** على الـ worker الحقيقي (مش mocks للدوال)،
ويتأكد في كل حالة إن الطلب اترجع للمراجعة وإن **مفيش بث حصل**.

---

## الملفات

| الملف | الوصف |
|---|---|
| `w03-staging-test.js` | السكربت الرئيسي — بيشغّل الـ worker كعملية منفصلة |
| `ws-shim.js` | يوفر `WebSocket` عالمي لـ Node 20 (مطلوب لـ `@supabase/supabase-js`) |
| `w03-report.json` | تقرير JSON بيتولّد بـ `--json` |

---

## طريقة العمل

السكربت **مش** بيعمل mock لدوال الـ worker. هو بيشغّل `dist/index.js` الحقيقي
كعملية منفصلة، وبيحاكي الطبقتين اللي الـ worker بيتكلم معاهم:

```
┌─────────────────────────────────────────────────────────────┐
│  w03-staging-test.js  (الـ harness)                          │
│                                                              │
│   ┌──────────────────┐        ┌──────────────────────────┐  │
│   │ PostgREST مزيّف  │◄───────│  worker (dist/index.js)  │  │
│   │  (في الذاكرة)    │        │  عملية منفصلة حقيقية     │  │
│   └──────────────────┘        └───────────┬──────────────┘  │
│                                            │                 │
│   ┌──────────────────┐                    │                 │
│   │  TRON مزيّف      │◄───────────────────┘                 │
│   │  (يرصد أي بث)    │                                      │
│   └──────────────────┘                                      │
└─────────────────────────────────────────────────────────────┘
```

**ليه ده مهم:** لأننا بنختبر **مسار الكود الحقيقي** — الـ claim الذرّي، بوابة
الثقة، بوابة AML، وكتابة سجل التدقيق. لو اختبرنا الدوال لوحدها كنا هنفوّت
الترتيب بينهم (وده بالظبط اللي كان بيكسر W-03).

**مفيش أي اتصال شبكة حقيقي** — لا Supabase ولا TRON. الـ TRON المزيّف بيرصد
أي محاولة بث ويرجّع فشل، فلو الكود حاول يبعت، الاختبار هيفشل.

---

## التشغيل

```bash
# 1. ابنِ الـ worker
cd ntps-tron-worker
npm install
npm run build

# 2. شغّل السكربت
cd ..
node w03-staging-test.js
```

### الخيارات

| الخيار | الوظيفة |
|---|---|
| `--verbose` | يطبع لوج الـ worker كامل |
| `--json` | يكتب `w03-report.json` |
| `--only=S1` | يشغّل سيناريو واحد بس |
| `WORKER_DIR=/path` | يحدد مجلد الـ worker |

### كود الخروج

- `0` — كل السيناريوهات نجحت
- `1` — في سيناريو فشل
- `2` — الـ worker مش مبني

مناسب للـ CI مباشرة.

---

## السيناريوهات

| # | السيناريو | المتوقع |
|---|---|---|
| **S1** | عطل نقل — `ETIMEDOUT` من قاعدة البيانات | `review` + `WITHDRAWAL_AML_UNAVAILABLE` + مفيش بث |
| **S2** | جدول `aml_blocked_addresses` ناقص (migration 004 مش متطبّقة) | `review` + `WITHDRAWAL_AML_UNAVAILABLE` + مفيش بث |
| **S3** | خطأ غير معروف في قراءة السجل (`XX000`) | `review` + `WITHDRAWAL_AML_UNAVAILABLE` + مفيش بث |
| **S4** | عنوان محظور فعلاً في السجل | `review` + `WITHDRAWAL_AML_BLOCKED` + مفيش بث |
| **S5** | عنوان حرق مدمج في الكود | `review` + `WITHDRAWAL_AML_BLOCKED` + مفيش بث |
| **S6** | فحص ناجح بدون تطابق (**control**) | يعدّي لـ `broadcast` |
| **S7** | جدول ناقص + `AML_ALLOW_DEGRADED_MODE=true` | يعدّي لـ `broadcast` (تجاوز صريح) |

**S1–S5** هي حالات الفشل اللي **لازم** تمنع البث. **S6–S7** هما الحالتان
الوحيدتان المسموح فيهما بالتجاوز — لو أي واحدة منهم فشلت، يبقى الإصلاح
قفل النظام أكتر من اللازم.

### الفحوصات في كل سيناريو

1. الحالة النهائية للطلب = المتوقعة
2. `transactions.tx_hash` فاضي (مفيش بث)
3. حدث التدقيق المتوقع موجود في `audit_logs`
4. مفيش أي محاولة بث وصلت لشبكة TRON
5. `last_error` بيبدأ بالبادئة المتوقعة (`AML_UNAVAILABLE:` / `AML_BLOCKED:`)

---

## إثبات إن السكربت بيكشف الثغرة فعلاً

ده أهم جزء. السكربت **اتأكد إنه بيفشل على الكود القديم**:

```bash
# رجّع النسخة القديمة من aml.ts (اللي بتفشل مفتوحًا)
git show HEAD:ntps-tron-worker/src/aml.ts > ntps-tron-worker/src/aml.ts
npm run build
node w03-staging-test.js
```

**النتيجة الفعلية:**

| الكود | S1 | S2 | S3 | S4 | S5 | S6 | S7 | الإجمالي |
|---|---|---|---|---|---|---|---|---|
| **قبل الإصلاح** | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | **4/7** |
| **بعد الإصلاح** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **7/7** |

S1 و S2 و S3 فشلوا على الكود القديم — وده بالظبط معنى "الفشل المفتوح":
عطل شبكة، جدول ناقص، وخطأ غير معروف كلهم كانوا بيسمحوا بالبث.

> ملاحظة: لما ترجّع النسخة القديمة، لازم تضيف `degraded?: boolean` و
> `'unavailable'` للـ interface في `aml.ts` عشان `index.ts` الجديد يترجم.
> ده تغيير في الأنواع بس — المنطق بيفضل مفتوح.

---

## التحقق على staging حقيقي

السكربت فوق بيثبت المنطق بدون أي شبكة. للتحقق النهائي على **staging فعلي**
(قاعدة بيانات حقيقية + شبكة Nile)، اعمل الخطوات دي يدويًا:

### 1. جهّز البيئة

```bash
export SUPABASE_URL="https://<staging-project>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<staging-service-role>"
export TRON_FULL_HOST="https://nile.trongrid.io"
export USDT_CONTRACT_ADDRESS="<USDT على Nile>"
export HOT_WALLET_PRIVATE_KEY="<مفتاح محفظة اختبار — مش محفظة إنتاج>"
export AML_ALLOW_DEGRADED_MODE="false"
```

### 2. S1 — عطل شبكة

```bash
SUPABASE_URL="https://nonexistent.invalid" npm start
```

**المتوقع في اللوج:** `[AML UNAVAILABLE] ... class=transient`
**في قاعدة البيانات:** الطلب `review`، `last_error` يبدأ بـ `AML_UNAVAILABLE:`،
`transactions.tx_hash` = NULL.

### 3. S2 — جدول ناقص

```sql
DROP TABLE public.aml_blocked_addresses;
```

**المتوقع:** `class=table_missing` + رفض — **إلا** لو `AML_ALLOW_DEGRADED_MODE=true`.

### 4. S4 — عنوان محظور

```sql
INSERT INTO public.aml_blocked_addresses (address, network, reason, risk_level)
VALUES ('<عنوان تجريبي>', 'TRC20', 'staging test block', 'blocked');
```

**المتوقع:** `WITHDRAWAL_AML_BLOCKED` (مش `UNAVAILABLE`) والطلب يفضل `review`.

### 5. تحقق نهائي في كل الحالات

```sql
SELECT wr.id, wr.state, wr.last_error, t.tx_hash
FROM public.withdrawal_requests wr
JOIN public.transactions t ON t.id = wr.transaction_id
WHERE wr.id = '<request-id>';
```

**المطلوب:** `state = 'review'` و `tx_hash IS NULL`.

```sql
SELECT event_type, severity, details
FROM public.audit_logs
WHERE event_type LIKE 'WITHDRAWAL_AML%'
ORDER BY created_at DESC LIMIT 10;
```

---

## ملاحظات على التطبيق

- الإصلاح **مستقل** عن migration 004 — مفيش تغيير في قاعدة البيانات.
- بس migration 004 **لازم** تكون متطبّقة في الإنتاج، وإلا النظام هيرفض كل
  السحوبات (وده السلوك الصحيح). لو مش قادر تطبّقها فورًا، فعّل
  `AML_ALLOW_DEGRADED_MODE=true` مؤقتًا — بس ده بيرجعك للوضع القديم في نقطة
  واحدة (غياب الجدول بس، مش الأعطال).
- **متستخدمش** `AML_ALLOW_DEGRADED_MODE=true` في الإنتاج بأموال حقيقية.
