-- Hoot Step 3 cron — rebuild smart_final_data for recent days.
-- Runs AFTER GA4 page sync / filtration. Uses days_back=5 so recent dates
-- are not left empty when a full-history rebuild would time out.
--
-- Deploy in Supabase SQL Editor:
--   1. Replace __SERVICE_ROLE_KEY__ with your service role key.
--   2. Deploy edge: supabase functions deploy smart-master-sync
--   3. Run this script once.
--
-- Requires: pg_cron, pg_net.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT jobname FROM cron.job WHERE jobname LIKE 'smart-master-sync-hoot%'
  LOOP
    PERFORM cron.unschedule(r.jobname);
  END LOOP;
END $$;

-- 8:30 & 8:45 AM IST → 03:00 & 03:15 UTC (before scrap Step 3)
SELECT cron.schedule(
  'smart-master-sync-hoot',
  '0,15 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://rllwmeqingvuohyctddg.supabase.co/functions/v1/smart-master-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer __SERVICE_ROLE_KEY__'
    ),
    body := jsonb_build_object('days_back', 5)::jsonb
  ) AS request_id;
  $$
);

-- Retry window 8:50 AM IST → 03:20 UTC
SELECT cron.schedule(
  'smart-master-sync-hoot-2',
  '20 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://rllwmeqingvuohyctddg.supabase.co/functions/v1/smart-master-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer __SERVICE_ROLE_KEY__'
    ),
    body := jsonb_build_object('days_back', 5)::jsonb
  ) AS request_id;
  $$
);

SELECT jobid, jobname, schedule, active FROM cron.job
WHERE jobname LIKE 'smart-master-sync-hoot%'
ORDER BY jobname;
