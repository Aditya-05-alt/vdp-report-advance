-- Advance-only Source Mapping tables + bulk raw traffic RPC.
-- Isolated from shared smart_source_mapping_channels / smart_source_mapping_rules.

CREATE TABLE IF NOT EXISTS public.smart_source_mapping_channels_advance (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  color       text NOT NULL DEFAULT '#94a3b8',
  sort_order  int  NOT NULL DEFAULT 0,
  is_unmapped boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.smart_source_mapping_rules_advance (
  id          bigserial PRIMARY KEY,
  raw_source  text NOT NULL,
  raw_medium  text NOT NULL,
  channel_id  text NOT NULL REFERENCES public.smart_source_mapping_channels_advance(id)
                ON DELETE CASCADE,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (raw_source, raw_medium)
);

CREATE INDEX IF NOT EXISTS idx_source_mapping_rules_advance_channel
  ON public.smart_source_mapping_rules_advance (channel_id);

CREATE INDEX IF NOT EXISTS idx_source_mapping_rules_advance_pair
  ON public.smart_source_mapping_rules_advance (lower(raw_source), lower(raw_medium));

-- Seed from shared tables once (preserve existing mappings), else defaults.
INSERT INTO public.smart_source_mapping_channels_advance (id, name, color, sort_order, is_unmapped, updated_at)
SELECT c.id, c.name, c.color, c.sort_order, c.is_unmapped, COALESCE(c.updated_at, now())
FROM public.smart_source_mapping_channels c
WHERE NOT EXISTS (SELECT 1 FROM public.smart_source_mapping_channels_advance LIMIT 1);

INSERT INTO public.smart_source_mapping_channels_advance (id, name, color, sort_order, is_unmapped)
SELECT * FROM (VALUES
  ('organic-search', 'Organic Search', '#2563eb', 10, false),
  ('direct',         'Direct',         '#16a34a', 20, false),
  ('paid-search',    'Paid Search',    '#d97706', 30, false),
  ('paid-social',    'Paid Social',    '#dc2626', 40, false),
  ('organic-social', 'Organic Social', '#7c3aed', 50, false),
  ('referral',       'Referral',       '#0891b2', 60, false),
  ('email',          'Email',          '#db2777', 70, false),
  ('unmapped',       'Unmapped',       '#94a3b8', 999, true)
) AS v(id, name, color, sort_order, is_unmapped)
WHERE NOT EXISTS (SELECT 1 FROM public.smart_source_mapping_channels_advance LIMIT 1);

INSERT INTO public.smart_source_mapping_rules_advance (raw_source, raw_medium, channel_id, updated_at)
SELECT DISTINCT ON (lower(trim(r.raw_source)), lower(trim(r.raw_medium)))
  lower(trim(r.raw_source)),
  lower(trim(r.raw_medium)),
  r.channel_id,
  COALESCE(r.updated_at, now())
FROM public.smart_source_mapping_rules r
WHERE EXISTS (
  SELECT 1 FROM public.smart_source_mapping_channels_advance c WHERE c.id = r.channel_id
)
  AND NOT EXISTS (SELECT 1 FROM public.smart_source_mapping_rules_advance LIMIT 1)
ORDER BY lower(trim(r.raw_source)), lower(trim(r.raw_medium)), r.updated_at DESC NULLS LAST;

INSERT INTO public.smart_source_mapping_rules_advance (raw_source, raw_medium, channel_id)
SELECT * FROM (VALUES
  ('google',         'organic',  'organic-search'),
  ('bing',           'organic',  'organic-search'),
  ('yahoo',          'organic',  'organic-search'),
  ('(direct)',       '(none)',   'direct'),
  ('google',         'cpc',      'paid-search'),
  ('bing',           'cpc',      'paid-search'),
  ('facebook',       'paid',     'paid-social'),
  ('instagram',      'paid',     'paid-social'),
  ('tiktok',         'paid',     'paid-social'),
  ('facebook',       'organic',  'organic-social'),
  ('instagram',      'organic',  'organic-social'),
  ('autotrader.com', 'referral', 'referral'),
  ('cars.com',       'referral', 'referral'),
  ('cargurus.com',   'referral', 'referral'),
  ('newsletter',     'email',    'email'),
  ('klaviyo',        'email',    'email')
) AS v(raw_source, raw_medium, channel_id)
WHERE NOT EXISTS (SELECT 1 FROM public.smart_source_mapping_rules_advance LIMIT 1);

GRANT SELECT ON public.smart_source_mapping_channels_advance TO anon, authenticated, service_role;
GRANT SELECT ON public.smart_source_mapping_rules_advance TO anon, authenticated, service_role;
GRANT ALL ON public.smart_source_mapping_channels_advance TO service_role;
GRANT ALL ON public.smart_source_mapping_rules_advance TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.smart_source_mapping_rules_advance_id_seq TO service_role;

-- Bulk raw source/medium traffic (All Dealers / Multi).
-- LATERAL per-dealer scans use (client_id, report_date) indexes.
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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '55s'
AS $$
DECLARE
  v_chunked boolean := COALESCE(array_length(p_client_ids, 1), 0) > 0;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'Invalid date range: % .. %', p_from, p_to;
  END IF;

  RETURN QUERY
  WITH dealers AS (
    SELECT DISTINCT ON (h.ga4_customer_id)
      h.ga4_customer_id::text AS cid
    FROM public.smart_hoot_config h
    WHERE h.is_active IS TRUE
      AND h.ga4_customer_id IS NOT NULL
      AND h.ga4_customer_id::text <> ''
      AND (
        NOT v_chunked
        OR h.ga4_customer_id::text = ANY (p_client_ids)
      )
    ORDER BY h.ga4_customer_id, h.id DESC
  ),
  per_dealer AS (
    SELECT
      x.raw_source,
      x.raw_medium,
      x.raw_channel,
      x.page_views,
      x.vdp_views
    FROM dealers d
    CROSS JOIN LATERAL (
      SELECT
        COALESCE(NULLIF(TRIM(p.source), ''), '(direct)') AS raw_source,
        COALESCE(NULLIF(TRIM(p.medium), ''), '(none)') AS raw_medium,
        MAX(NULLIF(TRIM(p.channel), '')) AS raw_channel,
        SUM(COALESCE(p.views, 0))::bigint AS page_views,
        SUM(
          CASE
            WHEN p.ga4_page_type ILIKE 'VDP%' THEN COALESCE(p.views, 0)
            ELSE 0
          END
        )::bigint AS vdp_views
      FROM public.smart_ga4_page_data p
      WHERE p.client_id = d.cid
        AND p.report_date BETWEEN p_from AND p_to
        AND COALESCE(p.views, 0) > 0
      GROUP BY 1, 2
      HAVING SUM(COALESCE(p.views, 0)) > 0
    ) x
  )
  SELECT
    pd.raw_source,
    pd.raw_medium,
    MAX(pd.raw_channel) AS raw_channel,
    SUM(pd.page_views)::bigint AS page_views,
    SUM(pd.vdp_views)::bigint AS vdp_views
  FROM per_dealer pd
  GROUP BY pd.raw_source, pd.raw_medium
  ORDER BY page_views DESC, pd.raw_source, pd.raw_medium;
END;
$$;

REVOKE ALL ON FUNCTION public.get_raw_source_medium_traffic_bulk_advance(date, date, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_raw_source_medium_traffic_bulk_advance(date, date, text[])
  TO anon, authenticated, service_role;
