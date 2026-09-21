-- A&L Inventory Performance: covering index for VDP channel joins.
-- Partial on client_id + vdp_conditions so date/path probes stay index-only.
CREATE INDEX IF NOT EXISTS idx_ga4_al_vdp_date_path_ch
  ON public.smart_ga4_page_data (report_date, page_path)
  INCLUDE (channel, views)
  WHERE client_id = '2728830488' AND vdp_conditions IS TRUE;
