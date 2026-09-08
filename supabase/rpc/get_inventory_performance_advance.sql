-- Inventory Performance (advance): vehicle-level VDP rows from smart_final_data
-- PLUS current inventory units with 0 views (hoot live, else scrap).
-- Groups by VIN when present, otherwise stock number (never blank vehicle key).
-- Display VIN = COALESCE(vin, stock_number). Supports make / condition / category / search.
-- Deploy in Supabase SQL editor (or apply_migration).

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
  WITH view_base AS (
    SELECT
      NULLIF(TRIM(f.inv_vin), '') AS inv_vin,
      NULLIF(TRIM(f.inv_stock_number), '') AS inv_stock_number,
      UPPER(
        COALESCE(
          NULLIF(TRIM(f.inv_vin), ''),
          NULLIF(TRIM(f.inv_stock_number), '')
        )
      ) AS vk,
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
      AND COALESCE(
        NULLIF(TRIM(f.inv_vin), ''),
        NULLIF(TRIM(f.inv_stock_number), '')
      ) IS NOT NULL
  ),
  view_agg AS (
    SELECT
      MAX(b.inv_vin) AS inv_vin,
      MAX(b.inv_stock_number) AS inv_stock_number,
      b.vk,
      MAX(b.inv_make) AS inv_make,
      MAX(b.inv_model) AS inv_model,
      MAX(b.inv_year) AS inv_year,
      MAX(b.inv_condition) AS inv_condition,
      MAX(b.inv_category) AS inv_category,
      SUM(b.views)::bigint AS views,
      SUM(b.unique_views)::bigint AS unique_views
    FROM view_base b
    GROUP BY b.vk
  ),
  inv_hoot AS (
    SELECT DISTINCT ON (vk)
      NULLIF(TRIM(i.vin), '') AS inv_vin,
      NULLIF(TRIM(i.stock_number), '') AS inv_stock_number,
      UPPER(
        COALESCE(
          NULLIF(TRIM(i.vin), ''),
          NULLIF(TRIM(i.stock_number), '')
        )
      ) AS vk,
      COALESCE(NULLIF(TRIM(i.make), ''), 'Unknown') AS inv_make,
      COALESCE(NULLIF(TRIM(i.model), ''), 'Unknown') AS inv_model,
      COALESCE(NULLIF(TRIM(i.year), ''), '—') AS inv_year,
      COALESCE(NULLIF(TRIM(i.condition), ''), 'Unknown') AS inv_condition,
      COALESCE(NULLIF(TRIM(i.type_), ''), 'Unknown') AS inv_category
    FROM public.smart_hoot_inventory_live i
    WHERE i.ga4_customer_id::text = trim(p_client_id)
      AND COALESCE(
        NULLIF(TRIM(i.vin), ''),
        NULLIF(TRIM(i.stock_number), '')
      ) IS NOT NULL
    ORDER BY
      UPPER(
        COALESCE(
          NULLIF(TRIM(i.vin), ''),
          NULLIF(TRIM(i.stock_number), '')
        )
      ),
      i.synced_at DESC NULLS LAST
  ),
  inv_scrap AS (
    SELECT DISTINCT ON (vk)
      NULLIF(TRIM(i.vin), '') AS inv_vin,
      NULLIF(TRIM(i.stock_number), '') AS inv_stock_number,
      UPPER(
        COALESCE(
          NULLIF(TRIM(i.vin), ''),
          NULLIF(TRIM(i.stock_number), '')
        )
      ) AS vk,
      COALESCE(NULLIF(TRIM(i.make), ''), 'Unknown') AS inv_make,
      COALESCE(NULLIF(TRIM(i.model), ''), 'Unknown') AS inv_model,
      COALESCE(NULLIF(TRIM(i.year), ''), '—') AS inv_year,
      COALESCE(NULLIF(TRIM(i.condition), ''), 'Unknown') AS inv_condition,
      COALESCE(NULLIF(TRIM(i.type_), ''), 'Unknown') AS inv_category
    FROM public.smart_scrap_inventory i
    WHERE i.customer_id::text = trim(p_client_id)
      AND COALESCE(
        NULLIF(TRIM(i.vin), ''),
        NULLIF(TRIM(i.stock_number), '')
      ) IS NOT NULL
    ORDER BY
      UPPER(
        COALESCE(
          NULLIF(TRIM(i.vin), ''),
          NULLIF(TRIM(i.stock_number), '')
        )
      ),
      i.updated_at DESC NULLS LAST,
      i.last_seen DESC NULLS LAST
  ),
  inventory AS (
    SELECT * FROM inv_hoot
    UNION ALL
    SELECT s.*
    FROM inv_scrap s
    WHERE NOT EXISTS (SELECT 1 FROM inv_hoot LIMIT 1)
  ),
  combined AS (
    SELECT
      COALESCE(i.inv_vin, v.inv_vin) AS inv_vin,
      COALESCE(i.inv_stock_number, v.inv_stock_number) AS inv_stock_number,
      COALESCE(i.inv_make, v.inv_make, 'Unknown') AS inv_make,
      COALESCE(i.inv_model, v.inv_model, 'Unknown') AS inv_model,
      COALESCE(i.inv_year, v.inv_year, '—') AS inv_year,
      COALESCE(i.inv_condition, v.inv_condition, 'Unknown') AS inv_condition,
      COALESCE(i.inv_category, v.inv_category, 'Unknown') AS inv_category,
      COALESCE(v.views, 0)::bigint AS views,
      COALESCE(v.unique_views, 0)::bigint AS unique_views
    FROM inventory i
    FULL OUTER JOIN view_agg v ON v.vk = i.vk
  )
  SELECT
    COALESCE(c.inv_vin, c.inv_stock_number) AS inv_vin,
    c.inv_stock_number,
    c.inv_make,
    c.inv_model,
    c.inv_year,
    c.inv_condition,
    c.inv_category,
    c.views,
    c.unique_views
  FROM combined c
  WHERE (
      p_make IS NULL
      OR TRIM(p_make) = ''
      OR lower(TRIM(c.inv_make)) = lower(TRIM(p_make))
    )
    AND (
      p_condition IS NULL
      OR TRIM(p_condition) = ''
      OR upper(TRIM(p_condition)) IN ('ALL', 'BOTH')
      OR upper(TRIM(c.inv_condition)) = upper(TRIM(p_condition))
    )
    AND (
      p_category IS NULL
      OR TRIM(p_category) = ''
      OR lower(TRIM(c.inv_category)) = lower(TRIM(p_category))
    )
    AND (
      p_search IS NULL
      OR TRIM(p_search) = ''
      OR COALESCE(c.inv_vin, '') ILIKE '%' || TRIM(p_search) || '%'
      OR COALESCE(c.inv_stock_number, '') ILIKE '%' || TRIM(p_search) || '%'
      OR COALESCE(c.inv_make, '') ILIKE '%' || TRIM(p_search) || '%'
      OR COALESCE(c.inv_model, '') ILIKE '%' || TRIM(p_search) || '%'
      OR COALESCE(c.inv_year, '') ILIKE '%' || TRIM(p_search) || '%'
    )
  ORDER BY c.views DESC, c.inv_make, c.inv_model;
$$;

REVOKE ALL ON FUNCTION public.get_inventory_performance_advance(
  text, date, date, text, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_inventory_performance_advance(
  text, date, date, text, text, text, text
) TO anon, authenticated, service_role;
