-- Lightweight New / Used / Unknown totals for All Dealers KPI.
-- Uses smart_final_data (same source as Overview condition breakdown).
-- Optional p_channel uses the GA4 page join only when a channel filter is set.
--
-- Deploy in Supabase SQL editor (does not replace the channel matrix RPC).

DROP FUNCTION IF EXISTS public.get_all_dealers_condition_totals_advance(date, date);
DROP FUNCTION IF EXISTS public.get_all_dealers_condition_totals_advance(date, date, text[]);
DROP FUNCTION IF EXISTS public.get_all_dealers_condition_totals_advance(date, date, text[], text);

CREATE OR REPLACE FUNCTION public.get_all_dealers_condition_totals_advance(
  p_from       date,
  p_to         date,
  p_client_ids text[] DEFAULT NULL,
  p_channel    text DEFAULT NULL
)
RETURNS TABLE (
  client_id         text,
  condition_bucket  text,
  views             bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '45s'
AS $$
DECLARE
  v_chunked boolean := COALESCE(array_length(p_client_ids, 1), 0) > 0;
  v_channel text := NULLIF(TRIM(p_channel), '');
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'Invalid date range: % .. %', p_from, p_to;
  END IF;

  -- Fast path: no channel filter → aggregate inventory views only (no GA4 join).
  IF v_channel IS NULL OR UPPER(v_channel) IN ('ALL', 'ALL CHANNELS') THEN
    RETURN QUERY
    WITH base AS (
      SELECT
        f.client_id::text AS dealer_client_id,
        CASE
          WHEN UPPER(TRIM(COALESCE(f.inv_condition, ''))) LIKE 'NEW%' THEN 'New'
          WHEN UPPER(TRIM(COALESCE(f.inv_condition, ''))) LIKE 'USED%' THEN 'Used'
          ELSE 'Unknown'
        END AS bucket,
        COALESCE(f.views, 0)::bigint AS row_views
      FROM public.smart_final_data f
      WHERE f.report_date BETWEEN p_from AND p_to
        AND (
          NOT v_chunked
          OR f.client_id::text = ANY (p_client_ids)
        )
        AND (f.ga4_page_type ILIKE 'VDP%' OR f.vdp_conditions IS TRUE)
    )
    SELECT
      b.dealer_client_id,
      b.bucket,
      SUM(b.row_views)::bigint
    FROM base b
    GROUP BY b.dealer_client_id, b.bucket
    HAVING SUM(b.row_views) > 0
    ORDER BY b.dealer_client_id, b.bucket;
    RETURN;
  END IF;

  -- Channel filter: attribute VDP page views via GA4 join, then bucket by condition.
  RETURN QUERY
  WITH final_rows AS (
    SELECT
      f.client_id::text AS dealer_client_id,
      f.report_date,
      TRIM(f.page_path) AS page_path,
      CASE
        WHEN UPPER(TRIM(COALESCE(f.inv_condition, ''))) LIKE 'NEW%' THEN 'New'
        WHEN UPPER(TRIM(COALESCE(f.inv_condition, ''))) LIKE 'USED%' THEN 'Used'
        ELSE 'Unknown'
      END AS bucket
    FROM public.smart_final_data f
    WHERE f.report_date BETWEEN p_from AND p_to
      AND (
        NOT v_chunked
        OR f.client_id::text = ANY (p_client_ids)
      )
      AND (f.ga4_page_type ILIKE 'VDP%' OR f.vdp_conditions IS TRUE)
  ),
  matched AS (
    SELECT
      fr.dealer_client_id,
      fr.bucket,
      CASE lower(trim(COALESCE(p.channel, '')))
        WHEN 'organic_search'  THEN 'Organic Search'
        WHEN 'paid_search'     THEN 'Paid Search'
        WHEN 'direct'          THEN 'Direct'
        WHEN 'organic_social'  THEN 'Organic Social'
        WHEN 'paid_social'     THEN 'Paid Social'
        WHEN 'paid_video'      THEN 'Paid Video'
        WHEN 'organic_video'   THEN 'Organic Video'
        WHEN 'display'         THEN 'Display'
        WHEN 'email'           THEN 'Email'
        WHEN 'referral'        THEN 'Referral'
        WHEN 'affiliates'      THEN 'Affiliates'
        WHEN 'paid_other'      THEN 'Paid Other'
        WHEN 'sms'             THEN 'SMS'
        WHEN 'audio'           THEN 'Audio'
        WHEN 'cross-network'   THEN 'Cross-network'
        WHEN 'unassigned'      THEN 'Unassigned'
        WHEN ''                THEN '(not set)'
        ELSE initcap(replace(replace(lower(trim(p.channel)), '_', ' '), '-', ' '))
      END AS norm_channel,
      SUM(COALESCE(p.views, 0))::bigint AS page_views
    FROM final_rows fr
    INNER JOIN public.smart_ga4_page_data p
      ON p.client_id::text = fr.dealer_client_id
     AND p.report_date = fr.report_date
     AND TRIM(p.page_path) = fr.page_path
     AND p.ga4_page_type ILIKE 'VDP%'
    GROUP BY fr.dealer_client_id, fr.bucket, p.channel
  )
  SELECT
    m.dealer_client_id,
    m.bucket,
    SUM(m.page_views)::bigint
  FROM matched m
  WHERE m.norm_channel = v_channel
  GROUP BY m.dealer_client_id, m.bucket
  HAVING SUM(m.page_views) > 0
  ORDER BY m.dealer_client_id, m.bucket;
END;
$$;

REVOKE ALL ON FUNCTION public.get_all_dealers_condition_totals_advance(date, date, text[], text)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_all_dealers_condition_totals_advance(date, date, text[], text)
  TO anon, authenticated, service_role;
