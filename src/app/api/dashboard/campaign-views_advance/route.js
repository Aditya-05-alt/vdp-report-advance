import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

function normalizeCells(rows) {
  return (rows || []).map((r) => ({
    report_date: String(r.report_date).split('T')[0],
    campaign: String(r.campaign || r.session_campaign || '(not set)').trim(),
    views: Number(r.views) || 0,
  }));
}

function ymd(d) {
  if (!d) return null;
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function daysInclusive(from, to) {
  const a = ymd(from);
  const b = ymd(to);
  if (!a || !b || a > b) return 0;
  const ms =
    Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.floor(ms / 86400000) + 1;
}

function maxYmd(a, b) {
  return a >= b ? a : b;
}

function minYmd(a, b) {
  return a <= b ? a : b;
}

/**
 * Cost from smart_campaign (Google Ads sync), keyed by campaign name.
 * Prorates cost when report_from/report_to only partially overlaps the UI range.
 */
async function fetchCampaignCosts(supabase, clientId, from, to) {
  const cid = String(clientId || '').trim();
  if (!cid || !from || !to) return new Map();

  const asNum = Number(cid);
  let query = supabase
    .from('smart_campaign')
    .select('name, cost, report_from, report_to, customer_id, client_id')
    .lte('report_from', to)
    .gte('report_to', from)
    .limit(5000);

  if (Number.isFinite(asNum) && asNum > 0) {
    query = query.or(`customer_id.eq.${asNum},client_id.eq.${cid}`);
  } else {
    query = query.eq('client_id', cid);
  }

  const { data, error } = await query;
  if (error) {
    console.warn('[campaign-views_advance] smart_campaign cost:', error.message);
    return new Map();
  }

  const byName = new Map();
  for (const row of data || []) {
    const name = String(row.name || '').trim();
    if (!name) continue;
    const reportFrom = ymd(row.report_from);
    const reportTo = ymd(row.report_to);
    const fullCost = Number(row.cost) || 0;
    if (!reportFrom || !reportTo || fullCost === 0) {
      byName.set(name, (byName.get(name) || 0) + fullCost);
      continue;
    }
    const overlapFrom = maxYmd(from, reportFrom);
    const overlapTo = minYmd(to, reportTo);
    const reportDays = daysInclusive(reportFrom, reportTo);
    const overlapDays = daysInclusive(overlapFrom, overlapTo);
    const share =
      reportDays > 0 && overlapDays > 0
        ? fullCost * (overlapDays / reportDays)
        : 0;
    byName.set(name, (byName.get(name) || 0) + share);
  }
  return byName;
}

/** Fallback when cells RPC / jsonb cells are missing — aggregate page rows in Node. */
async function fetchCellsFallback(supabase, clientId, from, to, pageType) {
  const pageSize = 1000;
  let fromIdx = 0;
  const agg = new Map();

  for (;;) {
    let q = supabase
      .from('smart_ga4_page_data')
      .select('report_date, session_campaign, views, ga4_page_type')
      .eq('client_id', clientId)
      .gte('report_date', from)
      .lte('report_date', to)
      .not('session_campaign', 'is', null)
      .or('session_campaign.like.WA|%,session_campaign.like.WA |%')
      .range(fromIdx, fromIdx + pageSize - 1);

    if (String(pageType).toUpperCase() === 'VDP') {
      q = q.ilike('ga4_page_type', 'VDP%');
    }

    const { data, error } = await q;
    if (error) throw error;
    if (!data?.length) break;

    for (const row of data) {
      const campaign = String(row.session_campaign || '').trim();
      if (!campaign.startsWith('WA|') && !campaign.startsWith('WA |')) continue;
      const report_date = String(row.report_date).split('T')[0];
      const key = `${report_date}||${campaign}`;
      agg.set(key, (agg.get(key) || 0) + (Number(row.views) || 0));
    }

    if (data.length < pageSize) break;
    fromIdx += pageSize;
    if (fromIdx > 200000) break;
  }

  return [...agg.entries()]
    .map(([key, views]) => {
      const [report_date, campaign] = key.split('||');
      return { report_date, campaign, views };
    })
    .filter((r) => r.views > 0);
}

/**
 * Dealer Campaign Views — WA| / WA | campaigns only via get_wa_campaign_views_advance.
 * GET /api/dashboard/campaign-views_advance?clientId=&from=&to=&pageType=ALL|VDP
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get('clientId')?.trim();
  const from = searchParams.get('from')?.slice(0, 10);
  const to = searchParams.get('to')?.slice(0, 10);
  const pageType = searchParams.get('pageType')?.trim() || 'ALL';

  if (!clientId || !from || !to) {
    return NextResponse.json(
      { error: 'Missing clientId, from, or to' },
      { status: 400 }
    );
  }

  if (
    clientId === '__all_dealer__' ||
    clientId.toLowerCase() === 'all' ||
    clientId.includes(',')
  ) {
    return NextResponse.json(
      { error: 'Pick one dealer. Campaign views are per client_id only.' },
      { status: 400 }
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return NextResponse.json(
      { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server' },
      { status: 503 }
    );
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const [mainRes, cellsRes, costMap] = await Promise.all([
      supabase.rpc('get_wa_campaign_views_advance', {
        p_client_id: clientId,
        p_from: from,
        p_to: to,
        p_page_type: pageType,
      }),
      supabase.rpc('get_wa_campaign_cells_advance', {
        p_client_id: clientId,
        p_from: from,
        p_to: to,
        p_page_type: pageType,
      }),
      fetchCampaignCosts(supabase, clientId, from, to),
    ]);

    if (mainRes.error) {
      const message = mainRes.error.message || 'get_wa_campaign_views_advance failed';
      const hint = /could not find|does not exist|PGRST202/i.test(message)
        ? ' Deploy supabase/rpc/get_wa_campaign_views_advance.sql in the Supabase SQL editor.'
        : /timeout|canceling statement/i.test(message)
          ? ' Try a shorter date range, or create idx_ga4_wa_campaign_client_date.'
          : '';
      return NextResponse.json({ error: message + hint }, { status: 500 });
    }

    const payload = mainRes.data && typeof mainRes.data === 'object' ? mainRes.data : {};
    const campaigns = Array.isArray(payload.campaigns) ? payload.campaigns : [];
    const daily = Array.isArray(payload.daily)
      ? payload.daily.map((r) => ({
          report_date: String(r.report_date).split('T')[0],
          views: Number(r.views) || 0,
        }))
      : [];

    let cells = [];
    let cellsSource = 'none';

    if (!cellsRes.error && Array.isArray(cellsRes.data) && cellsRes.data.length) {
      cells = normalizeCells(cellsRes.data);
      cellsSource = 'get_wa_campaign_cells_advance';
    } else if (Array.isArray(payload.cells) && payload.cells.length) {
      cells = normalizeCells(payload.cells);
      cellsSource = 'get_wa_campaign_views_advance.cells';
    } else {
      try {
        cells = await fetchCellsFallback(supabase, clientId, from, to, pageType);
        cellsSource = 'table-fallback';
      } catch (fallbackErr) {
        console.warn(
          '[campaign-views_advance] cells fallback failed:',
          fallbackErr?.message || fallbackErr
        );
      }
    }

    return NextResponse.json({
      campaigns: campaigns.map((r, i) => {
        const campaign = String(r.campaign || '(not set)').trim();
        const cost = costMap.get(campaign) || 0;
        return {
          campaign,
          views: Number(r.views) || 0,
          cost: Math.round(cost * 100) / 100,
          sessions: Number(r.sessions) || 0,
          total_users: Number(r.total_users) || 0,
          new_users: Number(r.new_users) || 0,
          pct: Number(r.pct) || 0,
          rank: Number(r.rank) || i + 1,
        };
      }),
      daily,
      cells,
      meta: {
        ...(payload.meta && typeof payload.meta === 'object' ? payload.meta : {}),
        source: 'get_wa_campaign_views_advance',
        costSource: 'smart_campaign',
        cellsSource,
        pageType,
        clientId,
        dealerScoped: true,
        prefix: 'WA| / WA |',
      },
    });
  } catch (err) {
    const message = err?.message || 'Failed to load campaign views';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
