import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import {
  INVENTORY_DOWNLOAD_HEADERS,
  INVENTORY_DOWNLOAD_HEADERS_DATED,
  inventoryRowToCsvLine,
  buildInventoryDownloadFilename,
} from '@/lib/inventory/inventoryDownload';

export const maxDuration = 120;

/** Keep at/below PostgREST max_rows (usually 1000) to avoid truncated pages. */
const PAGE = 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const HOOT_DAILY_COLS =
  'pull_date,vin,url,advertiser,make,model,year,price,condition,customer_name,location,msrp,type_,trim,stock_number,last_seen,snapshotted_at';
const SCRAP_DAILY_COLS =
  'pull_date,vin,url,advertiser,make,model,year,price,condition,customer_name,customer_id,location,msrp,type_,trim,stock_number,last_seen,snapshotted_at';

function supabaseService() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function normalizeClientIds(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseDate(raw) {
  const v = String(raw || '').slice(0, 10);
  return DATE_RE.test(v) ? v : null;
}

async function fetchPaged(queryFactory) {
  const rows = [];
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

/**
 * Inventory is a point-in-time snapshot. For a range, use the latest pull_date
 * available within [from, to] so a month is ~1 day of rows (not 30×).
 */
async function resolveAsOfPullDate(supabase, { logTable, dailyTable, from, to }) {
  if (from === to) return from;

  const logAttempt = await supabase
    .from(logTable)
    .select('pull_date')
    .gte('pull_date', from)
    .lte('pull_date', to)
    .order('pull_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!logAttempt.error && logAttempt.data?.pull_date) {
    return String(logAttempt.data.pull_date).slice(0, 10);
  }

  const dailyAttempt = await supabase
    .from(dailyTable)
    .select('pull_date')
    .gte('pull_date', from)
    .lte('pull_date', to)
    .order('pull_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (dailyAttempt.error) throw new Error(dailyAttempt.error.message);
  if (!dailyAttempt.data?.pull_date) return null;
  return String(dailyAttempt.data.pull_date).slice(0, 10);
}

async function resolveHootCustomerNames(supabase, clientIds) {
  if (!clientIds.length) return [];
  const { data, error } = await supabase
    .from('smart_hoot_config')
    .select('customer_name, ga4_customer_id')
    .in('ga4_customer_id', clientIds);
  if (error) throw new Error(error.message);
  return [
    ...new Set(
      (data || [])
        .map((r) => String(r.customer_name || '').trim())
        .filter(Boolean)
    ),
  ];
}

async function loadClientIdByName(supabase, clientIds, scopeAll) {
  let q = supabase
    .from('smart_hoot_config')
    .select('customer_name, ga4_customer_id');
  if (!scopeAll && clientIds.length) {
    q = q.in('ga4_customer_id', clientIds);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return new Map(
    (data || [])
      .filter((r) => r.customer_name && r.ga4_customer_id)
      .map((r) => [
        String(r.customer_name).trim(),
        String(r.ga4_customer_id).trim(),
      ])
  );
}

function mapHootLiveRow(r) {
  return {
    source: 'Hoot',
    dealerName: r.customer_name || '',
    clientId: r.ga4_customer_id || '',
    vin: r.vin || '',
    stockNumber: r.stock_number || '',
    year: r.year || '',
    make: r.make || '',
    model: r.model || '',
    trim: r.trim || '',
    condition: r.condition || '',
    type: r.type_ || '',
    price: r.price ?? '',
    msrp: r.msrp ?? '',
    location: r.location || '',
    url: r.url || '',
    advertiser: r.advertiser || '',
    syncedAt: r.synced_at || '',
    pullDate: '',
  };
}

function mapScrapLiveRow(r) {
  return {
    source: 'Scrap',
    dealerName: r.customer_name || '',
    clientId: r.customer_id || '',
    vin: r.vin || '',
    stockNumber: r.stock_number || '',
    year: r.year || '',
    make: r.make || '',
    model: r.model || '',
    trim: r.trim || '',
    condition: r.condition || '',
    type: r.type_ || '',
    price: r.price ?? '',
    msrp: r.msrp ?? '',
    location: r.location || '',
    url: r.url || '',
    advertiser: r.advertiser || '',
    syncedAt: r.last_seen || r.updated_at || '',
    pullDate: '',
  };
}

function mapHootDailyRow(r, clientIdByName) {
  const name = r.customer_name || '';
  return {
    source: 'Hoot',
    dealerName: name,
    clientId: clientIdByName.get(name) || '',
    vin: r.vin || '',
    stockNumber: r.stock_number || '',
    year: r.year || '',
    make: r.make || '',
    model: r.model || '',
    trim: r.trim || '',
    condition: r.condition || '',
    type: r.type_ || '',
    price: r.price ?? '',
    msrp: r.msrp ?? '',
    location: r.location || '',
    url: r.url || '',
    advertiser: r.advertiser || '',
    syncedAt: r.snapshotted_at || r.last_seen || '',
    pullDate: r.pull_date || '',
  };
}

function mapScrapDailyRow(r) {
  return {
    source: 'Scrap',
    dealerName: r.customer_name || '',
    clientId: r.customer_id || '',
    vin: r.vin || '',
    stockNumber: r.stock_number || '',
    year: r.year || '',
    make: r.make || '',
    model: r.model || '',
    trim: r.trim || '',
    condition: r.condition || '',
    type: r.type_ || '',
    price: r.price ?? '',
    msrp: r.msrp ?? '',
    location: r.location || '',
    url: r.url || '',
    advertiser: r.advertiser || '',
    syncedAt: r.snapshotted_at || r.last_seen || '',
    pullDate: r.pull_date || '',
  };
}

async function fetchHootDaily(supabase, { asOf, names }) {
  return fetchPaged((start, end) => {
    let q = supabase
      .from('smart_hoot_inventory_daily')
      .select(HOOT_DAILY_COLS)
      .eq('pull_date', asOf)
      .order('customer_name', { ascending: true })
      .order('sk', { ascending: true })
      .range(start, end);
    if (names?.length) q = q.in('customer_name', names);
    return q;
  });
}

async function fetchScrapDaily(supabase, { asOf, clientIds, scopeAll }) {
  return fetchPaged((start, end) => {
    let q = supabase
      .from('smart_scrap_inventory_daily')
      .select(SCRAP_DAILY_COLS)
      .eq('pull_date', asOf)
      .order('customer_id', { ascending: true })
      .order('sk', { ascending: true })
      .range(start, end);
    if (!scopeAll) q = q.in('customer_id', clientIds);
    return q;
  });
}

/**
 * Download inventory from live tables, or one daily snapshot when from/to are set.
 * Date ranges use the latest available pull_date within [from, to] (as-of),
 * not every day in the range — keeps month downloads as fast as one day.
 *
 * Query: scope=all|ids&clientIds=a,b&source=both|hoot|scrap&from=&to=
 */
export async function GET(request) {
  const supabase = supabaseService();
  if (!supabase) {
    return NextResponse.json(
      { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server' },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(request.url);
  const scope = String(searchParams.get('scope') || 'ids').toLowerCase();
  const source = String(searchParams.get('source') || 'both').toLowerCase();
  const clientIds = normalizeClientIds(searchParams.get('clientIds'));
  const from = parseDate(searchParams.get('from'));
  const to = parseDate(searchParams.get('to'));
  const wantHoot = source === 'both' || source === 'hoot';
  const wantScrap = source === 'both' || source === 'scrap';
  const useDaily = Boolean(from && to);
  const scopeAll = scope === 'all';

  if (!scopeAll && !clientIds.length) {
    return NextResponse.json(
      { error: 'Provide scope=all or clientIds for scope=ids' },
      { status: 400 }
    );
  }
  if ((from && !to) || (!from && to)) {
    return NextResponse.json(
      { error: 'Provide both from and to (YYYY-MM-DD), or neither' },
      { status: 400 }
    );
  }
  if (from && to && from > to) {
    return NextResponse.json(
      { error: `Invalid date range: ${from} .. ${to}` },
      { status: 400 }
    );
  }

  try {
    if (!useDaily) {
      const tasks = [];
      if (wantHoot) {
        tasks.push(
          fetchPaged((start, end) => {
            let q = supabase
              .from('smart_hoot_inventory_live')
              .select(
                'vin,url,advertiser,make,model,year,price,condition,customer_name,ga4_customer_id,location,msrp,type_,trim,stock_number,synced_at'
              )
              .order('ga4_customer_id', { ascending: true })
              .order('sk', { ascending: true })
              .range(start, end);
            if (!scopeAll) q = q.in('ga4_customer_id', clientIds);
            return q;
          }).then((rows) => rows.map(mapHootLiveRow))
        );
      }
      if (wantScrap) {
        tasks.push(
          fetchPaged((start, end) => {
            let q = supabase
              .from('smart_scrap_inventory')
              .select(
                'vin,url,advertiser,make,model,year,price,condition,customer_name,customer_id,location,msrp,type_,trim,stock_number,last_seen,updated_at'
              )
              .order('customer_id', { ascending: true })
              .order('sk', { ascending: true })
              .range(start, end);
            if (!scopeAll) q = q.in('customer_id', clientIds);
            return q;
          }).then((rows) => rows.map(mapScrapLiveRow))
        );
      }
      const chunks = await Promise.all(tasks);
      const out = chunks.flat();
      return csvResponse(out, {
        useDaily: false,
        scopeAll,
        clientIds,
        wantHoot,
        wantScrap,
        from,
        to,
      });
    }

    // Resolve one as-of snapshot day per source (in parallel), then fetch that day only.
    const [hootAsOf, scrapAsOf] = await Promise.all([
      wantHoot
        ? resolveAsOfPullDate(supabase, {
            logTable: 'smart_hoot_inventory_daily_log',
            dailyTable: 'smart_hoot_inventory_daily',
            from,
            to,
          })
        : Promise.resolve(null),
      wantScrap
        ? resolveAsOfPullDate(supabase, {
            logTable: 'smart_scrap_inventory_daily_log',
            dailyTable: 'smart_scrap_inventory_daily',
            from,
            to,
          })
        : Promise.resolve(null),
    ]);

    if (wantHoot && !hootAsOf && wantScrap && !scrapAsOf) {
      return NextResponse.json(
        {
          error: `No inventory snapshots found between ${from} and ${to}`,
        },
        { status: 404 }
      );
    }

    let names = null;
    let clientIdByName = new Map();
    if (wantHoot && hootAsOf) {
      if (!scopeAll) {
        names = await resolveHootCustomerNames(supabase, clientIds);
        if (!names.length && !wantScrap) {
          throw new Error(
            'No Hoot dealers found for the selected GA4 customer IDs'
          );
        }
      }
      if (scopeAll || names?.length) {
        clientIdByName = await loadClientIdByName(supabase, clientIds, scopeAll);
      }
    }

    const dailyTasks = [];
    if (wantHoot && hootAsOf && (scopeAll || names?.length)) {
      dailyTasks.push(
        fetchHootDaily(supabase, { asOf: hootAsOf, names }).then((rows) =>
          rows.map((r) => mapHootDailyRow(r, clientIdByName))
        )
      );
    }
    if (wantScrap && scrapAsOf) {
      dailyTasks.push(
        fetchScrapDaily(supabase, {
          asOf: scrapAsOf,
          clientIds,
          scopeAll,
        }).then((rows) => rows.map(mapScrapDailyRow))
      );
    }

    const chunks = await Promise.all(dailyTasks);
    const out = chunks.flat();

    if (!out.length) {
      return NextResponse.json(
        {
          error: `No inventory rows for snapshot${
            hootAsOf || scrapAsOf
              ? ` on ${[hootAsOf, scrapAsOf].filter(Boolean).join(' / ')}`
              : ''
          } in ${from} → ${to}`,
        },
        { status: 404 }
      );
    }

    const asOfLabel = [hootAsOf, scrapAsOf].filter(Boolean).sort().at(-1) || to;

    return csvResponse(out, {
      useDaily: true,
      scopeAll,
      clientIds,
      wantHoot,
      wantScrap,
      from,
      to,
      asOf: asOfLabel,
      hootAsOf,
      scrapAsOf,
    });
  } catch (err) {
    console.error('[inventory-download]', err?.message || err);
    return NextResponse.json(
      { error: err?.message || 'Failed to build inventory download' },
      { status: 500 }
    );
  }
}

function csvResponse(
  out,
  {
    useDaily,
    scopeAll,
    clientIds,
    wantHoot,
    wantScrap,
    from,
    to,
    asOf,
    hootAsOf,
    scrapAsOf,
  }
) {
  const headers = useDaily
    ? INVENTORY_DOWNLOAD_HEADERS_DATED
    : INVENTORY_DOWNLOAD_HEADERS;
  const lines = [
    headers.join(','),
    ...out.map((row) => inventoryRowToCsvLine(row, { includePullDate: useDaily })),
  ];
  const csv = `${lines.join('\n')}\n`;
  const filename = buildInventoryDownloadFilename({
    scopeLabel: scopeAll
      ? 'all-dealers-inventory'
      : `inventory-${clientIds.length}-dealers`,
    source: wantHoot && wantScrap ? 'both' : wantHoot ? 'hoot' : 'scrap',
    from: asOf || from,
    to: asOf || to,
  });

  const responseHeaders = {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
    'X-Row-Count': String(out.length),
  };
  if (asOf) responseHeaders['X-Inventory-As-Of'] = asOf;
  if (hootAsOf) responseHeaders['X-Hoot-As-Of'] = hootAsOf;
  if (scrapAsOf) responseHeaders['X-Scrap-As-Of'] = scrapAsOf;

  return new NextResponse(csv, {
    status: 200,
    headers: responseHeaders,
  });
}
