-- Traffic by Source (advance): page views + VDP views per channel for one dealer.
-- Channels stay separate (no Paid Search + Display rollup).
-- Deploy in Supabase SQL editor.

DROP FUNCTION IF EXISTS public.get_traffic_by_source_advance(text, date, date);

CREATE OR REPLACE FUNCTION public.get_traffic_by_source_advance(
  p_client_id text,
  p_from      date,
  p_to        date
)
RETURNS TABLE (
  channel_bucket text,
  page_views     bigint,
  vdp_views      bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
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
      END AS channel_bucket,
      COALESCE(p.views, 0)::bigint AS views,
      CASE
        WHEN p.ga4_page_type ILIKE 'VDP%' THEN COALESCE(p.views, 0)::bigint
        ELSE 0::bigint
      END AS vdp_part
    FROM public.smart_ga4_page_data p
    WHERE p.client_id::text = trim(p_client_id)
      AND p.report_date BETWEEN p_from AND p_to
      AND COALESCE(p.views, 0) > 0
  ),
  agg AS (
    SELECT
      b.channel_bucket,
      SUM(b.views)::bigint AS page_views,
      SUM(b.vdp_part)::bigint AS vdp_views
    FROM base b
    GROUP BY b.channel_bucket
  )
  SELECT
    a.channel_bucket,
    a.page_views,
    a.vdp_views
  FROM agg a
  WHERE a.page_views > 0 OR a.vdp_views > 0
  ORDER BY a.page_views DESC, a.channel_bucket;
$$;

REVOKE ALL ON FUNCTION public.get_traffic_by_source_advance(text, date, date)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_traffic_by_source_advance(text, date, date)
  TO anon, authenticated, service_role;
