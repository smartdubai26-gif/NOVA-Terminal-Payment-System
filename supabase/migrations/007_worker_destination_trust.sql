-- ============================================================================
-- Migration 007: Worker Destination Trust & TOCTOU Protection (W-01)
-- NOVA Terminal Payment System (NTPS)
--
-- الغرض:
--   إغلاق ثغرة W-01 على مستوى قاعدة البيانات، بحيث تبقى الحماية قائمة حتى لو
--   الـ worker اتعطّل أو اتشغّل نسخة قديمة منه.
--
--   المشكلة اللي بيحلها:
--     جدول `whitelist_addresses` فيه عمود `verified` لكن قيمته الافتراضية `true`،
--     وسياسات RLS بتسمح للمالك يضيف/يعدّل عناوين تبع ترمينالاته بنفسه. يعني
--     "القائمة البيضاء" مش بيضاء فعليًا: أي مالك ترمينال يقدر يضيف عنوان
--     يخصّه ويوافق عليه، والـ worker (قبل الإصلاح) كان بيبعت لأي عنوان في
--     الجدول من غير ما يقرأ `verified` أصلًا.
--
--     وكمان: مفيش أي شيء بيمنع تغيير العنوان **بعد** موافقة الأدمن على السحب
--     وقبل البث الفعلي (TOCTOU — time-of-check to time-of-use). الأدمن يوافق
--     على عنوان، وبعدين المالك يغيّر العنوان لنفسه، والـ worker يبعت للعنوان
--     الجديد.
--
--   الإصلاح:
--     1. عمود `destination_snapshot` على `withdrawal_requests` — بيتسجّل
--        وقت الموافقة، والـ worker بيقارنه بالعنوان الحالي قبل البث.
--     2. إعادة تعريف `review_withdrawal_request` عشان تلتقط الـ snapshot
--        في نفس اللحظة اللي بتوافق فيها (ذرّيًا، تحت نفس القفل).
--     3. Trigger بيمنع تعديل/حذف أي عنوان في `whitelist_addresses` طالما
--        فيه طلب سحب معلّق (review/approved/broadcast) بيشاور عليه.
--     4. Trigger بيمنع إدخال عنوان جديد بـ `verified = true` من غير مسار
--        مراجعة — أي إضافة من العميل بتبقى `verified = false` افتراضيًا.
--     5. Backfill للطلبات الموجودة.
--
--   الترتيب: يتطبّق بعد 001 → 006.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. فحص المتطلبات المسبقة — نفشل بوضوح بدل ما نطبّق نص إصلاح
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.withdrawal_requests') IS NULL THEN
    RAISE EXCEPTION 'Migration 007 requires public.withdrawal_requests (apply schema.sql first)';
  END IF;

  IF to_regclass('public.whitelist_addresses') IS NULL THEN
    RAISE EXCEPTION 'Migration 007 requires public.whitelist_addresses (apply schema.sql first)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'withdrawal_requests'
      AND column_name = 'whitelist_address_id'
  ) THEN
    RAISE EXCEPTION 'Migration 007 requires withdrawal_requests.whitelist_address_id';
  END IF;

  IF to_regprocedure('public.is_ntps_admin(text[])') IS NULL THEN
    RAISE EXCEPTION 'Migration 007 requires public.is_ntps_admin (apply migration 005 first)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. عمود الـ snapshot
-- ----------------------------------------------------------------------------
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS destination_snapshot TEXT;

COMMENT ON COLUMN public.withdrawal_requests.destination_snapshot IS
  'W-01: عنوان المحفظة المستهدف كما كان وقت موافقة الأدمن. الـ worker بيقارنه بالعنوان الحالي قبل البث ويرفض لو اتغيّر (TOCTOU).';

-- ----------------------------------------------------------------------------
-- 2. Backfill: الطلبات المعلّقة الموجودة بتاخد snapshot من العنوان الحالي
--    (أفضل ما يمكن عمله — مفيش سجل تاريخي للعنوان وقت الموافقة)
-- ----------------------------------------------------------------------------
UPDATE public.withdrawal_requests wr
SET destination_snapshot = wl.address
FROM public.whitelist_addresses wl
WHERE wr.whitelist_address_id = wl.id
  AND wr.destination_snapshot IS NULL
  AND wr.state IN ('review', 'approved', 'broadcast');

