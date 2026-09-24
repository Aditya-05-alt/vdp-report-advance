-- All-dealers Google Ads spend for a date range (daily history rows only).
-- Maps google_ads_accounts.customer_id → client_id for All Dealers Cost column.

CREATE OR REPLACE FUNCTION public.get_all_dealers_ads_cost_advance(
  p_from date,
  p_to date
)
RETURNS TABLE(
  client_id text,
  customer_id bigint,
  cost numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    NULLIF(TRIM(a.client_id), '')::text AS client_id,
    a.customer_id,
    ROUND(COALESCE(SUM(h.cost), 0)::numeric, 4) AS cost
  FROM google_ads_accounts a
  LEFT JOIN smart_campaign_history h
    ON h.customer_id = a.customer_id
   AND h.platform = 'google'
   AND h.report_from = h.report_to
   AND h.report_from >= p_from
   AND h.report_from <= p_to
  GROUP BY a.client_id, a.customer_id;
$function$;

GRANT EXECUTE ON FUNCTION public.get_all_dealers_ads_cost_advance(date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_all_dealers_ads_cost_advance(date, date) TO authenticated;
