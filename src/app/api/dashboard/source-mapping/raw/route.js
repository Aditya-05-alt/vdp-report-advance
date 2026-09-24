import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

const SOFT_DEADLINE_MS = 25_000;
const CONCURRENCY = 4;

function mapRows(data) {
  return (data || []).map((r) => ({
    id: `${String(r.raw_source || '').toLowerCase()}|||${String(r.raw_medium || '').toLowerCase()}`,
    rawSource: r.raw_source,
    rawMedium: r.raw_medium,
    rawChannel: r.raw_channel || r.channel || '(not set)',
    pageViews: Number(r.page_views) || 0,
    vdpViews: Number(r.vdp_views) || 0,
  }));
}

function mergeMappedRows(lists) {
  const map = new Map();
  for (const rows of lists) {
    for (const r of rows || []) {
      if (!r?.id) continue;
      const prev = map.get(r.id);
      if (!prev) {
        map.set(r.id, { ...r });
      } else {
        prev.pageViews += Number(r.pageViews) || 0;
        prev.vdpViews += Number(r.vdpViews) || 0;
        if (
          (!prev.rawChannel || prev.rawChannel === '(not set)') &&
          r.rawChannel
        ) {
          prev.rawChannel = r.rawChannel;
        }
      }
    }
  }
  return [...map.values()].sort(
    (a, b) =>
      b.pageViews - a.pageViews ||
      String(a.rawSource).localeCompare(String(b.rawSource))
  );
}

async function fetchOneDealer(supabase, clientId, from, to) {
  const { data, error } = await supabase.rpc(
    'get_raw_source_medium_traffic_advance',
    {
      p_client_id: clientId,
      p_from: from,
      p_to: to,
    }
  );
  if (error) throw new Error(error.message);
  return mapRows(data);
}

async function fetchDealersWithDeadline(supabase, ids, from, to, deadlineMs) {
  const started = Date.now();
  const results = [];
  let cursor = 0;
  let completed = 0;
  let failed = 0;

  async function worker() {
    while (Date.now() - started < deadlineMs) {
      const i = cursor++;
      if (i >= ids.length) return;
      try {
        results.push(await fetchOneDealer(supabase, ids[i], from, to));
        completed += 1;
      } catch {
        failed += 1;
      }
    }
  }

  const n = Math.min(CONCURRENCY, Math.max(1, ids.length));
  await Promise.all(Array.from({ length: n }, () => worker()));

  return {
    rows: mergeMappedRows(results),
    completed,
    failed,
    total: ids.length,
    partial: completed + failed < ids.length || failed > 0,
    ms: Date.now() - started,
  };
}

/** Raw source/medium preview for Source Mapping. */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get('clientId')?.trim();
  const clientIdsParam = searchParams.get('clientIds')?.trim();
  const allDealers = searchParams.get('allDealers') === '1';
  const from = searchParams.get('from')?.slice(0, 10);
  const to = searchParams.get('to')?.slice(0, 10);

  if (!from || !to) {
    return NextResponse.json({ error: 'Missing from or to' }, { status: 400 });
  }

  const clientIds = clientIdsParam
    ? [...new Set(clientIdsParam.split(',').map((s) => s.trim()).filter(Boolean))]
    : [];

  const useMulti = allDealers || clientIds.length > 1;
  if (!useMulti && !clientId && clientIds.length !== 1) {
    return NextResponse.json(
      { error: 'Missing clientId, clientIds, or allDealers=1' },
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
    db: { max_rows: 20000 },
  });

  try {
    // Single dealer — direct indexed RPC.
    if (!useMulti && !allDealers) {
      const singleId = clientId || clientIds[0];
      const rows = await fetchOneDealer(supabase, singleId, from, to);
      return NextResponse.json({ rows, source: 'single' });
    }

    let ids = clientIds;
    if (allDealers && !ids.length) {
      const { data: dealers, error: dErr } = await supabase
        .from('smart_hoot_config')
        .select('ga4_customer_id')
        .eq('is_active', true)
        .not('ga4_customer_id', 'is', null);
      if (dErr) throw new Error(dErr.message);
      ids = [
        ...new Set(
          (dealers || [])
            .map((d) => String(d.ga4_customer_id || '').trim())
            .filter(Boolean)
        ),
      ];
    }
    if (!ids.length && clientId) ids = [clientId];
    if (!ids.length) return NextResponse.json({ rows: [] });

    // Fast path: daily cache table (smart_ga4_src_med_daily_advance).
    const bulk = await supabase.rpc(
      'get_raw_source_medium_traffic_bulk_advance',
      {
        p_from: from,
        p_to: to,
        p_client_ids: ids,
      }
    );

    if (!bulk.error && Array.isArray(bulk.data) && bulk.data.length > 0) {
      return NextResponse.json({
        rows: mapRows(bulk.data),
        source: 'cache',
      });
    }

    // Slow path fallback — soft deadline so proxy never returns opaque 500.
    console.warn(
      '[source-mapping/raw] cache miss/empty, concurrent fallback:',
      bulk.error?.message || 'empty'
    );
    const out = await fetchDealersWithDeadline(
      supabase,
      ids,
      from,
      to,
      SOFT_DEADLINE_MS
    );

    if (!out.rows.length && out.completed === 0) {
      return NextResponse.json(
        {
          error:
            bulk.error?.message ||
            'No source/medium data available yet. Try a single dealer, or wait for cache backfill.',
        },
        { status: 503 }
      );
    }

    return NextResponse.json({
      rows: out.rows,
      source: 'concurrent',
      partial: out.partial,
      completed: out.completed,
      total: out.total,
      ms: out.ms,
    });
  } catch (err) {
    console.error('[source-mapping/raw]', err?.message || err);
    return NextResponse.json(
      { error: err?.message || 'Failed to load raw sources' },
      { status: 500 }
    );
  }
}
