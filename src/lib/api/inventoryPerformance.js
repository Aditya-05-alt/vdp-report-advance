function vehicleKey(row) {
  const vin = String(row.inv_vin || '').trim();
  if (vin) return `vin:${vin.toLowerCase()}`;
  const stock = String(row.inv_stock_number || '').trim();
  if (stock) return `s:${stock.toLowerCase()}`;
  return [
    'v',
    String(row.inv_year || '').trim(),
    String(row.inv_make || '').trim().toLowerCase(),
    String(row.inv_model || '').trim().toLowerCase(),
    String(row.inv_condition || '').trim().toLowerCase(),
  ].join('|');
}

function normalizeRow(row) {
  const vin = String(row.inv_vin || '').trim();
  const stock = String(row.inv_stock_number || '').trim();
  // Prefer VIN; if empty, fall back to stock number — never show blank when stock exists
  const displayVin = vin || stock || '—';
  const channelViews =
    row.channel_views && typeof row.channel_views === 'object'
      ? Object.fromEntries(
          Object.entries(row.channel_views).map(([k, v]) => [
            k,
            Number(v) || 0,
          ])
        )
      : {};
  return {
    vin: displayVin,
    stock: stock || null,
    make: row.inv_make || 'Unknown',
    model: row.inv_model || 'Unknown',
    year: row.inv_year || '—',
    condition: row.inv_condition || 'Unknown',
    category: row.inv_category || 'Unknown',
    views: Number(row.views) || 0,
    uniqueViews: Number(row.unique_views) || 0,
    ageDays:
      row.age_days == null || Number.isNaN(Number(row.age_days))
        ? null
        : Number(row.age_days),
    channelViews,
    _key: vehicleKey(row),
  };
}

function csvList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v || '').trim()).filter(Boolean);
  }
  const s = String(value || '').trim();
  if (!s || s.toLowerCase() === 'all') return [];
  return s
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v && v.toLowerCase() !== 'all');
}

function csvParam(value) {
  const parts = csvList(value);
  return parts.length ? parts.join(',') : '';
}

async function fetchPeriod({
  clientId,
  from,
  to,
  make,
  condition,
  category,
  search,
  channel,
  onCancelCheck,
}) {
  const qs = new URLSearchParams({
    clientId: String(clientId).trim(),
    from: String(from).slice(0, 10),
    to: String(to).slice(0, 10),
  });
  const makeCsv = csvParam(make);
  const condCsv = csvParam(condition);
  const catCsv = csvParam(category);
  const channelCsv = csvParam(channel);
  if (makeCsv) qs.set('make', makeCsv);
  if (condCsv) qs.set('condition', condCsv);
  if (catCsv) qs.set('category', catCsv);
  if (search) qs.set('search', search);
  if (channelCsv) qs.set('channel', channelCsv);

  const res = await fetch(`/api/dashboard/inventory-performance?${qs}`, {
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (onCancelCheck?.()) return { rows: [], channels: [] };
  if (!res.ok) {
    throw new Error(json.error || `Inventory performance failed (${res.status})`);
  }
  return {
    rows: (json.rows || []).map(normalizeRow),
    channels: Array.isArray(json.channels) ? json.channels : [],
    channelColumns: Array.isArray(json.channelColumns) ? json.channelColumns : [],
  };
}

/**
 * Inventory performance for current (+ optional prior) period.
 * Uses get_inventory_performance_advance.
 */
export async function fetchInventoryPerformance({
  clientId,
  from,
  to,
  priorFrom,
  priorTo,
  make = [],
  condition = [],
  category = [],
  search = '',
  channel = [],
  onCancelCheck,
}) {
  if (!clientId || !from || !to) {
    return { rows: [], makes: [], categories: [], channels: [], channelColumns: [] };
  }
  if (typeof window === 'undefined') {
    return { rows: [], makes: [], categories: [], channels: [], channelColumns: [] };
  }
  if (onCancelCheck?.()) {
    return { rows: [], makes: [], categories: [], channels: [], channelColumns: [] };
  }

  const filterOpts = { make, condition, category, search, channel };

  const [currentRes, priorRes, unfilteredRes] = await Promise.all([
    fetchPeriod({
      clientId,
      from,
      to,
      ...filterOpts,
      onCancelCheck,
    }),
    priorFrom && priorTo
      ? fetchPeriod({
          clientId,
          from: priorFrom,
          to: priorTo,
          ...filterOpts,
          onCancelCheck,
        })
      : Promise.resolve({ rows: [], channels: [] }),
    // Unfiltered current period → populate Make / Category dropdowns
    csvList(make).length ||
    csvList(category).length ||
    csvList(condition).length ||
    search ||
    csvList(channel).length
      ? fetchPeriod({
          clientId,
          from,
          to,
          make: [],
          condition: [],
          category: [],
          search: '',
          channel: [],
          onCancelCheck,
        })
      : null,
  ]);

  if (onCancelCheck?.()) {
    return { rows: [], makes: [], categories: [], channels: [], channelColumns: [] };
  }

  const current = currentRes?.rows || [];
  const prior = priorRes?.rows || [];
  const unfiltered = unfilteredRes?.rows || null;
  const channels = [
    ...new Set([
      ...(currentRes?.channels || []),
      ...(unfilteredRes?.channels || []),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  // Prefer current-period channel column order (by traffic); fall back to unfiltered.
  const channelColumns =
    (currentRes?.channelColumns || []).length > 0
      ? currentRes.channelColumns
      : unfilteredRes?.channelColumns || [];

  const priorMap = new Map();
  for (const row of prior || []) {
    priorMap.set(row._key, row);
  }

  const rows = (current || []).map((row) => {
    const prev = priorMap.get(row._key);
    const vdp0 = prev?.views || 0;
    const vdp1 = row.views;
    return {
      vin: row.vin || row.stock || '—',
      stock: row.stock || null,
      make: row.make,
      model: row.model,
      year: row.year,
      age: row.ageDays == null ? null : row.ageDays,
      condition: row.condition,
      category: row.category,
      vdp1,
      vdp0,
      vdpmom: vdp0 > 0 ? ((vdp1 - vdp0) / vdp0) * 100 : vdp1 > 0 ? 100 : 0,
      uniq1: row.uniqueViews,
      channelViews: row.channelViews || {},
      _key: row._key,
    };
  });

  const optionSource = unfiltered || current || [];
  const makes = [
    ...new Set(optionSource.map((r) => r.make).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  const categories = [
    ...new Set(optionSource.map((r) => r.category).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));

  return { rows, makes, categories, channels, channelColumns };
}
