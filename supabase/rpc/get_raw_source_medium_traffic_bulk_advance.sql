-- All Dealers raw source/medium: case-insensitive unique pairs from daily cache.
CREATE OR REPLACE FUNCTION public.get_raw_source_medium_traffic_bulk_advance(
  p_from date,
  p_to date,
  p_client_ids text[] DEFAULT NULL::text[]
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
SET statement_timeout TO '55s'
AS $function$
  SELECT
    lower(trim(c.raw_source)) AS raw_source,
    lower(trim(c.raw_medium)) AS raw_medium,
    MAX(c.raw_channel) AS raw_channel,
    SUM(c.page_views)::bigint AS page_views,
    SUM(c.vdp_views)::bigint AS vdp_views
  FROM public.smart_ga4_src_med_daily_advance c
  WHERE c.report_date BETWEEN p_from AND p_to
    AND (
      p_client_ids IS NULL
      OR COALESCE(array_length(p_client_ids, 1), 0) = 0
      OR c.client_id = ANY (p_client_ids)
    )
  GROUP BY lower(trim(c.raw_source)), lower(trim(c.raw_medium))
  HAVING SUM(c.page_views) > 0
  ORDER BY page_views DESC, raw_source, raw_medium;
$function$;

GRANT EXECUTE ON FUNCTION public.get_raw_source_medium_traffic_bulk_advance(date, date, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_raw_source_medium_traffic_bulk_advance(date, date, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_raw_source_medium_traffic_bulk_advance(date, date, text[]) TO anon;
