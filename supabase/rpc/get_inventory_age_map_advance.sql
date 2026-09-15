-- Fast age map for Inventory Performance: final_data (range) + live feed only.
-- Avoids hoot/scrap table scans so big dealers stay under ~1s for age.

CREATE OR REPLACE FUNCTION public.get_inventory_age_map_advance(
  p_client_id text,
  p_from date,
  p_to date
)
RETURNS TABLE (
  inv_vin text,
  inv_stock_number text,
  first_seen date,
  last_seen date,
  is_live boolean,
  updated_today boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH as_of AS (
    SELECT (timezone('utc', now()))::date AS d
  ),
  final_span AS (
    SELECT
      NULLIF(TRIM(f.inv_vin), '') AS inv_vin,
      NULLIF(TRIM(f.inv_stock_number), '') AS inv_stock_number,
      MIN(COALESCE(f.inv_first_seen::date, f.report_date)) AS first_seen,
      MAX(COALESCE(f.inv_last_seen::date, f.report_date)) AS last_seen
    FROM public.smart_final_data f
    WHERE f.client_id = trim(p_client_id)
      AND f.report_date BETWEEN p_from AND p_to
      AND COALESCE(NULLIF(TRIM(f.inv_vin), ''), NULLIF(TRIM(f.inv_stock_number), '')) IS NOT NULL
    GROUP BY 1, 2
  ),
  live AS (
    SELECT
      NULLIF(TRIM(l.vin), '') AS inv_vin,
      NULLIF(TRIM(l.stock_number), '') AS inv_stock_number,
      TRUE AS is_live,
      (l.synced_at IS NULL OR l.synced_at::date = (SELECT d FROM as_of)) AS updated_today
    FROM public.smart_hoot_inventory_live l
    WHERE l.ga4_customer_id = trim(p_client_id)
      AND COALESCE(NULLIF(TRIM(l.vin), ''), NULLIF(TRIM(l.stock_number), '')) IS NOT NULL
  ),
  keys AS (
    SELECT inv_vin, inv_stock_number FROM final_span
    UNION
    SELECT inv_vin, inv_stock_number FROM live
  )
  SELECT
    k.inv_vin,
    k.inv_stock_number,
    s.first_seen,
    CASE
      WHEN COALESCE(lv.is_live, FALSE) AND (SELECT d FROM as_of) > COALESCE(s.last_seen, DATE '1900-01-01')
        THEN (SELECT d FROM as_of)
      ELSE s.last_seen
    END AS last_seen,
    COALESCE(lv.is_live, FALSE) AS is_live,
    COALESCE(lv.updated_today, FALSE)
      OR (
        CASE WHEN COALESCE(lv.is_live, FALSE) THEN (SELECT d FROM as_of) ELSE s.last_seen END
      ) = (SELECT d FROM as_of) AS updated_today
  FROM keys k
  LEFT JOIN final_span s
    ON s.inv_vin IS NOT DISTINCT FROM k.inv_vin
   AND s.inv_stock_number IS NOT DISTINCT FROM k.inv_stock_number
  LEFT JOIN live lv
    ON lv.inv_vin IS NOT DISTINCT FROM k.inv_vin
   AND lv.inv_stock_number IS NOT DISTINCT FROM k.inv_stock_number;
$$;

GRANT EXECUTE ON FUNCTION public.get_inventory_age_map_advance(text, date, date)
  TO anon, authenticated, service_role;