-- ----------------------------------------------------------------------------
-- 3. إعادة تعريف review_withdrawal_request لالتقاط الـ snapshot عند الموافقة
--    (نفس التوقيع والمنطق الأصلي + سطر الـ snapshot)
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.review_withdrawal_request(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.review_withdrawal_request(
  p_transaction_id UUID,
  p_action TEXT,
  p_reason TEXT
) RETURNS VOID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_admin_role TEXT;
  v_clean_reason TEXT := trim(COALESCE(p_reason, ''));
  v_tx public.transactions%ROWTYPE;
  v_req public.withdrawal_requests%ROWTYPE;
  v_wl public.whitelist_addresses%ROWTYPE;
  v_rev_journal_id UUID;
  v_posting RECORD;
  v_wallet_id UUID;
  v_prev_hash TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_ntps_admin(ARRAY['ops', 'compliance', 'super_admin']) THEN
    RAISE EXCEPTION 'Forbidden: active ops, compliance, or super_admin role required in app_admins'
      USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_admin_role
  FROM public.app_admins
  WHERE user_id = v_uid AND is_active = TRUE;

  IF v_clean_reason = '' THEN
    RAISE EXCEPTION 'Mandatory compliance review reason is required';
  END IF;

  IF p_action NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'Invalid review action: %', p_action;
  END IF;

  SELECT tx.* INTO v_tx
  FROM public.transactions tx
  WHERE tx.id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Withdrawal transaction not found';
  END IF;

  SELECT * INTO v_req
  FROM public.withdrawal_requests
  WHERE transaction_id = v_tx.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Associated withdrawal_requests row not found';
  END IF;

  IF p_action = 'approve' THEN
    IF v_req.state <> 'review' THEN
      RAISE EXCEPTION 'Withdrawal request is already in state %', v_req.state;
    END IF;

    -- W-01: نقرأ العنوان الحالي ونقفل صفّه، ونتأكد إنه موثّق صريحًا
    SELECT * INTO v_wl
    FROM public.whitelist_addresses
    WHERE id = v_req.whitelist_address_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Whitelist destination for this withdrawal no longer exists';
    END IF;

    IF v_wl.verified IS NOT TRUE THEN
      RAISE EXCEPTION
        'Destination % is not verified; an admin must verify it before approval',
        v_wl.address
        USING ERRCODE = '42501';
    END IF;

    -- W-01: تثبيت العنوان وقت الموافقة — أي تغيير بعده يوقف البث
    UPDATE public.withdrawal_requests
    SET state = 'approved',
        destination_snapshot = v_wl.address
    WHERE id = v_req.id;
  ELSE
    IF v_req.state NOT IN ('review', 'approved') THEN
      RAISE EXCEPTION 'Cannot reject withdrawal in state %', v_req.state;
    END IF;

    UPDATE public.withdrawal_requests
    SET state = 'rejected'
    WHERE id = v_req.id;

    UPDATE public.transactions
    SET status = 'reversed'
    WHERE id = v_tx.id;

    IF v_tx.journal_id IS NOT NULL THEN
      INSERT INTO public.journal_entries (kind, idempotency_key, memo, created_by)
      VALUES ('withdrawal_reversal', 'rev_' || v_tx.id::TEXT, 'Compliance reversal of ' || v_tx.reference || ' (' || v_clean_reason || ')', v_uid)
      RETURNING id INTO v_rev_journal_id;

      FOR v_posting IN
        SELECT * FROM public.ledger_postings WHERE journal_id = v_tx.journal_id
      LOOP
        INSERT INTO public.ledger_postings (journal_id, account_ref, asset, amount)
        VALUES (v_rev_journal_id, v_posting.account_ref, v_posting.asset, -v_posting.amount);

        IF v_posting.account_ref LIKE 'wallet:%' AND v_posting.amount < 0 THEN
          v_wallet_id := substring(v_posting.account_ref FROM 8)::UUID;
          UPDATE public.wallets
          SET available = available + ABS(v_posting.amount),
              version = version + 1,
              updated_at = now()
          WHERE id = v_wallet_id;
        END IF;
      END LOOP;
    END IF;
  END IF;

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
  VALUES (
    'WITHDRAWAL_REVIEW_' || upper(p_action),
    v_uid::TEXT,
    v_tx.terminal_id::TEXT,
    'Transaction ' || v_tx.reference || ' was ' || p_action || 'd by ' || COALESCE(v_admin_role, 'admin') || '. Reason: ' || v_clean_reason,
    CASE WHEN p_action = 'approve' THEN 'info' ELSE 'warn' END,
    v_prev_hash,
    '0x' || encode(digest(v_prev_hash || v_tx.id::TEXT || p_action || v_clean_reason || now()::TEXT, 'sha256'), 'hex')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.review_withdrawal_request(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_withdrawal_request(UUID, TEXT, TEXT) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. Trigger: منع تعديل/حذف عنوان عليه طلب سحب معلّق (TOCTOU)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_whitelist_address_mutation()
RETURNS TRIGGER AS $$
DECLARE
  v_pending_count INTEGER;
BEGIN
  -- الحذف دائمًا ممنوع لو فيه طلب معلّق
  IF TG_OP = 'DELETE' THEN
    SELECT COUNT(*) INTO v_pending_count
    FROM public.withdrawal_requests
    WHERE whitelist_address_id = OLD.id
      AND state IN ('review', 'approved', 'broadcast');

    IF v_pending_count > 0 THEN
      RAISE EXCEPTION
        'Cannot delete whitelist address %: % pending withdrawal request(s) reference it',
        OLD.id, v_pending_count
        USING ERRCODE = '42501';
    END IF;

    RETURN OLD;
  END IF;

  -- التعديل: ممنوع تغيير العنوان أو الشبكة أو الأصل لو فيه طلب معلّق
  IF NEW.address IS DISTINCT FROM OLD.address
     OR NEW.network IS DISTINCT FROM OLD.network
     OR NEW.asset IS DISTINCT FROM OLD.asset THEN

    SELECT COUNT(*) INTO v_pending_count
    FROM public.withdrawal_requests
    WHERE whitelist_address_id = OLD.id
      AND state IN ('review', 'approved', 'broadcast');

    IF v_pending_count > 0 THEN
      RAISE EXCEPTION
        'Cannot change destination of whitelist address %: % pending withdrawal request(s) reference it. Reject or complete them first.',
        OLD.id, v_pending_count
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_guard_whitelist_address_mutation ON public.whitelist_addresses;
CREATE TRIGGER trg_guard_whitelist_address_mutation
  BEFORE UPDATE OR DELETE ON public.whitelist_addresses
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_whitelist_address_mutation();

-- ----------------------------------------------------------------------------
-- 5. Trigger: أي إضافة من العميل بتبقى غير موثّقة افتراضيًا
--    (العمود `verified` افتراضيًا `true` في الـ schema — ده اللي بيفتح الثغرة)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.force_unverified_on_client_insert()
RETURNS TRIGGER AS $$
BEGIN
  -- service_role (الـ worker / مهام الإدارة) مسموح له يضبط verified صريحًا.
  -- أي دور تاني (authenticated / anon) إضافته بتبقى verified = false دايمًا.
  IF current_setting('role', true) IS DISTINCT FROM 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    NEW.verified := FALSE;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_force_unverified_on_client_insert ON public.whitelist_addresses;
CREATE TRIGGER trg_force_unverified_on_client_insert
  BEFORE INSERT ON public.whitelist_addresses
  FOR EACH ROW
  EXECUTE FUNCTION public.force_unverified_on_client_insert();

-- ----------------------------------------------------------------------------
-- 6. RPC إداري لتوثيق عنوان (المسار الوحيد لتحويل verified إلى true)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_whitelist_address_admin(
  p_whitelist_address_id UUID,
  p_reason TEXT
) RETURNS VOID AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_admin_role TEXT;
  v_clean_reason TEXT := trim(COALESCE(p_reason, ''));
  v_wl public.whitelist_addresses%ROWTYPE;
  v_prev_hash TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_ntps_admin(ARRAY['ops', 'compliance', 'super_admin']) THEN
    RAISE EXCEPTION 'Forbidden: active ops, compliance, or super_admin role required in app_admins'
      USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_admin_role
  FROM public.app_admins
  WHERE user_id = v_uid AND is_active = TRUE;

  IF v_clean_reason = '' THEN
    RAISE EXCEPTION 'Mandatory verification reason is required';
  END IF;

  SELECT * INTO v_wl
  FROM public.whitelist_addresses
  WHERE id = p_whitelist_address_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Whitelist address not found';
  END IF;

  IF v_wl.verified IS TRUE THEN
    RETURN; -- already verified, idempotent
  END IF;

  UPDATE public.whitelist_addresses
  SET verified = TRUE
  WHERE id = v_wl.id;

  SELECT COALESCE(
    (SELECT row_hash FROM public.audit_logs ORDER BY created_at DESC LIMIT 1),
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  ) INTO v_prev_hash;

  INSERT INTO public.audit_logs (event_type, actor, terminal_id, details, severity, prev_hash, row_hash)
  VALUES (
    'WHITELIST_ADDRESS_VERIFIED',
    v_uid::TEXT,
    v_wl.terminal_id::TEXT,
    'Destination ' || v_wl.address || ' (' || v_wl.asset || '/' || v_wl.network || ') verified by ' || COALESCE(v_admin_role, 'admin') || '. Reason: ' || v_clean_reason,
    'info',
    v_prev_hash,
    '0x' || encode(digest(v_prev_hash || v_wl.id::TEXT || v_wl.address || now()::TEXT, 'sha256'), 'hex')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.verify_whitelist_address_admin(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_whitelist_address_admin(UUID, TEXT) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. فهرس مساعد لاستعلامات الـ worker
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_state_broadcast_at
  ON public.withdrawal_requests(state, broadcast_at)
  WHERE state = 'broadcast';

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_whitelist_pending
  ON public.withdrawal_requests(whitelist_address_id)
  WHERE state IN ('review', 'approved', 'broadcast');

COMMIT;

-- ============================================================================
-- التحقق بعد التنفيذ
-- ============================================================================

-- 7.1 العمود موجود
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='withdrawal_requests'
--   AND column_name='destination_snapshot';
-- المتوقع: صف واحد، data_type = text

-- 7.2 الـ triggers موجودة
-- SELECT tgname FROM pg_trigger
-- WHERE tgrelid = 'public.whitelist_addresses'::regclass AND NOT tgisinternal;
-- المتوقع: trg_guard_whitelist_address_mutation, trg_force_unverified_on_client_insert

-- 7.3 الدوال الجديدة موجودة
-- SELECT proname FROM pg_proc
-- WHERE pronamespace = 'public'::regnamespace
--   AND proname IN ('verify_whitelist_address_admin','guard_whitelist_address_mutation','force_unverified_on_client_insert');
-- المتوقع: 3 صفوف

-- 7.4 مفيش طلب معلّق من غير snapshot
-- SELECT COUNT(*) FROM public.withdrawal_requests
-- WHERE state IN ('review','approved','broadcast') AND destination_snapshot IS NULL;
-- المتوقع: 0

-- 7.5 كل الطلبات المعتمدة بتشاور على عنوان موثّق
-- SELECT COUNT(*) FROM public.withdrawal_requests wr
-- JOIN public.whitelist_addresses wl ON wl.id = wr.whitelist_address_id
-- WHERE wr.state IN ('approved','broadcast') AND wl.verified IS NOT TRUE;
-- المتوقع: 0 (لو فيه صفوف، لازم تراجع يدوي قبل تشغيل الـ worker)

-- ============================================================================
-- اختبار وظيفي (نفّذه على staging فقط)
-- ============================================================================

-- T1: إضافة عنوان من العميل بتبقى غير موثّقة
--   (بصلاحية authenticated) INSERT ... ; ثم SELECT verified → false

-- T2: الموافقة على سحب لعنوان غير موثّق بترفض
--   SELECT public.review_withdrawal_request('<tx_id>', 'approve', 'test');
--   المتوقع: ERROR 42501 'Destination ... is not verified'

-- T3: التوثيق الإداري بيشتغل
--   SELECT public.verify_whitelist_address_admin('<wl_id>', 'KYC verified');
--   ثم SELECT verified → true

-- T4: الموافقة بعد التوثيق بتسجّل snapshot
--   SELECT public.review_withdrawal_request('<tx_id>', 'approve', 'ok');
--   SELECT destination_snapshot FROM withdrawal_requests WHERE id='<req_id>';
--   المتوقع: نفس عنوان الـ whitelist

-- T5: تغيير العنوان بعد الموافقة ممنوع
--   UPDATE public.whitelist_addresses SET address='<other>' WHERE id='<wl_id>';
--   المتوقع: ERROR 42501 'Cannot change destination ... pending withdrawal request(s)'

-- T6: الـ worker بيرفض لو الـ snapshot مختلف (اختبار على مستوى الكود)
--   UPDATE withdrawal_requests SET destination_snapshot='<different>' WHERE id='<req_id>';
--   ثم شغّل دورة worker → المتوقع: WITHDRAWAL_DESTINATION_UNTRUSTED في audit_logs
--   والطلب يرجع لـ state='review'
