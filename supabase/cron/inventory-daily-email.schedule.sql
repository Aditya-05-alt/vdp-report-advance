-- Schedule daily All Dealers inventory email AFTER live Hoot is refreshed.
-- Default: 11:15 AM IST = 05:45 UTC (after smart-hoot-inv-live + scrap sync window).
--
-- Requires: pg_cron + pg_net
-- Replace __SERVICE_ROLE_KEY__ then run in Supabase SQL Editor.
-- Also deploy edge function inventory-daily-email + secrets RESEND_API_KEY, INVENTORY_EMAIL_FROM.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT jobname FROM cron.job WHERE jobname LIKE 'inventory-daily-email%'
  LOOP
    PERFORM cron.unschedule(r.jobname);
  END LOOP;
END $$;

-- 05:45 UTC = 11:15 AM IST
SELECT cron.schedule(
  'inventory-daily-email',
  '45 5 * * *',
  $$
  SELECT net.http_post(
    url := 'https://rllwmeqingvuohyctddg.supabase.co/functions/v1/inventory-daily-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJsbHdtZXFpbmd2dW9oeWN0ZGRnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NjA2NTM4MCwiZXhwIjoyMDkxNjQxMzgwfQ.75ylRIRwK2R1-ElcFEda4w1Re8FkdVNCeS3kJBdbkLM'
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

-- Optional retry 30 min later
SELECT cron.schedule(
  'inventory-daily-email-retry',
  '15 6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://rllwmeqingvuohyctddg.supabase.co/functions/v1/inventory-daily-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJsbHdtZXFpbmd2dW9oeWN0ZGRnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NjA2NTM4MCwiZXhwIjoyMDkxNjQxMzgwfQ.75ylRIRwK2R1-ElcFEda4w1Re8FkdVNCeS3kJBdbkLM'
    ),
    body := jsonb_build_object('skip_if_sent_today', true)::jsonb
  ) AS request_id;
  $$
);

SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname LIKE 'inventory-daily-email%'
ORDER BY jobname;
