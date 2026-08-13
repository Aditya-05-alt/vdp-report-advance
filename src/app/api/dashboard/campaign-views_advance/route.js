import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

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
    const { data, error } = await supabase.rpc('get_wa_campaign_views_advance', {
      p_client_id: clientId,
      p_from: from,
      p_to: to,
      p_page_type: pageType,
    });

    if (error) {
      const message = error.message || 'get_wa_campaign_views_advance failed';
      const hint = /could not find|does not exist|PGRST202/i.test(message)
        ? ' Deploy supabase/rpc/get_wa_campaign_views_advance.sql in the Supabase SQL editor.'
        : /timeout|canceling statement/i.test(message)
          ? ' Try a shorter date range, or create idx_ga4_wa_campaign_client_date.'
          : '';
      return NextResponse.json({ error: message + hint }, { status: 500 });
    }

    const payload = data && typeof data === 'object' ? data : {};
    const campaigns = Array.isArray(payload.campaigns) ? payload.campaigns : [];
    const daily = Array.isArray(payload.daily)
      ? payload.daily.map((r) => ({
          report_date: String(r.report_date).split('T')[0],
          views: Number(r.views) || 0,
        }))
      : [];

    return NextResponse.json({
      campaigns: campaigns.map((r, i) => ({
        campaign: String(r.campaign || '(not set)'),
        views: Number(r.views) || 0,
        sessions: Number(r.sessions) || 0,
        total_users: Number(r.total_users) || 0,
        new_users: Number(r.new_users) || 0,
        pct: Number(r.pct) || 0,
        rank: Number(r.rank) || i + 1,
      })),
      daily,
      meta: {
        ...(payload.meta && typeof payload.meta === 'object' ? payload.meta : {}),
        source: 'get_wa_campaign_views_advance',
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
