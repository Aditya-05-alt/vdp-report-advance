-- Source Mapping (HTML-style): named channels + raw source/medium → channel rules.
-- Shared across all dealers. Deploy in Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.smart_source_mapping_channels (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  color       text NOT NULL DEFAULT '#94a3b8',
  sort_order  int  NOT NULL DEFAULT 0,
  is_unmapped boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.smart_source_mapping_rules (
  id          bigserial PRIMARY KEY,
  raw_source  text NOT NULL,
  raw_medium  text NOT NULL,
  channel_id  text NOT NULL REFERENCES public.smart_source_mapping_channels(id)
                ON DELETE CASCADE,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (raw_source, raw_medium)
);

CREATE INDEX IF NOT EXISTS idx_source_mapping_rules_channel
  ON public.smart_source_mapping_rules (channel_id);

CREATE INDEX IF NOT EXISTS idx_source_mapping_rules_pair
  ON public.smart_source_mapping_rules (lower(raw_source), lower(raw_medium));

-- Seed defaults (HTML prototype) when empty
INSERT INTO public.smart_source_mapping_channels (id, name, color, sort_order, is_unmapped)
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
WHERE NOT EXISTS (SELECT 1 FROM public.smart_source_mapping_channels LIMIT 1);

INSERT INTO public.smart_source_mapping_rules (raw_source, raw_medium, channel_id)
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
WHERE NOT EXISTS (SELECT 1 FROM public.smart_source_mapping_rules LIMIT 1);

GRANT SELECT ON public.smart_source_mapping_channels TO anon, authenticated, service_role;
GRANT SELECT ON public.smart_source_mapping_rules TO anon, authenticated, service_role;
GRANT ALL ON public.smart_source_mapping_channels TO service_role;
GRANT ALL ON public.smart_source_mapping_rules TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.smart_source_mapping_rules_id_seq TO service_role;

-- Raw source/medium traffic for one dealer (admin preview + mapped Traffic).
DROP FUNCTION IF EXISTS public.get_raw_source_medium_traffic_advance(text, date, date);

CREATE OR REPLACE FUNCTION public.get_raw_source_medium_traffic_advance(
  p_client_id text,
  p_from      date,
  p_to        date
)
RETURNS TABLE (
  raw_source text,
  raw_medium text,
  page_views bigint,
  vdp_views  bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(NULLIF(TRIM(p.source), ''), '(direct)') AS raw_source,
    COALESCE(NULLIF(TRIM(p.medium), ''), '(none)') AS raw_medium,
    SUM(COALESCE(p.views, 0))::bigint AS page_views,
    SUM(
      CASE
        WHEN p.ga4_page_type ILIKE 'VDP%' THEN COALESCE(p.views, 0)
        ELSE 0
      END
    )::bigint AS vdp_views
  FROM public.smart_ga4_page_data p
  WHERE p.client_id::text = trim(p_client_id)
    AND p.report_date BETWEEN p_from AND p_to
    AND COALESCE(p.views, 0) > 0
  GROUP BY 1, 2
  HAVING SUM(COALESCE(p.views, 0)) > 0
  ORDER BY page_views DESC, raw_source, raw_medium;
$$;

REVOKE ALL ON FUNCTION public.get_raw_source_medium_traffic_advance(text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_raw_source_medium_traffic_advance(text, date, date)
  TO anon, authenticated, service_role;

-- All-dealers source/medium matrix (chunked). Used when source mapping is active.
DROP FUNCTION IF EXISTS public.get_all_dealers_source_medium_matrix_advance(date, date, text, text[]);

CREATE OR REPLACE FUNCTION public.get_all_dealers_source_medium_matrix_advance(
  p_from       date,
  p_to         date,
  p_page_type  text DEFAULT 'ALL',
  p_client_ids text[] DEFAULT NULL
)
RETURNS TABLE (
  client_id   text,
  dealer_name text,
  raw_source  text,
  raw_medium  text,
  views       bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '55s'
AS $$
DECLARE
  v_page_type text := UPPER(COALESCE(p_page_type, 'ALL'));
  v_chunked   boolean := COALESCE(array_length(p_client_ids, 1), 0) > 0;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'Invalid date range: % .. %', p_from, p_to;
  END IF;

  RETURN QUERY
  WITH dealers AS (
    SELECT DISTINCT ON (h.ga4_customer_id)
      h.ga4_customer_id::text AS dealer_client_id,
      h.customer_name         AS dealer_label
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
  agg AS (
    SELECT
      p.client_id::text AS dealer_client_id,
      COALESCE(NULLIF(TRIM(p.source), ''), '(direct)') AS raw_source,
      COALESCE(NULLIF(TRIM(p.medium), ''), '(none)') AS raw_medium,
      SUM(COALESCE(p.views, 0))::bigint AS page_views
    FROM public.smart_ga4_page_data p
    WHERE p.report_date BETWEEN p_from AND p_to
      AND COALESCE(p.views, 0) > 0
      AND (
        NOT v_chunked
        OR p.client_id::text = ANY (p_client_ids)
      )
      AND (
        v_page_type = 'ALL'
        OR (v_page_type = 'VDP' AND p.ga4_page_type ILIKE 'VDP%')
        OR (v_page_type = 'SRP' AND p.ga4_page_type = 'SRP')
        OR (v_page_type IN ('HOME', 'HOMEPAGE') AND p.ga4_page_type ILIKE 'home%')
        OR (
          v_page_type = 'OTHER'
          AND p.ga4_page_type NOT ILIKE 'VDP%'
          AND p.ga4_page_type <> 'SRP'
          AND p.ga4_page_type NOT ILIKE 'home%'
        )
      )
    GROUP BY 1, 2, 3
  )
  SELECT
    a.dealer_client_id,
    d.dealer_label,
    a.raw_source,
    a.raw_medium,
    a.page_views
  FROM agg a
  INNER JOIN dealers d ON d.dealer_client_id = a.dealer_client_id
  WHERE a.page_views > 0
  ORDER BY d.dealer_label, a.page_views DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_all_dealers_source_medium_matrix_advance(date, date, text, text[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_all_dealers_source_medium_matrix_advance(date, date, text, text[])
  TO anon, authenticated, service_role;
