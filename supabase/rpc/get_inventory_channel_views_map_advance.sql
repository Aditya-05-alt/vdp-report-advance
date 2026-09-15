-- Compact channel matrix: one JSON object { vk: { channel: views } }.
-- Avoids PostgREST's ~1000-row cap that truncated flat matrix rows on large dealers.

CREATE OR REPLACE FUNCTION public.get_inventory_channel_views_map_advance(
  p_client_id  text,
  p_from       date,
  p_to         date,
  p_make       text DEFAULT NULL,
  p_condition  text DEFAULT NULL,
  p_category   text DEFAULT NULL,
  p_search     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET plan_cache_mode = force_custom_plan
AS $function$
DECLARE
  v_map jsonb;
BEGIN
  WITH matrix AS (
    SELECT *
    FROM public.get_inventory_channel_matrix_advance(
      p_client_id,
      p_from,
      p_to,
      p_make,
      p_condition,
      p_category,
      p_search
    )
  ),
  by_vehicle AS (
    SELECT
      UPPER(
        COALESCE(
          NULLIF(TRIM(inv_vin), ''),
          NULLIF(TRIM(inv_stock_number), ''),
          ''
        )
      ) AS vk,
      jsonb_object_agg(channel_bucket, views) AS channel_views
    FROM matrix
    WHERE COALESCE(
        NULLIF(TRIM(inv_vin), ''),
        NULLIF(TRIM(inv_stock_number), ''),
        ''
      ) <> ''
      AND NULLIF(TRIM(channel_bucket), '') IS NOT NULL
      AND COALESCE(views, 0) > 0
    GROUP BY 1
  )
  SELECT COALESCE(jsonb_object_agg(vk, channel_views), '{}'::jsonb)
  INTO v_map
  FROM by_vehicle;

  RETURN COALESCE(v_map, '{}'::jsonb);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_inventory_channel_views_map_advance(
  text, date, date, text, text, text, text
) TO anon, authenticated, service_role;
