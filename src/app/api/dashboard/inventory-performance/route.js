import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

function trimStr(v) {
  return String(v ?? '').trim();
}

/** Display VIN: real VIN, else stock number — never blank when stock exists. */
function displayVin(row) {
  return trimStr(row.inv_vin) || trimStr(row.inv_stock_number) || null;
}

function needsVinEnrichment(rows) {
  if (!rows?.length) return false;
  const hasVinKey = Object.prototype.hasOwnProperty.call(rows[0], 'inv_vin');
  if (!hasVinKey) return true;
  // Enrich when any row is missing VIN but has a stock number we can look up
  return rows.some(
    (r) => !trimStr(r.inv_vin) && trimStr(r.inv_stock_number)
  );
}

async function lookupVinByStock(supabase, clientId, stockNumbers) {
  const vinByStock = new Map();
  const unique = [...new Set(stockNumbers.map(trimStr).filter(Boolean))];
  const chunkSize = 100;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('smart_final_data')
      .select('inv_stock_number, inv_vin')
      .eq('client_id', clientId)
      .in('inv_stock_number', chunk)
      .not('inv_vin', 'is', null)
      .neq('inv_vin', '');

    if (error) {
      console.error('[inventory-performance-advance] VIN lookup', error.message);
      break;
    }

    for (const row of data || []) {
      const stock = trimStr(row.inv_stock_number);
      const vin = trimStr(row.inv_vin);
      if (stock && vin && !vinByStock.has(stock)) {
        vinByStock.set(stock, vin);
      }
    }
  }

  return vinByStock;
}

function normalizeOutputRow(r) {
  const stock = trimStr(r.inv_stock_number) || null;
  const vin = displayVin({
    inv_vin: r.inv_vin,
    inv_stock_number: stock,
  });
  const ageDays =
    r.age_days == null || Number.isNaN(Number(r.age_days))
      ? null
      : Number(r.age_days);
  return {
    inv_vin: vin,
    inv_stock_number: stock,
    inv_make: r.inv_make,
    inv_model: r.inv_model,
    inv_year: r.inv_year,
    inv_condition: r.inv_condition,
    inv_category: r.inv_category,
    views: r.views,
    unique_views: r.unique_views,
    age_days: ageDays,
    channel_views: r.channel_views && typeof r.channel_views === 'object'
      ? r.channel_views
      : {},
  };
}

function vehicleMatchKey(vin, stock) {
  return (trimStr(vin) || trimStr(stock)).toUpperCase();
}

/**
 * Pivot RPC rows → { byKey: Map<vk, {channel: views}>, columns: string[] }.
 * Columns = channels with traffic, sorted by total views desc.
 */
function pivotChannelMatrix(matrixRows) {
  const byKey = new Map();
  const totals = new Map();

  for (const row of matrixRows || []) {
    const vk = vehicleMatchKey(row.inv_vin, row.inv_stock_number);
    const channel = trimStr(row.channel_bucket);
    const views = Number(row.views) || 0;
    if (!vk || !channel || views <= 0) continue;

    if (!byKey.has(vk)) byKey.set(vk, {});
    const bucket = byKey.get(vk);
    bucket[channel] = (bucket[channel] || 0) + views;
    totals.set(channel, (totals.get(channel) || 0) + views);
  }

  const columns = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);

  return { byKey, columns };
}

function attachChannelViews(rows, channelByKey) {
  return (rows || []).map((r) => {
    const vk = vehicleMatchKey(r.inv_vin, r.inv_stock_number);
    let channel_views = { ...(channelByKey.get(vk) || {}) };
    const target = Number(r.views) || 0;
    const keys = Object.keys(channel_views);
    const chSum = keys.reduce((s, k) => s + (Number(channel_views[k]) || 0), 0);

    // Keep channel columns consistent with VDP (Current) — fix rounding drift.
    if (keys.length && target > 0 && chSum > 0 && chSum !== target) {
      const scale = target / chSum;
      let allocated = 0;
      const scaled = {};
      keys.forEach((k, i) => {
        if (i === keys.length - 1) {
          scaled[k] = Math.max(0, target - allocated);
        } else {
          const n = Math.round((Number(channel_views[k]) || 0) * scale);
          scaled[k] = n;
          allocated += n;
        }
      });
      channel_views = scaled;
    }

    return { ...r, channel_views };
  });
}

