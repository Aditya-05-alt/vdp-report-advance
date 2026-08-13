/**
 * Daily All Dealers inventory email via Google SMTP (nodemailer).
 *
 * Sources (unchanged):
 *   Hoot  → smart_hoot_inventory_live (live)
 *   Scrap → smart_scrap_inventory_daily for TODAY's pull_date (not full history)
 *           fallback: smart_scrap_inventory where last_seen is today (IST)
 *
 * Google SMTP: set SMTP_USER / SMTP_PASS below, OR Edge secrets with the same names
 * (secrets win when in-file pass is empty — safe for deploy).
 * Recipients: INVENTORY_EMAIL_TO below; secret / DB config / body.to can override.
 * Optional secret INVENTORY_EMAIL_FROM overrides the default From header.
 *
 * App password: Google Account → Security → 2-Step Verification → App passwords.
 * Report date uses Asia/Kolkata (IST).
 *
 * Supabase (auto): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Manual test: POST {} or POST {"dry_run":true} or POST {"to":["you@company.com"]}
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const REPORT_TIMEZONE = "Asia/Kolkata";

/** Google Workspace / Gmail SMTP — edit here (do not push real passwords to public repos). */
const SMTP_USER = "devops@brandmirchi.com";
/** 16-character app password; spaces stripped. Prefer Edge secret SMTP_PASS when set. */
const SMTP_PASS = "";
/** Primary recipient(s) — add as many as you need. */
const INVENTORY_EMAIL_TO = [
  "aditya@brandmirchi.com",
];
/** CC recipient(s) — add as many as you need. */
const INVENTORY_EMAIL_CC = [
  "lisa@brandmirchi.com",
];

const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 587;
const SMTP_SECURE = false;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PAGE = 1000;
const BUCKET = "inventory-emails";
const ATTACH_MAX_BYTES = 8 * 1024 * 1024;

const CSV_HEADERS = [
  "Source",
  "Dealer Name",
  "GA4 Customer ID",
  "VIN",
  "Stock Number",
  "Year",
  "Make",
  "Model",
  "Trim",
  "Condition",
  "Type",
  "Price",
  "MSRP",
  "Location",
  "URL",
  "Advertiser",
  "Synced At",
];

