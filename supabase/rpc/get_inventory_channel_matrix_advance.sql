-- Per-vehicle VDP views by GA4 channel (Inventory Performance channel columns).
-- Channel shares come from smart_ga4_page_data; totals are anchored to
-- smart_final_data page views so sum(channels) = VDP (Current) per vehicle.
-- Deploy via apply_migration / SQL editor.

DROP FUNCTION IF EXISTS public.get_inventory_channel_matrix_advance(
  text, date, date, text, text, text, text
);

CREATE OR REPLACE FUNCTION public.get_inventory_channel_matrix_advance(
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
  channel_bucket   text,
  views            bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH make_keys AS (
    SELECT COALESCE(
      ARRAY(
        SELECT DISTINCT lower(trim(x))
        FROM unnest(string_to_array(COALESCE(p_make, ''), ',')) AS x
        WHERE NULLIF(lower(trim(x)), '') IS NOT NULL
          AND NULLIF(lower(trim(x)), '') <> 'all'
      ),
      ARRAY[]::text[]
    ) AS keys
  ),
  cond_keys AS (
    SELECT COALESCE(
      ARRAY(
        SELECT DISTINCT lower(trim(x))
        FROM unnest(string_to_array(COALESCE(p_condition, ''), ',')) AS x
        WHERE NULLIF(lower(trim(x)), '') IS NOT NULL
          AND NULLIF(lower(trim(x)), '') <> 'all'
      ),
      ARRAY[]::text[]
    ) AS keys
  ),
  cat_keys AS (
    SELECT COALESCE(
      ARRAY(
        SELECT DISTINCT lower(trim(x))
        FROM unnest(string_to_array(COALESCE(p_category, ''), ',')) AS x
        WHERE NULLIF(lower(trim(x)), '') IS NOT NULL
          AND NULLIF(lower(trim(x)), '') <> 'all'
      ),
      ARRAY[]::text[]
    ) AS keys
  ),
  -- One vehicle + final_data views per page/day (VDP total source of truth).
  -- Pages without VIN/stock roll into __UNASSIGNED__ so totals match All Dealers.
  page_vehicle AS (
    SELECT DISTINCT ON (f.client_id, f.report_date, f.page_path)
      f.client_id::text AS client_id,
      f.report_date,
      f.page_path,
      NULLIF(TRIM(f.inv_vin), '') AS inv_vin,
      NULLIF(TRIM(f.inv_stock_number), '') AS inv_stock_number,
      UPPER(
        COALESCE(
          NULLIF(TRIM(f.inv_vin), ''),
          NULLIF(TRIM(f.inv_stock_number), ''),
          '__UNASSIGNED__'
        )
      ) AS vk,
      COALESCE(f.views, 0)::bigint AS final_views
    FROM public.smart_final_data f
    CROSS JOIN make_keys mk
    CROSS JOIN cond_keys ck
    CROSS JOIN cat_keys tk
    WHERE f.client_id::text = trim(p_client_id)
      AND f.report_date BETWEEN p_from AND p_to
      AND (
        f.ga4_page_type ILIKE 'VDP%'
        OR f.vdp_conditions IS TRUE
      )
      AND (
        cardinality(mk.keys) = 0
        OR lower(trim(COALESCE(f.inv_make, ''))) = ANY (mk.keys)
      )
      AND (
        cardinality(ck.keys) = 0
        OR lower(trim(COALESCE(f.inv_condition, ''))) = ANY (ck.keys)
      )
      AND (
        cardinality(tk.keys) = 0
        OR lower(trim(COALESCE(
          NULLIF(TRIM(f.inv_custom_type), ''),
          NULLIF(TRIM(f.inv_type), ''),
          ''
        ))) = ANY (tk.keys)
      )
      AND (
        NULLIF(trim(COALESCE(p_search, '')), '') IS NULL
        OR f.inv_vin ILIKE '%' || trim(p_search) || '%'
        OR f.inv_stock_number ILIKE '%' || trim(p_search) || '%'
        OR f.inv_make ILIKE '%' || trim(p_search) || '%'
        OR f.inv_model ILIKE '%' || trim(p_search) || '%'
        OR 'unassigned' ILIKE '%' || lower(trim(p_search)) || '%'
      )
    ORDER BY
      f.client_id,
      f.report_date,
      f.page_path,
      CASE WHEN NULLIF(TRIM(f.inv_vin), '') IS NOT NULL THEN 0 ELSE 1 END,
      f.views DESC NULLS LAST
  ),
  -- GA4 channel raw views per page/day
  ga4_ch AS (
    SELECT
      g.client_id::text AS client_id,
      g.report_date,
      g.page_path,
      CASE lower(trim(COALESCE(g.channel, '')))
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
        WHEN 'ai_assistant'    THEN 'Ai Assistant'
        WHEN ''                THEN '(not set)'
        ELSE initcap(replace(replace(lower(trim(g.channel)), '_', ' '), '-', ' '))
      END AS channel_bucket,
      SUM(COALESCE(g.views, 0))::bigint AS ch_views
    FROM public.smart_ga4_page_data g
    WHERE g.client_id::text = trim(p_client_id)
      AND g.report_date BETWEEN p_from AND p_to
      AND (
        g.vdp_conditions IS TRUE
        OR g.ga4_page_type ILIKE 'VDP%'
      )
    GROUP BY 1, 2, 3, 4
  ),
  ga4_tot AS (
    SELECT
      client_id,
      report_date,
      page_path,
      SUM(ch_views)::bigint AS tot_views
    FROM ga4_ch
    GROUP BY 1, 2, 3
  ),
  -- Prorate final_data page views across channels by GA4 share
  allocated AS (
    SELECT
      pv.inv_vin,
      pv.inv_stock_number,
      pv.vk,
      gc.channel_bucket,
      CASE
        WHEN COALESCE(gt.tot_views, 0) <= 0 THEN 0::numeric
        ELSE pv.final_views::numeric * (gc.ch_views::numeric / gt.tot_views::numeric)
      END AS views_num
    FROM page_vehicle pv
    INNER JOIN ga4_ch gc
      ON gc.client_id = pv.client_id
     AND gc.report_date = pv.report_date
     AND gc.page_path = pv.page_path
    INNER JOIN ga4_tot gt
      ON gt.client_id = pv.client_id
     AND gt.report_date = pv.report_date
     AND gt.page_path = pv.page_path
    WHERE gc.channel_bucket IS NOT NULL
      AND pv.final_views > 0
  )
  SELECT
    CASE
      WHEN a.vk = '__UNASSIGNED__' THEN 'Unassigned'
      ELSE MAX(a.inv_vin)
    END AS inv_vin,
    MAX(a.inv_stock_number) AS inv_stock_number,
    a.channel_bucket,
    ROUND(SUM(a.views_num))::bigint AS views
  FROM allocated a
  GROUP BY a.vk, a.channel_bucket
  HAVING ROUND(SUM(a.views_num)) > 0
  ORDER BY a.vk, ROUND(SUM(a.views_num)) DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_inventory_channel_matrix_advance(
  text, date, date, text, text, text, text
) TO authenticated, service_role;
