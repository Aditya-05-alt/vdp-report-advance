-- Daily All Dealers inventory email — config + send log.
-- Recipients live in DB so you can change emails without redeploying the edge function.
-- Deploy in Supabase SQL Editor (full file).

CREATE TABLE IF NOT EXISTS public.smart_inventory_email_config (
  id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled         boolean NOT NULL DEFAULT true,
  recipients      text[] NOT NULL DEFAULT '{}',
  cc_recipients   text[] NOT NULL DEFAULT '{}',
  from_email      text NULL,
  from_name       text NOT NULL DEFAULT 'Inventory Analysis',
  subject_prefix  text NOT NULL DEFAULT 'Inventory Data',
  notes           text NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.smart_inventory_email_config IS
  'Singleton config for daily All Dealers inventory email (edge: inventory-daily-email).';

CREATE TABLE IF NOT EXISTS public.smart_inventory_email_log (
  id              bigserial PRIMARY KEY,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz NULL,
  ok              boolean NOT NULL DEFAULT false,
  recipients      text[] NULL,
  hoot_rows       integer NULL,
  scrap_rows      integer NULL,
  total_rows      integer NULL,
  dealer_count    integer NULL,
  csv_bytes       integer NULL,
  storage_path    text NULL,
  provider_id     text NULL,
  error           text NULL,
  meta            jsonb NULL
);

COMMENT ON TABLE public.smart_inventory_email_log IS
  'Audit log for inventory-daily-email edge runs.';

CREATE INDEX IF NOT EXISTS idx_inventory_email_log_started
  ON public.smart_inventory_email_log (started_at DESC);

-- Seed one config row (edit recipients after deploy).
INSERT INTO public.smart_inventory_email_config (id, enabled, recipients, from_name, subject_prefix)
VALUES (
  1,
  true,
  ARRAY['REPLACE_WITH_YOUR_EMAIL@example.com']::text[],
  'Inventory Analysis',
  'Inventory Data'
)
ON CONFLICT (id) DO NOTHING;

-- Private storage for CSV attachments / download links (create via Dashboard or API if missing).
-- Bucket name used by edge: inventory-emails

GRANT SELECT, UPDATE ON public.smart_inventory_email_config TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.smart_inventory_email_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.smart_inventory_email_log_id_seq TO service_role;
