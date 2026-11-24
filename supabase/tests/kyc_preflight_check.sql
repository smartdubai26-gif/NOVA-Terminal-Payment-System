-- ============================================================================
-- NTPS Pre-Flight Diagnostic Script for Migrations 011 & 012
-- Run read-only in Supabase SQL Editor prior to applying 011 and 012 on
-- staging/production databases that already contain `public.kyc_submissions`.
-- ============================================================================

-- 1. [NEW-B] Inspect any existing individual KYC rows missing DOB or under age 18
SELECT
  id,
  user_id,
  account_type,
  date_of_birth,
  status,
  updated_at
FROM public.kyc_submissions
WHERE COALESCE(lower(trim(account_type)), 'individual') <> 'corporate'
  AND (
    date_of_birth IS NULL
    OR date_of_birth > (CURRENT_DATE - INTERVAL '18 years')::date
  );

-- 2. [NEW-A] Inspect any existing approved rows sharing the same normalized id_number
SELECT
  upper(trim(id_number)) AS normalized_id_number,
  array_agg(id) AS submission_ids,
  array_agg(user_id) AS user_ids,
  array_agg(id_type) AS id_types,
  COUNT(*) AS approved_count
FROM public.kyc_submissions
WHERE status = 'approved'
  AND id_number IS NOT NULL
  AND btrim(id_number) <> ''
GROUP BY upper(trim(id_number))
HAVING COUNT(*) > 1;
