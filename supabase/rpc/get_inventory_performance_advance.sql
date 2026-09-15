-- Inventory Performance (advance): vehicle-level VDP rows from smart_final_data
-- PLUS current inventory units with 0 views (hoot live, else scrap).
-- Optional p_channel filters VDP views via smart_ga4_page_data.channel
-- (normalized: case/underscore insensitive, e.g. Paid Search = paid_search).
-- When any channel is selected, 0-view inventory rows are excluded.
-- Deploy in Supabase SQL editor (or apply_migration).

DROP FUNCTION IF EXISTS public.get_inventory_performance_advance(text, date, date);
DROP FUNCTION IF EXISTS public.get_inventory_performance_advance(
  text, date, date, text, text, text, text
);
DROP FUNCTION IF EXISTS public.get_inventory_performance_advance(
  text, date, date, text, text, text, text, text
);

CREATE OR REPLACE FUNCTION public.get_inventory_performance_advance(
  p_client_id  text,
  p_from       date,
  p_to         date,
  p_make       text DEFAULT NULL,
  p_condition  text DEFAULT NULL,
  p_category   text DEFAULT NULL,
  p_search     text DEFAULT NULL,
  p_channel    text DEFAULT NULL
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
  WITH channel_keys AS (
    SELECT COALESCE(
      ARRAY(
        SELECT DISTINCT NULLIF(
          lower(regexp_replace(trim(x), '[_]+', ' ', 'g')),
          ''
        )
        FROM unnest(string_to_array(COALESCE(p_channel, ''), ',')) AS x
        WHERE NULLIF(lower(regexp_replace(trim(x), '[_]+', ' ', 'g')), '') IS NOT NULL
          AND NULLIF(lower(regexp_replace(trim(x), '[_]+', ' ', 'g')), '') <> 'all'
      ),
      ARRAY[]::text[]
    ) AS keys
  ),
  view_base AS (
    -- All channels: aggregate from smart_final_data
    SELECT
      NULLIF(TRIM(f.inv_vin), '') AS inv_vin,
      NULLIF(TRIM(f.inv_stock_number), '') AS inv_stock_number,
      UPPER(
        COALESCE(
          NULLIF(TRIM(f.inv_vin), ''),
          NULLIF(TRIM(f.inv_stock_number), ''),
          '__UNASSIGNED__'
        )
      ) AS vk,
      COALESCE(NULLIF(TRIM(f.inv_make), ''), 'Unknown') AS inv_make,
      CASE
        WHEN COALESCE(
          NULLIF(TRIM(f.inv_vin), ''),
          NULLIF(TRIM(f.inv_stock_number), '')
        ) IS NULL THEN 'Unassigned'
        ELSE COALESCE(NULLIF(TRIM(f.inv_model), ''), 'Unknown')
      END AS inv_model,
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
    CROSS JOIN channel_keys ck
    WHERE cardinality(ck.keys) = 0
      AND f.client_id = trim(p_client_id)
      AND f.report_date BETWEEN p_from AND p_to
      AND f.vdp_conditions IS TRUE

    UNION ALL

    -- Channel filter: GA4 page rows × final_data vehicle attrs
    SELECT
      NULLIF(TRIM(f.inv_vin), '') AS inv_vin,
      NULLIF(TRIM(f.inv_stock_number), '') AS inv_stock_number,
      UPPER(
        COALESCE(
          NULLIF(TRIM(f.inv_vin), ''),
          NULLIF(TRIM(f.inv_stock_number), ''),
          '__UNASSIGNED__'
        )
      ) AS vk,
      COALESCE(NULLIF(TRIM(f.inv_make), ''), 'Unknown') AS inv_make,
      CASE
        WHEN COALESCE(
          NULLIF(TRIM(f.inv_vin), ''),
          NULLIF(TRIM(f.inv_stock_number), '')
        ) IS NULL THEN 'Unassigned'
        ELSE COALESCE(NULLIF(TRIM(f.inv_model), ''), 'Unknown')
      END AS inv_model,
      COALESCE(NULLIF(TRIM(f.inv_year), ''), '—') AS inv_year,
      COALESCE(NULLIF(TRIM(f.inv_condition), ''), 'Unknown') AS inv_condition,
      COALESCE(
        NULLIF(TRIM(f.inv_custom_type), ''),
        NULLIF(TRIM(f.inv_type), ''),
        'Unknown'
      ) AS inv_category,
      COALESCE(g.views, 0)::bigint AS views,
      COALESCE(g.total_users, 0)::bigint AS unique_views
    FROM public.smart_ga4_page_data g
    INNER JOIN public.smart_final_data f
      ON f.client_id = g.client_id
     AND f.report_date = g.report_date
     AND f.page_path = g.page_path
    CROSS JOIN channel_keys ck
    WHERE cardinality(ck.keys) > 0
      AND g.client_id = trim(p_client_id)
      AND g.report_date BETWEEN p_from AND p_to
      AND g.vdp_conditions IS TRUE
      AND lower(regexp_replace(trim(COALESCE(g.channel, '')), '[_]+', ' ', 'g')) = ANY (ck.keys)
  ),
  view_agg AS (
    SELECT
      CASE WHEN b.vk = '__UNASSIGNED__' THEN NULL ELSE MAX(b.inv_vin) END AS inv_vin,
      CASE
        WHEN b.vk = '__UNASSIGNED__' THEN NULL
        ELSE MAX(b.inv_stock_number)
      END AS inv_stock_number,
      b.vk,
      CASE
        WHEN b.vk = '__UNASSIGNED__' THEN 'Unknown'
        ELSE MAX(b.inv_make)
      END AS inv_make,
      CASE
        WHEN b.vk = '__UNASSIGNED__' THEN 'Unassigned'
        ELSE MAX(b.inv_model)
      END AS inv_model,
      CASE WHEN b.vk = '__UNASSIGNED__' THEN '—' ELSE MAX(b.inv_year) END AS inv_year,
      CASE
        WHEN b.vk = '__UNASSIGNED__' THEN 'Unknown'
        ELSE MAX(b.inv_condition)
      END AS inv_condition,
      CASE
        WHEN b.vk = '__UNASSIGNED__' THEN 'Unknown'
        ELSE MAX(b.inv_category)
      END AS inv_category,
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
    WHERE i.ga4_customer_id = trim(p_client_id)
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
    WHERE i.customer_id = trim(p_client_id)
      AND COALESCE(
        NULLIF(TRIM(i.vin), ''),
        NULLIF(TRIM(i.stock_number), '')
      ) IS NOT NULL
      -- Skip scrap scan entirely when live hoot inventory exists for this dealer.
      AND NOT EXISTS (
        SELECT 1
        FROM public.smart_hoot_inventory_live h
        WHERE h.ga4_customer_id = trim(p_client_id)
        LIMIT 1
      )
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
    SELECT * FROM inv_scrap
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
    CROSS JOIN channel_keys ck
    -- All channels: keep 0-view inventory. Channel filter: only vehicles with views.
    WHERE cardinality(ck.keys) = 0
       OR COALESCE(v.views, 0) > 0
       OR COALESCE(v.unique_views, 0) > 0
  )
  SELECT
    COALESCE(
      c.inv_vin,
      c.inv_stock_number,
      CASE
        WHEN lower(COALESCE(c.inv_model, '')) = 'unassigned' THEN 'Unassigned'
        ELSE NULL
      END
    ) AS inv_vin,
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
      OR lower(TRIM(p_make)) = 'all'
      OR lower(TRIM(c.inv_make)) IN (
        SELECT lower(trim(x))
        FROM unnest(string_to_array(p_make, ',')) AS x
        WHERE trim(x) <> '' AND lower(trim(x)) <> 'all'
      )
    )
    AND (
      p_condition IS NULL
      OR TRIM(p_condition) = ''
      OR upper(TRIM(p_condition)) IN ('ALL', 'BOTH')
      OR EXISTS (
        SELECT 1
        FROM unnest(string_to_array(p_condition, ',')) AS x
        WHERE trim(x) <> ''
          AND upper(trim(x)) NOT IN ('ALL', 'BOTH')
          AND (
            upper(TRIM(c.inv_condition)) = upper(trim(x))
            OR upper(TRIM(c.inv_condition)) LIKE upper(trim(x)) || '%'
          )
      )
    )
    AND (
      p_category IS NULL
      OR TRIM(p_category) = ''
      OR lower(TRIM(p_category)) = 'all'
      OR lower(TRIM(c.inv_category)) IN (
        SELECT lower(trim(x))
        FROM unnest(string_to_array(p_category, ',')) AS x
        WHERE trim(x) <> '' AND lower(trim(x)) <> 'all'
      )
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
  text, date, date, text, text, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_inventory_performance_advance(
  text, date, date, text, text, text, text, text
) TO anon, authenticated, service_role;
