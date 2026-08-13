/** HTML body for the daily multi-platform ad spend digest. */

export type DailyAdSpendRow = {
  id: string;
  label: string;
  spend: number;
  accent: string;
};

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatUsd(n: number, fractionDigits = 0): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(n);
}

export function renderDailyAdSpendEmailHtml(params: {
  reportDate: string;
  rows: DailyAdSpendRow[];
  total: number;
}): string {
  const { reportDate, rows, total } = params;

  const platformRows = rows
    .map((row) => {
      const pct = total > 0 ? Math.round((row.spend / total) * 1000) / 10 : 0;
      return `
      <tr>
        <td style="padding:12px 14px;border-bottom:1px solid #e8eef4;">
          <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${escapeHtml(row.accent)};margin-right:8px;vertical-align:middle;"></span>
          <span style="color:#102a43;font-size:14px;font-weight:600;vertical-align:middle;">${escapeHtml(row.label)}</span>
        </td>
        <td style="padding:12px 14px;border-bottom:1px solid #e8eef4;text-align:right;color:#102a43;font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;">
          ${formatUsd(row.spend, 2)}
        </td>
        <td style="padding:12px 14px;border-bottom:1px solid #e8eef4;text-align:right;color:#627d98;font-size:13px;font-variant-numeric:tabular-nums;">
          ${pct}%
        </td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Daily ad spend — ${escapeHtml(reportDate)}</title>
</head>
<body style="margin:0;padding:24px 12px;background:#f0f4f8;font-family:Segoe UI,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #d9e2ec;border-radius:10px;overflow:hidden;">
    <tr>
      <td style="padding:22px 24px;background:#102a43;color:#ffffff;">
        <div style="font-size:12px;letter-spacing:0.06em;text-transform:uppercase;opacity:0.75;margin-bottom:6px;">WowDashboard</div>
        <div style="font-size:22px;font-weight:700;line-height:1.25;">Daily ad spend</div>
        <div style="font-size:14px;margin-top:6px;opacity:0.9;">Report date: <strong>${escapeHtml(reportDate)}</strong> (IST)</div>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 24px 8px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fa;border-radius:8px;">
          <tr>
            <td style="padding:16px 18px;">
              <div style="font-size:12px;color:#627d98;text-transform:uppercase;letter-spacing:0.04em;">Total across platforms</div>
              <div style="font-size:28px;font-weight:800;color:#102a43;margin-top:4px;font-variant-numeric:tabular-nums;">${formatUsd(total, 0)}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:8px 24px 24px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
          <thead>
            <tr>
              <th align="left" style="padding:10px 14px;border-bottom:2px solid #d9e2ec;color:#627d98;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;">Platform</th>
              <th align="right" style="padding:10px 14px;border-bottom:2px solid #d9e2ec;color:#627d98;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;">Spend (USD)</th>
              <th align="right" style="padding:10px 14px;border-bottom:2px solid #d9e2ec;color:#627d98;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;">Share</th>
            </tr>
          </thead>
          <tbody>
            ${platformRows}
          </tbody>
          <tfoot>
            <tr>
              <td style="padding:14px 14px 4px;color:#102a43;font-size:14px;font-weight:700;">Total</td>
              <td style="padding:14px 14px 4px;text-align:right;color:#102a43;font-size:14px;font-weight:800;font-variant-numeric:tabular-nums;">${formatUsd(total, 2)}</td>
              <td style="padding:14px 14px 4px;text-align:right;color:#627d98;font-size:13px;">100%</td>
            </tr>
          </tfoot>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:14px 24px;background:#f5f7fa;border-top:1px solid #e8eef4;color:#829ab1;font-size:12px;line-height:1.5;">
        Automated digest from WowDashboard. Spend values are USD for the calendar day above (Asia/Kolkata).
      </td>
    </tr>
  </table>
</body>
</html>`;
}
