-- Per-vehicle VDP views by GA4 channel (Inventory Performance channel columns).
-- Hash-join a VDP-only GA4 slice (uses idx_ga4_al_vdp_date_path_ch for A&L).
-- Prefer day-chunked callers for large ranges (~400ms/day vs multi-second full range).

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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET plan_cache_mode = force_custom_plan
AS $function$
DECLARE
  v_cid text := trim(p_client_id);
  v_make text[] := COALESCE(ARRAY(
    SELECT DISTINCT lower(trim(x)) FROM unnest(string_to_array(COALESCE(p_make, ''), ',')) AS x
    WHERE NULLIF(lower(trim(x)), '') IS NOT NULL AND NULLIF(lower(trim(x)), '') <> 'all'
  ), ARRAY[]::text[]);
  v_cond text[] := COALESCE(ARRAY(
    SELECT DISTINCT lower(trim(x)) FROM unnest(string_to_array(COALESCE(p_condition, ''), ',')) AS x
    WHERE NULLIF(lower(trim(x)), '') IS NOT NULL AND NULLIF(lower(trim(x)), '') <> 'all'
  ), ARRAY[]::text[]);
  v_cat text[] := COALESCE(ARRAY(
    SELECT DISTINCT lower(trim(x)) FROM unnest(string_to_array(COALESCE(p_category, ''), ',')) AS x
    WHERE NULLIF(lower(trim(x)), '') IS NOT NULL AND NULLIF(lower(trim(x)), '') <> 'all'
  ), ARRAY[]::text[]);
  v_search text := NULLIF(trim(COALESCE(p_search, '')), '');
BEGIN
  -- Covering VDP index → hash join beats 10k nestloop probes on large dealers.
  PERFORM set_config('enable_nestloop', 'off', true);
  PERFORM set_config('enable_hashjoin', 'on', true);
  PERFORM set_config('work_mem', '128MB', true);

  RETURN QUERY
  WITH page_vehicle AS MATERIALIZED (
    SELECT
      f.client_id,
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
    WHERE f.client_id = v_cid
      AND f.report_date BETWEEN p_from AND p_to
      AND COALESCE(f.views, 0) > 0
      AND (cardinality(v_make) = 0 OR lower(trim(COALESCE(f.inv_make, ''))) = ANY (v_make))
      AND (cardinality(v_cond) = 0 OR lower(trim(COALESCE(f.inv_condition, ''))) = ANY (v_cond))
      AND (
        cardinality(v_cat) = 0
        OR lower(trim(COALESCE(NULLIF(TRIM(f.inv_custom_type), ''), NULLIF(TRIM(f.inv_type), ''), ''))) = ANY (v_cat)
      )
      AND (
        v_search IS NULL
        OR f.inv_vin ILIKE '%' || v_search || '%'
        OR f.inv_stock_number ILIKE '%' || v_search || '%'
        OR f.inv_make ILIKE '%' || v_search || '%'
        OR f.inv_model ILIKE '%' || v_search || '%'
        OR 'unassigned' ILIKE '%' || lower(v_search) || '%'
      )
  ),
  ga4_slice AS MATERIALIZED (
    SELECT
      g.client_id,
      g.report_date,
      g.page_path,
      g.channel,
      COALESCE(g.views, 0)::bigint AS views
    FROM public.smart_ga4_page_data g
    WHERE g.client_id = v_cid
      AND g.vdp_conditions IS TRUE
      AND g.report_date BETWEEN p_from AND p_to
  ),
  page_ch AS (
    SELECT
      pv.vk,
      pv.inv_vin,
      pv.inv_stock_number,
      pv.final_views,
      pv.client_id,
      pv.report_date,
      pv.page_path,
      CASE lower(trim(COALESCE(g.channel, '')))
        WHEN 'organic_search' THEN 'Organic Search'
        WHEN 'paid_search' THEN 'Paid Search'
        WHEN 'direct' THEN 'Direct'
        WHEN 'organic_social' THEN 'Organic Social'
        WHEN 'paid_social' THEN 'Paid Social'
        WHEN 'paid_video' THEN 'Paid Video'
        WHEN 'organic_video' THEN 'Organic Video'
        WHEN 'display' THEN 'Display'
        WHEN 'email' THEN 'Email'
        WHEN 'referral' THEN 'Referral'
        WHEN 'affiliates' THEN 'Affiliates'
        WHEN 'paid_other' THEN 'Paid Other'
        WHEN 'sms' THEN 'SMS'
        WHEN 'audio' THEN 'Audio'
        WHEN 'cross-network' THEN 'Cross-network'
        WHEN 'unassigned' THEN 'Unassigned'
        WHEN 'ai_assistant' THEN 'Ai Assistant'
        WHEN '' THEN '(not set)'
        ELSE initcap(replace(replace(lower(trim(g.channel)), '_', ' '), '-', ' '))
      END AS channel_bucket,
      SUM(g.views)::bigint AS ch_views
    FROM page_vehicle pv
    INNER JOIN ga4_slice g
      ON g.client_id = pv.client_id
     AND g.report_date = pv.report_date
     AND g.page_path = pv.page_path
    GROUP BY
      pv.vk,
      pv.inv_vin,
      pv.inv_stock_number,
      pv.final_views,
      pv.client_id,
      pv.report_date,
      pv.page_path,
      8
  ),
  page_tot AS (
    SELECT
      client_id,
      report_date,
      page_path,
      SUM(ch_views)::bigint AS tot_views
    FROM page_ch
    GROUP BY 1, 2, 3
  )
  SELECT
    CASE WHEN pc.vk = '__UNASSIGNED__' THEN 'Unassigned' ELSE MAX(pc.inv_vin) END,
    MAX(pc.inv_stock_number),
    pc.channel_bucket,
    ROUND(SUM(
      CASE WHEN COALESCE(pt.tot_views, 0) <= 0 THEN 0::numeric
           ELSE pc.final_views::numeric * (pc.ch_views::numeric / pt.tot_views::numeric)
      END
    ))::bigint
  FROM page_ch pc
  INNER JOIN page_tot pt
    ON pt.client_id = pc.client_id
   AND pt.report_date = pc.report_date
   AND pt.page_path = pc.page_path
  WHERE pc.channel_bucket IS NOT NULL
  GROUP BY pc.vk, pc.channel_bucket
  HAVING ROUND(SUM(
      CASE WHEN COALESCE(pt.tot_views, 0) <= 0 THEN 0::numeric
           ELSE pc.final_views::numeric * (pc.ch_views::numeric / pt.tot_views::numeric)
      END
    )) > 0
  ORDER BY pc.vk, 4 DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_inventory_channel_matrix_advance(
  text, date, date, text, text, text, text
) TO anon, authenticated, service_role;
