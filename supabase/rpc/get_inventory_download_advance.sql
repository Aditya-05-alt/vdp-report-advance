-- Fast Inventory Analyse download — latest daily snapshot only (no date range).
-- Hoot live has NO pull_date; history = smart_hoot_inventory_daily.pull_date.
-- Scrap = smart_scrap_inventory_daily.pull_date.
--
-- p_from / p_to optional: when NULL, uses MAX(pull_date) overall (latest daily).
-- When set, uses MAX(pull_date) within that window (compat with older callers).
--
-- Deploy in Supabase SQL Editor (full file).

DROP FUNCTION IF EXISTS public.get_inventory_download_advance(date, date, text, text[]);

CREATE OR REPLACE FUNCTION public.get_inventory_download_advance(
  p_from        date DEFAULT NULL,
  p_to          date DEFAULT NULL,
  p_source      text DEFAULT 'both',   -- both | hoot | scrap
  p_client_ids  text[] DEFAULT NULL    -- NULL / empty = all dealers (by ga4 id)
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '55s'
AS $$
DECLARE
  v_source     text := lower(trim(COALESCE(p_source, 'both')));
  v_want_hoot  boolean := v_source IN ('both', 'hoot');
  v_want_scrap boolean := v_source IN ('both', 'scrap');
  v_all        boolean := (p_client_ids IS NULL OR cardinality(p_client_ids) = 0);
  v_from       date := p_from;
  v_to         date := p_to;
  v_hoot_as_of date;
  v_scrap_as_of date;
  v_rows       jsonb := '[]'::jsonb;
  v_hoot_rows  jsonb := '[]'::jsonb;
  v_scrap_rows jsonb := '[]'::jsonb;
BEGIN
  IF NOT v_want_hoot AND NOT v_want_scrap THEN
    RAISE EXCEPTION 'p_source must be both, hoot, or scrap';
  END IF;

  -- Latest daily only when dates omitted; otherwise latest within window.
  IF v_from IS NULL AND v_to IS NULL THEN
    NULL; -- unbounded → MAX(pull_date) overall below
  ELSIF v_from IS NULL OR v_to IS NULL THEN
    v_from := COALESCE(v_from, v_to);
    v_to := COALESCE(v_to, v_from);
  ELSIF v_from > v_to THEN
    RAISE EXCEPTION 'Invalid date range: % .. %', v_from, v_to;
  END IF;

  IF v_want_hoot THEN
    SELECT MAX(d.pull_date)
      INTO v_hoot_as_of
    FROM public.smart_hoot_inventory_daily d
    WHERE (v_from IS NULL AND v_to IS NULL)
       OR d.pull_date BETWEEN v_from AND v_to;
  END IF;

  IF v_want_scrap THEN
    SELECT MAX(d.pull_date)
      INTO v_scrap_as_of
    FROM public.smart_scrap_inventory_daily d
    WHERE (v_from IS NULL AND v_to IS NULL)
       OR d.pull_date BETWEEN v_from AND v_to;
  END IF;

  IF v_want_hoot AND v_hoot_as_of IS NULL AND v_want_scrap AND v_scrap_as_of IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'No daily inventory snapshots found',
      'from', v_from,
      'to', v_to,
      'hootAsOf', NULL,
      'scrapAsOf', NULL,
      'rowCount', 0,
      'rows', '[]'::jsonb
    );
  END IF;

  -- Hoot: daily table only (live has no pull_date / history).
  IF v_want_hoot AND v_hoot_as_of IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.dealer_name, x.vin), '[]'::jsonb)
      INTO v_hoot_rows
    FROM (
      SELECT
        'Hoot'::text AS source,
        COALESCE(q.customer_name, '') AS dealer_name,
        COALESCE(q.ga4_customer_id, '') AS client_id,
        COALESCE(q.vin, '') AS vin,
        COALESCE(q.stock_number, '') AS stock_number,
        COALESCE(q.year, '') AS year,
        COALESCE(q.make, '') AS make,
        COALESCE(q.model, '') AS model,
        COALESCE(q.trim, '') AS trim,
        COALESCE(q.condition, '') AS condition,
        COALESCE(q.type_, '') AS type,
        q.price AS price,
        q.msrp AS msrp,
        COALESCE(q.location, '') AS location,
        COALESCE(q.url, '') AS url,
        COALESCE(q.advertiser, '') AS advertiser,
        COALESCE(q.snapshotted_at, q.last_seen) AS synced_at,
        q.pull_date AS pull_date
      FROM (
        SELECT DISTINCT ON (d.sk)
          d.customer_name,
          cfg.ga4_customer_id,
          d.vin,
          d.stock_number,
          d.year,
          d.make,
          d.model,
          d.trim,
          d.condition,
          d.type_,
          d.price,
          d.msrp,
          d.location,
          d.url,
          d.advertiser,
          d.snapshotted_at,
          d.last_seen,
          d.pull_date,
          d.sk
        FROM public.smart_hoot_inventory_daily d
        LEFT JOIN (
          SELECT DISTINCT ON (TRIM(h.customer_name))
            TRIM(h.customer_name) AS customer_name,
            TRIM(h.ga4_customer_id::text) AS ga4_customer_id
          FROM public.smart_hoot_config h
          WHERE COALESCE(h.is_active, true) = true
            AND h.ga4_customer_id IS NOT NULL
            AND TRIM(h.ga4_customer_id::text) <> ''
            AND TRIM(COALESCE(h.customer_name, '')) <> ''
          ORDER BY TRIM(h.customer_name), h.id
        ) cfg
          ON TRIM(COALESCE(d.customer_name, '')) = cfg.customer_name
          OR TRIM(COALESCE(d.advertiser, '')) = cfg.customer_name
        WHERE d.pull_date = v_hoot_as_of
          AND (
            v_all
            OR (
              cfg.ga4_customer_id IS NOT NULL
              AND cfg.ga4_customer_id = ANY (
                SELECT TRIM(x) FROM unnest(p_client_ids) AS x WHERE TRIM(x) <> ''
              )
            )
          )
        ORDER BY
          d.sk,
          CASE
            WHEN TRIM(COALESCE(d.customer_name, '')) = cfg.customer_name THEN 0
            ELSE 1
          END
      ) q
    ) x;
  END IF;

  -- Scrap: daily pull_date filter (easy day grain).
  IF v_want_scrap AND v_scrap_as_of IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.dealer_name, x.vin), '[]'::jsonb)
      INTO v_scrap_rows
    FROM (
      SELECT
        'Scrap'::text AS source,
        COALESCE(d.customer_name, '') AS dealer_name,
        COALESCE(d.customer_id, '') AS client_id,
        COALESCE(d.vin, '') AS vin,
        COALESCE(d.stock_number, '') AS stock_number,
        COALESCE(d.year, '') AS year,
        COALESCE(d.make, '') AS make,
        COALESCE(d.model, '') AS model,
        COALESCE(d.trim, '') AS trim,
        COALESCE(d.condition, '') AS condition,
        COALESCE(d.type_, '') AS type,
        d.price AS price,
        d.msrp AS msrp,
        COALESCE(d.location, '') AS location,
        COALESCE(d.url, '') AS url,
        COALESCE(d.advertiser, '') AS advertiser,
        COALESCE(d.snapshotted_at, d.last_seen) AS synced_at,
        d.pull_date AS pull_date
      FROM public.smart_scrap_inventory_daily d
      WHERE d.pull_date = v_scrap_as_of
        AND (
          v_all
          OR TRIM(COALESCE(d.customer_id, '')) = ANY (
            SELECT TRIM(x) FROM unnest(p_client_ids) AS x WHERE TRIM(x) <> ''
          )
        )
    ) x;
  END IF;

  v_rows := COALESCE(v_hoot_rows, '[]'::jsonb) || COALESCE(v_scrap_rows, '[]'::jsonb);

  RETURN jsonb_build_object(
    'ok', true,
    'from', v_from,
    'to', v_to,
    'hootAsOf', v_hoot_as_of,
    'scrapAsOf', v_scrap_as_of,
    'asOf', COALESCE(v_hoot_as_of, v_scrap_as_of),
    'source', v_source,
    'allDealers', v_all,
    'rowCount', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$$;

COMMENT ON FUNCTION public.get_inventory_download_advance(date, date, text, text[]) IS
  'Inventory Analyse CSV. Latest daily snapshot from smart_hoot_inventory_daily + smart_scrap_inventory_daily. Optional p_from/p_to window; NULL = latest overall.';

GRANT EXECUTE ON FUNCTION public.get_inventory_download_advance(date, date, text, text[])
  TO anon, authenticated, service_role;
