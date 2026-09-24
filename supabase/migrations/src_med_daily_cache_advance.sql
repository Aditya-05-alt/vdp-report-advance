-- Daily source/medium cache for fast All Dealers Source Mapping preview.
-- Populated by refresh_src_med_daily_advance(date); bulk RPC reads from it.

CREATE TABLE IF NOT EXISTS public.smart_ga4_src_med_daily_advance (
  report_date date NOT NULL,
  client_id   text NOT NULL,
  raw_source  text NOT NULL,
  raw_medium  text NOT NULL,
  raw_channel text,
  page_views  bigint NOT NULL DEFAULT 0,
  vdp_views   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (report_date, client_id, raw_source, raw_medium)
);

CREATE INDEX IF NOT EXISTS idx_src_med_daily_adv_date
  ON public.smart_ga4_src_med_daily_advance (report_date);

CREATE INDEX IF NOT EXISTS idx_src_med_daily_adv_client_date
  ON public.smart_ga4_src_med_daily_advance (client_id, report_date);

GRANT SELECT ON public.smart_ga4_src_med_daily_advance TO anon, authenticated, service_role;
GRANT ALL ON public.smart_ga4_src_med_daily_advance TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_src_med_daily_advance(p_day date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '55s'
AS $$
DECLARE
  r RECORD;
  v_count integer := 0;
  v_ins integer;
BEGIN
  IF p_day IS NULL THEN RETURN 0; END IF;
  DELETE FROM public.smart_ga4_src_med_daily_advance WHERE report_date = p_day;
  FOR r IN
    SELECT DISTINCT ON (h.ga4_customer_id) h.ga4_customer_id::text AS cid
    FROM public.smart_hoot_config h
    WHERE h.is_active IS TRUE
      AND h.ga4_customer_id IS NOT NULL
      AND h.ga4_customer_id::text <> ''
    ORDER BY h.ga4_customer_id, h.id DESC
  LOOP
    INSERT INTO public.smart_ga4_src_med_daily_advance (
      report_date, client_id, raw_source, raw_medium, raw_channel, page_views, vdp_views
    )
    SELECT
      p.report_date,
      p.client_id::text,
      COALESCE(NULLIF(TRIM(p.source), ''), '(direct)'),
      COALESCE(NULLIF(TRIM(p.medium), ''), '(none)'),
      MAX(NULLIF(TRIM(p.channel), '')),
      SUM(COALESCE(p.views, 0))::bigint,
      SUM(
        CASE
          WHEN p.ga4_page_type ILIKE 'VDP%' THEN COALESCE(p.views, 0)
          ELSE 0
        END
      )::bigint
    FROM public.smart_ga4_page_data p
    WHERE p.client_id = r.cid
      AND p.report_date = p_day
      AND COALESCE(p.views, 0) > 0
    GROUP BY 1, 2, 3, 4
    HAVING SUM(COALESCE(p.views, 0)) > 0;
    GET DIAGNOSTICS v_ins = ROW_COUNT;
    v_count := v_count + v_ins;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_src_med_daily_advance(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_src_med_daily_advance(date) TO service_role;

-- Instant read from cache (no live scan of smart_ga4_page_data).
CREATE OR REPLACE FUNCTION public.get_raw_source_medium_traffic_bulk_advance(
  p_from       date,
  p_to         date,
  p_client_ids text[] DEFAULT NULL
)
RETURNS TABLE (
  raw_source  text,
  raw_medium  text,
  raw_channel text,
  page_views  bigint,
  vdp_views   bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '15s'
AS $$
  SELECT
    c.raw_source,
    c.raw_medium,
    MAX(c.raw_channel) AS raw_channel,
    SUM(c.page_views)::bigint AS page_views,
    SUM(c.vdp_views)::bigint AS vdp_views
  FROM public.smart_ga4_src_med_daily_advance c
  WHERE c.report_date BETWEEN p_from AND p_to
    AND (
      p_client_ids IS NULL
      OR COALESCE(array_length(p_client_ids, 1), 0) = 0
      OR c.client_id = ANY (p_client_ids)
    )
  GROUP BY c.raw_source, c.raw_medium
  HAVING SUM(c.page_views) > 0
  ORDER BY page_views DESC, c.raw_source, c.raw_medium;
$$;

REVOKE ALL ON FUNCTION public.get_raw_source_medium_traffic_bulk_advance(date, date, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_raw_source_medium_traffic_bulk_advance(date, date, text[])
  TO anon, authenticated, service_role;

-- Backfill example (run per day after deploy / nightly):
-- SELECT public.refresh_src_med_daily_advance(d::date)
-- FROM generate_series(date_trunc('month', CURRENT_DATE)::date, CURRENT_DATE, '1 day') d;
