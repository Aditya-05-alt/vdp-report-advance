-- All-dealers source/medium matrix (chunked). Used by All Dealers when Source Mapping is active.
-- Prefer this over GA4 channel MVs so totals match Overview (smart_ga4_page_data).
-- Also defined in supabase/migrations/source_mapping.sql — deploy either copy.

DROP FUNCTION IF EXISTS public.get_all_dealers_source_medium_matrix_advance(date, date, text, text[]);

CREATE OR REPLACE FUNCTION public.get_all_dealers_source_medium_matrix_advance(
  p_from       date,
  p_to         date,
  p_page_type  text DEFAULT 'ALL',
  p_client_ids text[] DEFAULT NULL
)
RETURNS TABLE (
  client_id   text,
  dealer_name text,
  raw_source  text,
  raw_medium  text,
  views       bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '55s'
AS $$
DECLARE
  v_page_type text := UPPER(COALESCE(p_page_type, 'ALL'));
  v_chunked   boolean := COALESCE(array_length(p_client_ids, 1), 0) > 0;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'Invalid date range: % .. %', p_from, p_to;
  END IF;

  RETURN QUERY
  WITH dealers AS (
    SELECT DISTINCT ON (h.ga4_customer_id)
      h.ga4_customer_id::text AS dealer_client_id,
      h.customer_name         AS dealer_label
    FROM public.smart_hoot_config h
    WHERE h.is_active IS TRUE
      AND h.ga4_customer_id IS NOT NULL
      AND h.ga4_customer_id::text <> ''
      AND (
        NOT v_chunked
        OR h.ga4_customer_id::text = ANY (p_client_ids)
      )
    ORDER BY h.ga4_customer_id, h.id DESC
  ),
  agg AS (
    SELECT
      p.client_id::text AS dealer_client_id,
      COALESCE(NULLIF(TRIM(p.source), ''), '(direct)') AS raw_source,
      COALESCE(NULLIF(TRIM(p.medium), ''), '(none)') AS raw_medium,
      SUM(COALESCE(p.views, 0))::bigint AS page_views
    FROM public.smart_ga4_page_data p
    WHERE p.report_date BETWEEN p_from AND p_to
      AND COALESCE(p.views, 0) > 0
      AND (
        NOT v_chunked
        OR p.client_id::text = ANY (p_client_ids)
      )
      AND (
        v_page_type = 'ALL'
        OR (v_page_type = 'VDP' AND p.ga4_page_type ILIKE 'VDP%')
        OR (v_page_type = 'SRP' AND p.ga4_page_type = 'SRP')
        OR (v_page_type IN ('HOME', 'HOMEPAGE') AND p.ga4_page_type ILIKE 'home%')
        OR (
          v_page_type = 'OTHER'
          AND p.ga4_page_type NOT ILIKE 'VDP%'
          AND p.ga4_page_type <> 'SRP'
          AND p.ga4_page_type NOT ILIKE 'home%'
        )
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
END;
$$;

REVOKE ALL ON FUNCTION public.get_all_dealers_source_medium_matrix_advance(date, date, text, text[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_all_dealers_source_medium_matrix_advance(date, date, text, text[])
  TO anon, authenticated, service_role;
