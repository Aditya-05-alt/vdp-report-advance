# Daily Inventory Email (All Dealers) — Google SMTP

Sends an automated daily email with **Inventory Data** for all dealers via **Gmail / Google Workspace SMTP** (nodemailer). No Resend.

| Source | Table |
|--------|--------|
| Hoot | `smart_hoot_inventory_live` (live) |
| Scrap | **Today’s** `smart_scrap_inventory_daily` (`pull_date` = today / latest) |

CSV columns match **Inventory Analysis** download. HTML summary + **CSV attachment**.

## 1. Deploy SQL

Run `supabase/migrations/smart_inventory_email.sql` (optional DB recipients / log).

## 2. Google SMTP (configured)

In `index.ts`:

| Constant | Value |
|----------|--------|
| `SMTP_USER` | `devops@brandmirchi.com` |
| `SMTP_PASS` | Google app password (set in file or secret) |
| `INVENTORY_EMAIL_TO` | `devops@brandmirchi.com` |

### Edge secrets (recommended)

Supabase Dashboard → **Project Settings → Edge Functions → Secrets**:

| Secret name | Value |
|-------------|--------|
| `SMTP_USER` | `devops@brandmirchi.com` |
| `SMTP_PASS` | your Google app password |
| `INVENTORY_EMAIL_TO` | `devops@brandmirchi.com` |

Optional: `INVENTORY_EMAIL_CC`, `INVENTORY_EMAIL_FROM`

```bash
supabase secrets set SMTP_USER=devops@brandmirchi.com --project-ref rllwmeqingvuohyctddg
supabase secrets set SMTP_PASS="YOUR_APP_PASSWORD" --project-ref rllwmeqingvuohyctddg
supabase secrets set INVENTORY_EMAIL_TO=devops@brandmirchi.com --project-ref rllwmeqingvuohyctddg
supabase functions deploy inventory-daily-email --project-ref rllwmeqingvuohyctddg
```

**Secrets win** over empty in-file pass. Prefer secrets for `SMTP_PASS` if you push this repo.

## 3. Deploy

```bash
supabase functions deploy inventory-daily-email --project-ref rllwmeqingvuohyctddg
```

## 4. Cron

Run `supabase/cron/inventory-daily-email.schedule.sql` (replace `__SERVICE_ROLE_KEY__`).

## 5. Test

```bash
curl -X POST \
  'https://rllwmeqingvuohyctddg.supabase.co/functions/v1/inventory-daily-email' \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dry_run": true}'
```

Send for real:

```bash
curl -X POST \
  'https://rllwmeqingvuohyctddg.supabase.co/functions/v1/inventory-daily-email' \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

## Logs

```sql
SELECT * FROM public.smart_inventory_email_log
ORDER BY started_at DESC
LIMIT 20;
```
