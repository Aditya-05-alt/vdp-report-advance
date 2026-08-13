-- Inventory Performance (advance): vehicle-level VDP rows from smart_final_data.
-- Groups by VIN when present, otherwise stock number (never blank vehicle key).
-- Display VIN = COALESCE(vin, stock_number). Supports make / condition / category / search.
-- Deploy in Supabase SQL editor.

DROP FUNCTION IF EXISTS public.get_inventory_performance_advance(text, date, date);
DROP FUNCTION IF EXISTS public.get_inventory_performance_advance(
  text, date, date, text, text, text, text
);

CREATE OR REPLACE FUNCTION public.get_inventory_performance_advance(
  p_client_id  text,
  p_from       date,
  p_to         date,
  p_make       text DEFAULT NULL,
  p_condition  text DEFAULT NULL,
  p_category   text DEFAULT NULL,
  p_search     text DEFAULT NULL
)
RETURNS TABLE (
  inv_vin          text,
  inv_stock_number text,
  inv_make         text,
  inv_model        text,
  inv_year         text,
  inv_condition    text,
  inv_category     text,
  views            bigint,
  unique_views     bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      NULLIF(TRIM(f.inv_vin), '') AS inv_vin,
      NULLIF(TRIM(f.inv_stock_number), '') AS inv_stock_number,
      COALESCE(
        NULLIF(TRIM(f.inv_vin), ''),
        NULLIF(TRIM(f.inv_stock_number), '')
      ) AS vehicle_key,
      COALESCE(NULLIF(TRIM(f.inv_make), ''), 'Unknown') AS inv_make,
      COALESCE(NULLIF(TRIM(f.inv_model), ''), 'Unknown') AS inv_model,
      COALESCE(NULLIF(TRIM(f.inv_year), ''), '—') AS inv_year,
      COALESCE(NULLIF(TRIM(f.inv_condition), ''), 'Unknown') AS inv_condition,
      COALESCE(
        NULLIF(TRIM(f.inv_custom_type), ''),
        NULLIF(TRIM(f.inv_type), ''),
        'Unknown'
      ) AS inv_category,
      COALESCE(f.views, 0)::bigint AS views,
      COALESCE(f.total_users, 0)::bigint AS unique_views
    FROM public.smart_final_data f
    WHERE f.client_id::text = trim(p_client_id)
      AND f.report_date BETWEEN p_from AND p_to
      AND (
        f.ga4_page_type ILIKE 'VDP%'
        OR f.vdp_conditions IS TRUE
      )
      AND (
        p_make IS NULL
        OR TRIM(p_make) = ''
        OR lower(TRIM(f.inv_make)) = lower(TRIM(p_make))
      )
      AND (
        p_condition IS NULL
        OR TRIM(p_condition) = ''
        OR upper(TRIM(p_condition)) IN ('ALL', 'BOTH')
        OR upper(TRIM(f.inv_condition)) = upper(TRIM(p_condition))
      )
      AND (
        p_category IS NULL
        OR TRIM(p_category) = ''
        OR lower(
          COALESCE(
            NULLIF(TRIM(f.inv_custom_type), ''),
            NULLIF(TRIM(f.inv_type), ''),
            'Unknown'
          )
        ) = lower(TRIM(p_category))
      )
      AND (
        p_search IS NULL
        OR TRIM(p_search) = ''
        OR COALESCE(f.inv_vin, '') ILIKE '%' || TRIM(p_search) || '%'
        OR COALESCE(f.inv_stock_number, '') ILIKE '%' || TRIM(p_search) || '%'
        OR COALESCE(f.inv_make, '') ILIKE '%' || TRIM(p_search) || '%'
        OR COALESCE(f.inv_model, '') ILIKE '%' || TRIM(p_search) || '%'
        OR COALESCE(f.inv_year, '') ILIKE '%' || TRIM(p_search) || '%'
      )
  ),
  agg AS (
    SELECT
      MAX(b.inv_vin) AS inv_vin,
      MAX(b.inv_stock_number) AS inv_stock_number,
      b.inv_make,
      b.inv_model,
      b.inv_year,
      b.inv_condition,
      b.inv_category,
      SUM(b.views)::bigint AS views,
      SUM(b.unique_views)::bigint AS unique_views
    FROM base b
    GROUP BY
      COALESCE(b.vehicle_key, ''),
      b.inv_make,
      b.inv_model,
      b.inv_year,
      b.inv_condition,
      b.inv_category
  )
  SELECT
    -- Never return empty VIN in the UI column: fall back to stock number
    COALESCE(a.inv_vin, a.inv_stock_number) AS inv_vin,
    a.inv_stock_number,
    a.inv_make,
    a.inv_model,
    a.inv_year,
    a.inv_condition,
    a.inv_category,
    a.views,
    a.unique_views
  FROM agg a
  WHERE a.views > 0 OR a.unique_views > 0
  ORDER BY a.views DESC, a.inv_make, a.inv_model;
$$;

REVOKE ALL ON FUNCTION public.get_inventory_performance_advance(
  text, date, date, text, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_inventory_performance_advance(
  text, date, date, text, text, text, text
) TO anon, authenticated, service_role;