function ymd(d) {
  if (!d) return null;
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** UTC today YYYY-MM-DD — used to extend age for vehicles still on lot. */
function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

/** Same formula as Vehicle Age: inclusive days first_seen → last_seen. */
function ageDaysFromSeen(firstSeen, lastSeen) {
  const first = ymd(firstSeen);
  const last = ymd(lastSeen);
  if (!first || !last || last < first) return null;
  const days =
    Math.round(
      (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) /
        86400000
    ) + 1;
  return days > 0 ? days : null;
}

function ageLookupKeys(vin, stock) {
  const keys = [];
  const v = trimStr(vin).toLowerCase();
  const s = trimStr(stock).toLowerCase();
  if (v) keys.push(`vin:${v}`);
  if (s) keys.push(`s:${s}`);
  return keys;
}

function chunkList(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Merge first/last seen for VIN/stock keys.
 * Accepts hoot/scrap (vin, stock_number, first_seen, last_seen) or final_data
 * (inv_*, report_date). report_date fills gaps when a link exists but
 * inv_first_seen / inv_last_seen were not copied onto the page row.
 */
function mergeAgeRow(byKey, row) {
  const vin = row.vin ?? row.inv_vin;
  const stock = row.stock_number ?? row.inv_stock_number;
  let first = ymd(row.first_seen ?? row.inv_first_seen);
  let last = ymd(row.last_seen ?? row.inv_last_seen);
  const report = ymd(row.report_date);
  if (!first && report) first = report;
  if (!last && report) last = report;
  if (!first || !last) return;
  const keys = ageLookupKeys(vin, stock);
  if (!keys.length) return;
  for (const key of keys) {
    const prev = byKey.get(key) || { first: null, last: null };
    if (!prev.first || first < prev.first) prev.first = first;
    if (!prev.last || last > prev.last) prev.last = last;
    byKey.set(key, prev);
  }
}

/** Live on-lot keys + which ones were synced/updated today. */
async function fetchLiveAgeKeys(supabase, clientId) {
  const liveKeys = new Set();
  const updatedTodayKeys = new Set();
  const cid = trimStr(clientId);
  if (!cid) return { liveKeys, updatedTodayKeys };

  const asOf = todayYmd();
  const { data, error } = await supabase
    .from('smart_hoot_inventory_live')
    .select('vin, stock_number, synced_at')
    .eq('ga4_customer_id', cid)
    .limit(8000);

  if (error) {
    console.warn(
      '[inventory-performance-advance] live age keys:',
      error.message
    );
    return { liveKeys, updatedTodayKeys };
  }

  for (const row of data || []) {
    const keys = ageLookupKeys(row.vin, row.stock_number);
    const syncedDay = ymd(row.synced_at);
    for (const key of keys) {
      liveKeys.add(key);
      // Live row present ⇒ treated as updated today when sync day is today
      // (or missing synced_at — feed is the current snapshot).
      if (!syncedDay || syncedDay === asOf) updatedTodayKeys.add(key);
    }
  }
  return { liveKeys, updatedTodayKeys };
}

async function fetchRowsByVinOrStock(
  supabase,
  table,
  select,
  idColumn,
  idValue,
  vins,
  stocks
) {
  const rows = [];
  for (const chunk of chunkList(vins, 150)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .eq(idColumn, idValue)
      .in('vin', chunk)
      .limit(5000);
    if (error) {
      console.warn(
        `[inventory-performance-advance] ${table} vin age:`,
        error.message
      );
      break;
    }
    rows.push(...(data || []));
  }
  for (const chunk of chunkList(stocks, 150)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .eq(idColumn, idValue)
      .in('stock_number', chunk)
      .limit(5000);
    if (error) {
      console.warn(
        `[inventory-performance-advance] ${table} stock age:`,
        error.message
      );
      break;
    }
    rows.push(...(data || []));
  }
  return rows;
}

/**
 * Age map for inventory rows:
 * 1) smart_final_data inv_first_seen/inv_last_seen (same source as vehicle link)
 * 2) hoot + scrap history for the VIN/stock (chunked — no 8k truncation)
 * 3) live on-lot extends last_seen → today
 * 4) live / identified vehicle with no history → 1d (never blank)
 */
async function fetchAgeDaysMap(supabase, clientId, inventoryRows) {
  const byKey = new Map();
  const cid = trimStr(clientId);
  if (!cid) return byKey;

  const vins = [];
  const stocks = [];
  const seenVin = new Set();
  const seenStock = new Set();
  for (const r of inventoryRows || []) {
    const vin = trimStr(r.inv_vin);
    const stock = trimStr(r.inv_stock_number);
    if (
      vin &&
      vin.toLowerCase() !== 'unassigned' &&
      !seenVin.has(vin.toLowerCase())
    ) {
      seenVin.add(vin.toLowerCase());
      vins.push(vin);
    }
    if (stock && !seenStock.has(stock.toLowerCase())) {
      seenStock.add(stock.toLowerCase());
      stocks.push(stock);
    }
  }

  const { data: cfg } = await supabase
    .from('smart_hoot_config')
    .select('customer_name')
    .eq('ga4_customer_id', cid)
    .limit(1)
    .maybeSingle();
  const dealerName = trimStr(cfg?.customer_name);

  const liveKeysPromise = fetchLiveAgeKeys(supabase, cid);

  const finalRows = [];
  for (const chunk of chunkList(vins, 150)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from('smart_final_data')
      .select(
        'inv_vin, inv_stock_number, inv_first_seen, inv_last_seen, report_date'
      )
      .eq('client_id', cid)
      .in('inv_vin', chunk)
      .limit(8000);
    if (error) {
      console.warn(
        '[inventory-performance-advance] final age vin:',
        error.message
      );
      break;
    }
    finalRows.push(...(data || []));
  }
  for (const chunk of chunkList(stocks, 150)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from('smart_final_data')
      .select(
        'inv_vin, inv_stock_number, inv_first_seen, inv_last_seen, report_date'
      )
      .eq('client_id', cid)
      .in('inv_stock_number', chunk)
      .limit(8000);
    if (error) {
      console.warn(
        '[inventory-performance-advance] final age stock:',
        error.message
      );
      break;
    }
    finalRows.push(...(data || []));
  }

  const [scrapRows, liveInfo, hootRows] = await Promise.all([
    fetchRowsByVinOrStock(
      supabase,
      'smart_scrap_inventory',
      'vin, stock_number, first_seen, last_seen',
      'customer_id',
      cid,
      vins,
      stocks
    ),
    liveKeysPromise,
    (async () => {
      if (!dealerName || (!vins.length && !stocks.length)) return [];
      const rows = [];
      for (const chunk of chunkList(vins, 150)) {
        if (!chunk.length) continue;
        const { data, error } = await supabase
          .from('smart_hoot_inventory')
          .select('vin, stock_number, first_seen, last_seen')
          .ilike('customer_name', dealerName)
          .in('vin', chunk)
          .limit(5000);
        if (error) {
          console.warn(
            '[inventory-performance-advance] hoot age vin:',
            error.message
          );
          break;
        }
        rows.push(...(data || []));
      }
      for (const chunk of chunkList(stocks, 150)) {
        if (!chunk.length) continue;
        const { data, error } = await supabase
          .from('smart_hoot_inventory')
          .select('vin, stock_number, first_seen, last_seen')
          .ilike('customer_name', dealerName)
          .in('stock_number', chunk)
          .limit(5000);
        if (error) {
          console.warn(
            '[inventory-performance-advance] hoot age stock:',
            error.message
          );
          break;
        }
        rows.push(...(data || []));
      }
      return rows;
    })(),
  ]);

  const { liveKeys, updatedTodayKeys } = liveInfo;

  for (const row of finalRows) mergeAgeRow(byKey, row);
  for (const row of hootRows) mergeAgeRow(byKey, row);
  for (const row of scrapRows) mergeAgeRow(byKey, row);

  const asOf = todayYmd();
  // Hoot/scrap last_seen today also counts as updated today.
  for (const [key, span] of byKey) {
    if (span.last === asOf) updatedTodayKeys.add(key);
  }

  let dealerMaxLast = null;
  for (const span of byKey.values()) {
    if (span.last && (!dealerMaxLast || span.last > dealerMaxLast)) {
      dealerMaxLast = span.last;
    }
  }

  const ageByKey = new Map();
  for (const [key, span] of byKey) {
    let last = span.last;
    const stillPresent =
      liveKeys.has(key) ||
      (liveKeys.size === 0 && dealerMaxLast && span.last === dealerMaxLast);
    if (stillPresent && asOf && (!last || asOf > last)) {
      last = asOf;
      updatedTodayKeys.add(key);
    }
    let days = ageDaysFromSeen(span.first, last);
    if (days == null) continue;
    // Updated today → never show 1d; keep age > 1.
    if (updatedTodayKeys.has(key) && days <= 1) days = 2;
    ageByKey.set(key, days);
  }

  for (const key of liveKeys) {
    if (!ageByKey.has(key)) {
      // Live / updated today with no history → 2d (not 1d).
      ageByKey.set(key, updatedTodayKeys.has(key) ? 2 : 1);
    }
  }

  // Stash updated-today set for attachAgeDays fallbacks.
  ageByKey._updatedTodayKeys = updatedTodayKeys;
  return ageByKey;
}

function attachAgeDays(rows, ageByKey) {
  const updatedTodayKeys = ageByKey?._updatedTodayKeys || new Set();
  return (rows || []).map((r) => {
    const vin = trimStr(r.inv_vin);
    if (vin.toLowerCase() === 'unassigned') {
      return { ...r, age_days: null };
    }
    const keys = ageLookupKeys(r.inv_vin, r.inv_stock_number);
    let age = null;
    let updatedToday = false;
    for (const key of keys) {
      if (updatedTodayKeys.has(key)) updatedToday = true;
      if (!ageByKey.has(key)) continue;
      const days = ageByKey.get(key);
      if (age == null || days > age) age = days;
    }
    // Identified vehicle with VDP/link but no feed history — never blank.
    if (age == null && keys.length) age = updatedToday ? 2 : 1;
    else if (updatedToday && age != null && age <= 1) age = 2;
    return { ...r, age_days: age };
  });
}

/** Normalize GA4 channel labels (Paid Search / paid_search → Paid Search). */
function displayChannelName(raw) {
  const key = trimStr(raw)
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!key) return null;
  return key
    .split(' ')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

async function fetchChannelOptions(supabase, clientId, from, to) {
  const { data, error } = await supabase
    .from('smart_ga4_page_data')
    .select('channel')
    .eq('client_id', clientId)
    .gte('report_date', from)
    .lte('report_date', to)
    .or('vdp_conditions.eq.true,ga4_page_type.ilike.VDP%')
    .not('channel', 'is', null)
    .neq('channel', '')
    .limit(8000);

  if (error) {
    console.warn('[inventory-performance-advance] channels:', error.message);
    return [];
  }

  const set = new Set();
  for (const row of data || []) {
    const name = displayChannelName(row.channel);
    if (name) set.add(name);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function listParam(raw) {
  if (!raw) return null;
  const parts = String(raw)
    .split(',')
    .map((v) => trimStr(v))
    .filter((v) => v && v.toLowerCase() !== 'all');
  return parts.length ? parts.join(',') : null;
}

function channelListParam(raw) {
  if (!raw) return null;
  const parts = String(raw)
    .split(',')
    .map((v) => displayChannelName(v) || trimStr(v))
    .filter((v) => v && v.toLowerCase() !== 'all');
  return parts.length ? parts.join(',') : null;
}

/** Inventory performance vehicles — get_inventory_performance_advance (+ VIN enrich). */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get('clientId')?.trim();
  const from = searchParams.get('from')?.slice(0, 10);
  const to = searchParams.get('to')?.slice(0, 10);
  const make = listParam(searchParams.get('make'));
  const condition = listParam(searchParams.get('condition'));
  const category = listParam(searchParams.get('category'));
  const search = searchParams.get('search')?.trim() || null;
  const channel = channelListParam(searchParams.get('channel'));

  if (!clientId || !from || !to) {
    return NextResponse.json(
      { error: 'Missing clientId, from, or to' },
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

  const [rpcRes, channelMatrixRes, channels] = await Promise.all([
    supabase.rpc('get_inventory_performance_advance', {
      p_client_id: clientId,
      p_from: from,
      p_to: to,
      p_make: make,
      p_condition: condition,
      p_category: category,
      p_search: search || null,
      p_channel: channel,
    }),
    supabase.rpc('get_inventory_channel_matrix_advance', {
      p_client_id: clientId,
      p_from: from,
      p_to: to,
      p_make: make,
      p_condition: condition,
      p_category: category,
      p_search: search || null,
    }),
    fetchChannelOptions(supabase, clientId, from, to),
  ]);

  if (rpcRes.error) {
    console.error('[inventory-performance-advance]', rpcRes.error.message);
    return NextResponse.json({ error: rpcRes.error.message }, { status: 500 });
  }

  if (channelMatrixRes.error) {
    console.warn(
      '[inventory-performance-advance] channel matrix:',
      channelMatrixRes.error.message
    );
  }

  let rows = rpcRes.data ?? [];
  const { byKey: channelByKey, columns: channelColumns } = pivotChannelMatrix(
    channelMatrixRes.data || []
  );

  // Older deployed RPC may omit stock / leave VIN null — enrich + always coalesce.
  if (needsVinEnrichment(rows)) {
    const vinByStock = await lookupVinByStock(
      supabase,
      clientId,
      rows.map((r) => r.inv_stock_number)
    );
    rows = rows.map((r) => {
      const stock = trimStr(r.inv_stock_number);
      const vin =
        trimStr(r.inv_vin) || vinByStock.get(stock) || stock || '';
      return {
        ...r,
        inv_vin: vin || null,
        inv_stock_number: stock || null,
      };
    });
  }

  const ageByKey = await fetchAgeDaysMap(supabase, clientId, rows);
  rows = attachChannelViews(rows, channelByKey);
  rows = attachAgeDays(rows, ageByKey).map(normalizeOutputRow);

  return NextResponse.json({ rows, channels, channelColumns });
}
