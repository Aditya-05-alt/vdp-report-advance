-- Single-dealer raw source/medium: read daily cache (not live page_data).
-- Live smart_ga4_page_data scans hit statement_timeout on large dealers.
CREATE OR REPLACE FUNCTION public.get_raw_source_medium_traffic_advance(
  p_client_id text,
  p_from date,
  p_to date
)
RETURNS TABLE(
  raw_source text,
  raw_medium text,
  raw_channel text,
  page_views bigint,
  vdp_views bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '30s'
AS $function$
  SELECT
    lower(trim(c.raw_source)) AS raw_source,
    lower(trim(c.raw_medium)) AS raw_medium,
    MAX(c.raw_channel) AS raw_channel,
    SUM(c.page_views)::bigint AS page_views,
    SUM(c.vdp_views)::bigint AS vdp_views
  FROM public.smart_ga4_src_med_daily_advance c
  WHERE c.client_id = trim(p_client_id)
    AND c.report_date BETWEEN p_from AND p_to
  GROUP BY lower(trim(c.raw_source)), lower(trim(c.raw_medium))
  HAVING SUM(c.page_views) > 0
  ORDER BY page_views DESC, raw_source, raw_medium;
$function$;

GRANT EXECUTE ON FUNCTION public.get_raw_source_medium_traffic_advance(text, date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_raw_source_medium_traffic_advance(text, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_raw_source_medium_traffic_advance(text, date, date) TO anon;