type InvRow = {
  source: string;
  dealerName: string;
  clientId: string;
  vin: string;
  stockNumber: string;
  year: string;
  make: string;
  model: string;
  trim: string;
  condition: string;
  type: string;
  price: string | number;
  msrp: string | number;
  location: string;
  url: string;
  advertiser: string;
  syncedAt: string;
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function csvCell(value: unknown) {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function rowToCsvLine(r: InvRow) {
  return [
    r.source,
    r.dealerName,
    r.clientId,
    r.vin,
    r.stockNumber,
    r.year,
    r.make,
    r.model,
    r.trim,
    r.condition,
    r.type,
    r.price,
    r.msrp,
    r.location,
    r.url,
    r.advertiser,
    r.syncedAt,
  ]
    .map(csvCell)
    .join(",");
}

function todayIst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function formatDisplayDate(isoDay: string) {
  try {
    const d = new Date(`${isoDay}T12:00:00+05:30`);
    return d.toLocaleDateString("en-IN", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: REPORT_TIMEZONE,
    });
  } catch {
    return isoDay;
  }
}

async function fetchPaged(
  // deno-lint-ignore no-explicit-any
  queryFactory: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>,
) {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await queryFactory(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return rows;
}

function mapHoot(r: Record<string, unknown>): InvRow {
  return {
    source: "Hoot",
    dealerName: String(r.customer_name ?? ""),
    clientId: String(r.ga4_customer_id ?? ""),
    vin: String(r.vin ?? ""),
    stockNumber: String(r.stock_number ?? ""),
    year: String(r.year ?? ""),
    make: String(r.make ?? ""),
    model: String(r.model ?? ""),
    trim: String(r.trim ?? ""),
    condition: String(r.condition ?? ""),
    type: String(r.type_ ?? ""),
    price: (r.price as string | number) ?? "",
    msrp: (r.msrp as string | number) ?? "",
    location: String(r.location ?? ""),
    url: String(r.url ?? ""),
    advertiser: String(r.advertiser ?? ""),
    syncedAt: String(r.synced_at ?? ""),
  };
}

function mapScrap(r: Record<string, unknown>): InvRow {
  return {
    source: "Scrap",
    dealerName: String(r.customer_name ?? ""),
    clientId: String(r.customer_id ?? ""),
    vin: String(r.vin ?? ""),
    stockNumber: String(r.stock_number ?? ""),
    year: String(r.year ?? ""),
    make: String(r.make ?? ""),
    model: String(r.model ?? ""),
    trim: String(r.trim ?? ""),
    condition: String(r.condition ?? ""),
    type: String(r.type_ ?? ""),
    price: (r.price as string | number) ?? "",
    msrp: (r.msrp as string | number) ?? "",
    location: String(r.location ?? ""),
    url: String(r.url ?? ""),
    advertiser: String(r.advertiser ?? ""),
    syncedAt: String(
      r.snapshotted_at ?? r.last_seen ?? r.updated_at ?? r.pull_date ?? "",
    ),
  };
}

/** Prefer today's scrap daily snapshot; else latest daily; else last_seen today on live scrap. */
async function fetchTodayScrap(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  reportDate: string,
): Promise<{ rows: Record<string, unknown>[]; scrapAsOf: string; scrapSource: string }> {
  let scrapAsOf = reportDate;
  const { count: todayCount, error: todayCountErr } = await supabase
    .from("smart_scrap_inventory_daily")
    .select("sk", { count: "exact", head: true })
    .eq("pull_date", reportDate);

  if (!todayCountErr && (todayCount ?? 0) > 0) {
    scrapAsOf = reportDate;
  } else {
    const { data: latest, error: latestErr } = await supabase
      .from("smart_scrap_inventory_daily")
      .select("pull_date")
      .order("pull_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latestErr && latest?.pull_date) {
      scrapAsOf = String(latest.pull_date).slice(0, 10);
    } else {
      const dayStart = `${reportDate}T00:00:00+05:30`;
      const dayEnd = `${reportDate}T23:59:59.999+05:30`;
      const live = await fetchPaged((from, to) =>
        supabase
          .from("smart_scrap_inventory")
          .select(
            "vin,url,advertiser,make,model,year,price,condition,customer_name,customer_id,location,msrp,type_,trim,stock_number,last_seen,updated_at",
          )
          .gte("last_seen", dayStart)
          .lte("last_seen", dayEnd)
          .order("customer_id", { ascending: true })
          .order("sk", { ascending: true })
          .range(from, to),
      );
      return {
        rows: live,
        scrapAsOf: reportDate,
        scrapSource: "smart_scrap_inventory(last_seen=today)",
      };
    }
  }

  const daily = await fetchPaged((from, to) =>
    supabase
      .from("smart_scrap_inventory_daily")
      .select(
        "pull_date,vin,url,advertiser,make,model,year,price,condition,customer_name,customer_id,location,msrp,type_,trim,stock_number,last_seen,snapshotted_at",
      )
      .eq("pull_date", scrapAsOf)
      .order("customer_id", { ascending: true })
      .order("sk", { ascending: true })
      .range(from, to),
  );

  return {
    rows: daily,
    scrapAsOf,
    scrapSource: `smart_scrap_inventory_daily(pull_date=${scrapAsOf})`,
  };
}

function isPlaceholderEmail(email: string) {
  const e = email.toLowerCase();
  return (
    !e ||
    e.includes("example.com") ||
    e.includes("replace_with") ||
    e === "you@company.com"
  );
}

function parseEmailList(raw: string | string[] | null | undefined): string[] {
  if (raw == null) return [];
  const parts = Array.isArray(raw)
    ? raw
    : String(raw).split(",");
  return parts
    .map((s) => String(s).trim())
    .filter((e) => e && !isPlaceholderEmail(e));
}

function summarize(rows: InvRow[]) {
  const dealers = new Set(
    rows.map((r) => r.clientId || r.dealerName).filter(Boolean),
  );
  let hoot = 0;
  let scrap = 0;
  const byCondition: Record<string, number> = {};
  for (const r of rows) {
    if (r.source === "Hoot") hoot++;
    else scrap++;
    const c = (r.condition || "Unknown").trim() || "Unknown";
    byCondition[c] = (byCondition[c] || 0) + 1;
  }
  const conditionRows = Object.entries(byCondition)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  return { dealers: dealers.size, hoot, scrap, total: rows.length, conditionRows };
}

function escapeHtml(s: string) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHtmlEmail(opts: {
  reportDate: string;
  summary: ReturnType<typeof summarize>;
  downloadUrl: string | null;
  attached: boolean;
  filename: string;
  scrapAsOf: string;
}) {
  const { reportDate, summary, downloadUrl, attached, filename, scrapAsOf } =
    opts;
  const displayDate = formatDisplayDate(reportDate);
  const conditionHtml = summary.conditionRows
    .map(
      ([label, count]) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:14px;color:#0f172a;">${escapeHtml(label)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:14px;color:#0f172a;text-align:right;font-variant-numeric:tabular-nums;">${count.toLocaleString("en-IN")}</td>
        </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Inventory Data</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:28px 28px 20px;background:#0f172a;">
              <p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#93c5fd;">Dealer reporting</p>
              <h1 style="margin:0;font-size:24px;line-height:1.25;font-weight:700;color:#ffffff;">Inventory Data</h1>
              <p style="margin:10px 0 0;font-size:14px;line-height:1.5;color:#cbd5e1;">All Dealers · ${escapeHtml(displayDate)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 28px;">
              <p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#334155;">
                Daily inventory for <strong style="color:#0f172a;">all dealers</strong>.
                Hoot from <strong>live</strong> inventory; Scrap from <strong>today’s daily snapshot</strong>
                (pull_date ${escapeHtml(scrapAsOf)}) — not the full historical scrap table.
              </p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;">
                <tr>
                  <td width="50%" style="padding:0 6px 12px 0;vertical-align:top;">
                    <div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;background:#f8fafc;">
                      <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Total vehicles</p>
                      <p style="margin:0;font-size:22px;font-weight:700;color:#0f172a;">${summary.total.toLocaleString("en-IN")}</p>
                    </div>
                  </td>
                  <td width="50%" style="padding:0 0 12px 6px;vertical-align:top;">
                    <div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;background:#f8fafc;">
                      <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Dealers</p>
                      <p style="margin:0;font-size:22px;font-weight:700;color:#0f172a;">${summary.dealers.toLocaleString("en-IN")}</p>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td width="50%" style="padding:0 6px 0 0;vertical-align:top;">
                    <div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;background:#eff6ff;">
                      <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Hoot (live)</p>
                      <p style="margin:0;font-size:20px;font-weight:700;color:#1d4ed8;">${summary.hoot.toLocaleString("en-IN")}</p>
                    </div>
                  </td>
                  <td width="50%" style="padding:0 0 0 6px;vertical-align:top;">
                    <div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;background:#f0fdf4;">
                      <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Scrap (daily)</p>
                      <p style="margin:0;font-size:20px;font-weight:700;color:#15803d;">${summary.scrap.toLocaleString("en-IN")}</p>
                    </div>
                  </td>
                </tr>
              </table>

              <h2 style="margin:0 0 10px;font-size:15px;font-weight:600;color:#0f172a;">Condition mix</h2>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin:0 0 22px;">
                <tr style="background:#f8fafc;">
                  <th align="left" style="padding:8px 12px;font-size:12px;font-weight:600;color:#64748b;">Condition</th>
                  <th align="right" style="padding:8px 12px;font-size:12px;font-weight:600;color:#64748b;">Units</th>
                </tr>
                ${conditionHtml || `<tr><td colspan="2" style="padding:12px;font-size:13px;color:#64748b;">No rows</td></tr>`}
              </table>

              <h2 style="margin:0 0 8px;font-size:15px;font-weight:600;color:#0f172a;">Full inventory CSV</h2>
              <div style="margin:0 0 18px;padding:14px 16px;border:1px solid #bfdbfe;border-radius:10px;background:#eff6ff;">
                ${
                  attached
                    ? `<p style="margin:0 0 6px;font-size:14px;font-weight:600;color:#1d4ed8;">CSV attached to this email</p>
                       <p style="margin:0;font-size:13px;line-height:1.5;color:#334155;">Open the attachment <strong>${escapeHtml(
                         filename,
                       )}</strong> for all Hoot + Scrap rows (same columns as Inventory Analysis).</p>`
                    : `<p style="margin:0 0 6px;font-size:14px;font-weight:600;color:#b45309;">Attachment skipped (file too large)</p>
                       <p style="margin:0;font-size:13px;line-height:1.5;color:#334155;">Use the download button below.</p>`
                }
                ${
                  downloadUrl
                    ? `<p style="margin:12px 0 0;font-size:14px;line-height:1.5;">
                         <a href="${escapeHtml(downloadUrl)}" style="display:inline-block;padding:10px 14px;background:#2563eb;color:#ffffff;font-weight:600;text-decoration:none;border-radius:8px;">Download inventory CSV</a>
                       </p>`
                    : ""
                }
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 24px;border-top:1px solid #e2e8f0;background:#f8fafc;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#94a3b8;">
                Automated daily email from Inventory Analysis · Smart Analytics
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Edge secrets first, then in-file constants. */
function resolvedSmtpAuth(): { user: string; pass: string } {
  const user = Deno.env.get("SMTP_USER")?.trim() || SMTP_USER.trim();
  const passEnv = (Deno.env.get("SMTP_PASS") ?? "").replace(/\s+/g, "").trim();
  const passInline = SMTP_PASS.replace(/\s+/g, "").trim();
  return { user, pass: passEnv || passInline };
}

async function sendViaSmtp(params: {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: { filename: string; content: Uint8Array; contentType: string }[];
}): Promise<{ messageId?: string }> {
  const { user, pass } = resolvedSmtpAuth();
  if (!user || !pass) {
    throw new Error(
      "Missing SMTP credentials: set SMTP_USER + SMTP_PASS in this file, or Edge secrets SMTP_USER and SMTP_PASS (Google App Password).",
    );
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user, pass },
  });

  const info = await transporter.sendMail({
    from: params.from,
    to: params.to.join(", "),
    cc: params.cc?.length ? params.cc.join(", ") : undefined,
    subject: params.subject,
    html: params.html,
    text: params.text,
    attachments: params.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  });

  return { messageId: info.messageId };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const dryRun = body?.dry_run === true;
  const skipIfSentToday = body?.skip_if_sent_today === true;
  const reportDate = todayIst();

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return jsonRes(
      { email_sent: false, ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
      500,
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  let logId: number | null = null;

  try {
    const { data: logInsert, error: logErr } = await supabase
      .from("smart_inventory_email_log")
      .insert({ started_at: new Date().toISOString(), ok: false })
      .select("id")
      .single();
    if (!logErr && logInsert?.id) logId = logInsert.id;

    if (skipIfSentToday) {
      const dayStart = `${reportDate}T00:00:00+05:30`;
      const { data: prior } = await supabase
        .from("smart_inventory_email_log")
        .select("id")
        .eq("ok", true)
        .gte("started_at", dayStart)
        .limit(1);
      if (prior?.length) {
        return jsonRes({
          email_sent: false,
          ok: true,
          skipped: true,
          message: "Already sent successfully today",
          reportDate,
        });
      }
    }

    const { data: cfg } = await supabase
      .from("smart_inventory_email_config")
      .select("*")
      .eq("id", 1)
      .maybeSingle();

    if (cfg && cfg.enabled === false) {
      return jsonRes({
        email_sent: false,
        ok: true,
        skipped: true,
        message: "Email disabled in smart_inventory_email_config",
      });
    }

    const bodyTo = Array.isArray(body?.to)
      ? (body.to as unknown[]).map((x) => String(x).trim()).filter(Boolean)
      : typeof body?.to === "string"
      ? parseEmailList(String(body.to))
      : [];

    const secretTo = parseEmailList(Deno.env.get("INVENTORY_EMAIL_TO")?.trim() || "");
    const inlineTo = parseEmailList(INVENTORY_EMAIL_TO);
    const dbTo = Array.isArray(cfg?.recipients)
      ? cfg.recipients.map((x: string) => String(x).trim()).filter((e: string) => !isPlaceholderEmail(e))
      : [];

    const recipients =
      bodyTo.length > 0
        ? bodyTo.filter((e) => !isPlaceholderEmail(e))
        : secretTo.length > 0
        ? secretTo
        : inlineTo.length > 0
        ? inlineTo
        : dbTo;

    if (!recipients.length) {
      return jsonRes({
        email_sent: false,
        ok: false,
        skipped: true,
        reason:
          "Set INVENTORY_EMAIL_TO in this file, Edge secret INVENTORY_EMAIL_TO, body.to, or smart_inventory_email_config.recipients",
        reportDate,
      });
    }

    const secretCc = parseEmailList(Deno.env.get("INVENTORY_EMAIL_CC")?.trim() || "");
    const inlineCc = parseEmailList(INVENTORY_EMAIL_CC);
    const dbCc = Array.isArray(cfg?.cc_recipients)
      ? cfg.cc_recipients.map((x: string) => String(x).trim()).filter((e: string) => !isPlaceholderEmail(e))
      : [];
    const cc =
      secretCc.length > 0 ? secretCc : inlineCc.length > 0 ? inlineCc : dbCc;

    console.log(`[inventory-daily-email] Fetching Hoot live + Scrap daily for ${reportDate}…`);

    const [hootRaw, scrapPack] = await Promise.all([
      fetchPaged((from, to) =>
        supabase
          .from("smart_hoot_inventory_live")
          .select(
            "vin,url,advertiser,make,model,year,price,condition,customer_name,ga4_customer_id,location,msrp,type_,trim,stock_number,synced_at",
          )
          .order("ga4_customer_id", { ascending: true })
          .order("sk", { ascending: true })
          .range(from, to),
      ),
      fetchTodayScrap(supabase, reportDate),
    ]);

    console.log(
      `[inventory-daily-email] Hoot live=${hootRaw.length} Scrap=${scrapPack.rows.length} via ${scrapPack.scrapSource}`,
    );

    const rows: InvRow[] = [
      ...hootRaw.map(mapHoot),
      ...scrapPack.rows.map(mapScrap),
    ];
    const summary = summarize(rows);

    const csv = `${CSV_HEADERS.join(",")}\n${rows.map(rowToCsvLine).join("\n")}\n`;
    const csvBytes = new TextEncoder().encode(csv);
    const filename = `all-dealers-inventory-hoot-scrap-${reportDate}.csv`;
    const storagePath = `${reportDate}/${filename}`;

    await supabase.storage.createBucket(BUCKET, { public: false }).catch(() => null);

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, csvBytes, {
        contentType: "text/csv; charset=utf-8",
        upsert: true,
      });
    if (upErr) {
      console.warn("[inventory-daily-email] Storage upload failed:", upErr.message);
    }

    let downloadUrl: string | null = null;
    if (!upErr) {
      const { data: signed } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
      downloadUrl = signed?.signedUrl ?? null;
    }

    const attach = csvBytes.byteLength <= ATTACH_MAX_BYTES;
    if (!attach && !downloadUrl) {
      throw new Error(
        `CSV is ${csvBytes.byteLength} bytes (too large to attach) and storage upload failed — cannot deliver file`,
      );
    }

    const html = buildHtmlEmail({
      reportDate,
      summary,
      downloadUrl,
      attached: attach,
      filename,
      scrapAsOf: scrapPack.scrapAsOf,
    });
    const text = [
      `Inventory Data — All Dealers — ${reportDate}`,
      ``,
      `Total: ${summary.total}`,
      `Hoot (live): ${summary.hoot}`,
      `Scrap (daily ${scrapPack.scrapAsOf}): ${summary.scrap}`,
      `Dealers: ${summary.dealers}`,
      attach ? `CSV attached: ${filename}` : `CSV download: ${downloadUrl || "n/a"}`,
    ].join("\n");

    const { user: smtpMailbox } = resolvedSmtpAuth();
    const fromName = cfg?.from_name || "Inventory Analysis";
    const from =
      Deno.env.get("INVENTORY_EMAIL_FROM")?.trim() ||
      cfg?.from_email ||
      (smtpMailbox
        ? `${fromName} <${smtpMailbox}>`
        : `${fromName} <noreply@localhost>`);

    const subjectPrefix = cfg?.subject_prefix || "Inventory Data";
    const subject = `${subjectPrefix} · All Dealers · ${reportDate}`;

    if (dryRun) {
      if (logId) {
        await supabase
          .from("smart_inventory_email_log")
          .update({
            finished_at: new Date().toISOString(),
            ok: true,
            recipients,
            hoot_rows: summary.hoot,
            scrap_rows: summary.scrap,
            total_rows: summary.total,
            dealer_count: summary.dealers,
            csv_bytes: csvBytes.byteLength,
            storage_path: upErr ? null : storagePath,
            meta: {
              dryRun: true,
              attach,
              from,
              scrapSource: scrapPack.scrapSource,
              scrapAsOf: scrapPack.scrapAsOf,
            },
          })
          .eq("id", logId);
      }
      return jsonRes({
        email_sent: false,
        ok: true,
        dryRun: true,
        reportDate,
        summary,
        recipients,
        cc,
        from,
        scrapSource: scrapPack.scrapSource,
        scrapAsOf: scrapPack.scrapAsOf,
        csvBytes: csvBytes.byteLength,
        attach,
        downloadUrl,
      });
    }

    console.log("[inventory-daily-email] sending SMTP …", {
      reportDate,
      to: recipients,
      cc,
      from,
      attach,
      scrapAsOf: scrapPack.scrapAsOf,
    });

    const sent = await sendViaSmtp({
      from,
      to: recipients,
      cc,
      subject,
      html,
      text,
      attachments: attach
        ? [
            {
              filename,
              content: csvBytes,
              contentType: "text/csv",
            },
          ]
        : undefined,
    });

    console.log("[inventory-daily-email] EMAIL SENT OK", {
      smtp_message_id: sent.messageId ?? null,
      to: recipients,
    });

    if (logId) {
      await supabase
        .from("smart_inventory_email_log")
        .update({
          finished_at: new Date().toISOString(),
          ok: true,
          recipients,
          hoot_rows: summary.hoot,
          scrap_rows: summary.scrap,
          total_rows: summary.total,
          dealer_count: summary.dealers,
          csv_bytes: csvBytes.byteLength,
          storage_path: upErr ? null : storagePath,
          provider_id: sent.messageId ?? null,
          meta: {
            attach,
            downloadUrl: Boolean(downloadUrl),
            scrapSource: scrapPack.scrapSource,
            scrapAsOf: scrapPack.scrapAsOf,
            transport: "google_smtp",
          },
        })
        .eq("id", logId);
    }

    return jsonRes({
      email_sent: true,
      ok: true,
      reportDate,
      summary,
      recipients,
      cc,
      smtp_message_id: sent.messageId ?? null,
      csvBytes: csvBytes.byteLength,
      attached: attach,
      scrapSource: scrapPack.scrapSource,
      scrapAsOf: scrapPack.scrapAsOf,
      storagePath: upErr ? null : storagePath,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[inventory-daily-email] EMAIL NOT SENT —", message);
    if (logId) {
      await supabase
        .from("smart_inventory_email_log")
        .update({
          finished_at: new Date().toISOString(),
          ok: false,
          error: message,
        })
        .eq("id", logId);
    }
    return jsonRes({ email_sent: false, ok: false, error: message }, 500);
  }
});
