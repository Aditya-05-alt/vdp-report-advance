-- Daily channel MV for All Dealers (short date ranges / mid-month).
-- Deploy in Supabase SQL editor, then refresh after GA4 sync.
-- Used by get_all_dealers_channel_matrix_advance (daily grain).

DROP MATERIALIZED VIEW IF EXISTS public.mv_ga4_channel_daily CASCADE;

CREATE MATERIALIZED VIEW public.mv_ga4_channel_daily AS
SELECT
  client_id,
  report_date,
  channel,
  ga4_page_type,
  SUM(COALESCE(views, 0))::bigint AS views
FROM public.smart_ga4_page_data
GROUP BY
  client_id,
  report_date,
  channel,
  ga4_page_type;

CREATE UNIQUE INDEX mv_ga4_channel_daily_uid
  ON public.mv_ga4_channel_daily (client_id, report_date, channel, ga4_page_type);

CREATE INDEX mv_ga4_channel_daily_date_client
  ON public.mv_ga4_channel_daily (report_date, client_id);

CREATE INDEX mv_ga4_channel_daily_client_date
  ON public.mv_ga4_channel_daily (client_id, report_date);

COMMENT ON MATERIALIZED VIEW public.mv_ga4_channel_daily IS
  'All Dealers: daily channel views from smart_ga4_page_data (MTD / short ranges).';

-- First CREATE already populates. Later (after sync):
--   REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ga4_channel_daily;
