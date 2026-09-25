-- All Dealers source/medium matrix from daily cache (fast).
-- Used so Source Mapping can collapse raw pairs into short channel columns.
CREATE OR REPLACE FUNCTION public.get_all_dealers_src_med_cache_matrix_advance(
  p_from date,
  p_to date,
  p_page_type text DEFAULT 'ALL',
  p_client_ids text[] DEFAULT NULL
)
RETURNS TABLE (
  client_id text,
  dealer_name text,
  raw_source text,
  raw_medium text,
  views bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '30s'
AS $function$
  WITH dealers AS (
    SELECT DISTINCT ON (h.ga4_customer_id)
      h.ga4_customer_id::text AS dealer_client_id,
      h.customer_name AS dealer_label
    FROM public.smart_hoot_config h
    WHERE h.is_active IS TRUE
      AND h.ga4_customer_id IS NOT NULL
      AND h.ga4_customer_id::text <> ''
      AND (
        p_client_ids IS NULL
        OR COALESCE(array_length(p_client_ids, 1), 0) = 0
        OR h.ga4_customer_id::text = ANY (p_client_ids)
      )
    ORDER BY h.ga4_customer_id, h.id DESC
  ),
  agg AS (
    SELECT
      c.client_id::text AS dealer_client_id,
      lower(trim(c.raw_source)) AS raw_source,
      lower(trim(c.raw_medium)) AS raw_medium,
      SUM(
        CASE
          WHEN UPPER(COALESCE(p_page_type, 'ALL')) = 'VDP'
            THEN COALESCE(c.vdp_views, 0)
          ELSE COALESCE(c.page_views, 0)
        END
      )::bigint AS page_views
    FROM public.smart_ga4_src_med_daily_advance c
    WHERE c.report_date BETWEEN p_from AND p_to
      AND (
        p_client_ids IS NULL
        OR COALESCE(array_length(p_client_ids, 1), 0) = 0
        OR c.client_id = ANY (p_client_ids)
      )
    GROUP BY 1, 2, 3
  )
  SELECT
    a.dealer_client_id,
    d.dealer_label,
    a.raw_source,
    a.raw_medium,
    a.page_views
  FROM agg a
  INNER JOIN dealers d ON d.dealer_client_id = a.dealer_client_id
  WHERE a.page_views > 0
  ORDER BY d.dealer_label, a.page_views DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_all_dealers_src_med_cache_matrix_advance(date, date, text, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_all_dealers_src_med_cache_matrix_advance(date, date, text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_all_dealers_src_med_cache_matrix_advance(date, date, text, text[]) TO anon;
