-- Top vehicles by VDP views from smart_final_data (advance overview panel).
-- Deploy in Supabase SQL editor.

DROP FUNCTION IF EXISTS public.get_top_vdp_vehicles_advance(text, date, date);
DROP FUNCTION IF EXISTS public.get_top_vdp_vehicles_advance(text, date, date, int);

CREATE OR REPLACE FUNCTION public.get_top_vdp_vehicles_advance(
  p_client_id text,
  p_from date,
  p_to date,
  p_limit int DEFAULT 5
)
RETURNS TABLE (
  inv_year text,
  inv_make text,
  inv_model text,
  inv_condition text,
  inv_stock_number text,
  views bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      COALESCE(NULLIF(TRIM(f.inv_year), ''), '—') AS inv_year,
      COALESCE(NULLIF(TRIM(f.inv_make), ''), 'Unknown') AS inv_make,
      COALESCE(NULLIF(TRIM(f.inv_model), ''), 'Unknown') AS inv_model,
      COALESCE(NULLIF(TRIM(f.inv_condition), ''), 'Unknown') AS inv_condition,
      NULLIF(TRIM(f.inv_stock_number), '') AS inv_stock_number,
      COALESCE(f.views, 0)::bigint AS views
    FROM public.smart_final_data f
    WHERE f.client_id::text = trim(p_client_id)
      AND f.report_date BETWEEN p_from AND p_to
      AND (
        f.ga4_page_type ILIKE 'VDP%'
        OR f.vdp_conditions IS TRUE
      )
      AND COALESCE(f.views, 0) > 0
  ),
  agg AS (
    SELECT
      b.inv_year,
      b.inv_make,
      b.inv_model,
      b.inv_condition,
      MAX(b.inv_stock_number) AS inv_stock_number,
      SUM(b.views)::bigint AS views
    FROM base b
    GROUP BY b.inv_year, b.inv_make, b.inv_model, b.inv_condition
  )
  SELECT
    a.inv_year,
    a.inv_make,
    a.inv_model,
    a.inv_condition,
    a.inv_stock_number,
    a.views
  FROM agg a
  ORDER BY a.views DESC, a.inv_make, a.inv_model
  LIMIT GREATEST(COALESCE(p_limit, 5), 1);
$$;

REVOKE ALL ON FUNCTION public.get_top_vdp_vehicles_advance(text, date, date, int)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_top_vdp_vehicles_advance(text, date, date, int)
  TO anon, authenticated, service_role;
