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

function matchVk(vin, stock) {
  return String(vin || stock || '')
    .trim()
    .toUpperCase();
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
  lite = false,
  channelsOnly = false,
  onCancelCheck,
  signal,
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
  if (lite) qs.set('lite', '1');
  if (channelsOnly) qs.set('channelsOnly', '1');

  const res = await fetch(`/api/dashboard/inventory-performance?${qs}`, {
    credentials: 'same-origin',
    signal,
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
    channelMatrix: Array.isArray(json.channelMatrix) ? json.channelMatrix : [],
  };
}

function mapRowsWithPrior(current, prior) {
  const priorMap = new Map();
  for (const row of prior || []) {
    priorMap.set(row._key, row);
  }

  return (current || []).map((row) => {
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
}

function optionLists(rows) {
  const makes = [
    ...new Set((rows || []).map((r) => r.make).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  const categories = [
    ...new Set((rows || []).map((r) => r.category).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  return { makes, categories };
}

/**
 * Inventory performance — paint current period ASAP (~3s target for big dealers).
 * Prior MoM + channel columns fill in the background without blocking first paint.
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
  onCoreReady,
  onUpdate,
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
  const needUnfiltered =
    csvList(make).length ||
    csvList(category).length ||
    csvList(condition).length ||
    search ||
    csvList(channel).length;

  // 1) Current period only — this is what blocks the spinner.
  const currentRes = await fetchPeriod({
    clientId,
    from,
    to,
    ...filterOpts,
    onCancelCheck,
  });
  if (onCancelCheck?.()) {
    return { rows: [], makes: [], categories: [], channels: [], channelColumns: [] };
  }

  let rows = mapRowsWithPrior(currentRes.rows || [], []);
  let { makes, categories } = optionLists(currentRes.rows || []);

  const corePayload = {
    rows,
    makes,
    categories,
    channels: [],
    channelColumns: [],
  };
  onCoreReady?.(corePayload);
  onUpdate?.(corePayload);

  // 2) Background: prior MoM + filter option lists + channel columns.
  const bg = [];

  if (priorFrom && priorTo) {
    bg.push(
      fetchPeriod({
        clientId,
        from: priorFrom,
        to: priorTo,
        ...filterOpts,
        lite: true,
        onCancelCheck,
      }).then((priorRes) => {
        if (onCancelCheck?.()) return;
        rows = mapRowsWithPrior(currentRes.rows || [], priorRes.rows || []);
        onUpdate?.({
          rows,
          makes,
          categories,
          channels: corePayload.channels,
          channelColumns: corePayload.channelColumns,
        });
      })
    );
  }

  if (needUnfiltered) {
    bg.push(
      fetchPeriod({
        clientId,
        from,
        to,
        make: [],
        condition: [],
        category: [],
        search: '',
        channel: [],
        lite: true,
        onCancelCheck,
      }).then((unfilteredRes) => {
        if (onCancelCheck?.()) return;
        const opts = optionLists(unfilteredRes.rows || []);
        makes = opts.makes;
        categories = opts.categories;
        onUpdate?.({
          rows,
          makes,
          categories,
          channels: corePayload.channels,
          channelColumns: corePayload.channelColumns,
        });
      })
    );
  }

  bg.push(
    fetchPeriod({
      clientId,
      from,
      to,
      ...filterOpts,
      channelsOnly: true,
      onCancelCheck,
    })
      .then((chRes) => {
        if (onCancelCheck?.()) return;
        const channels = chRes.channels || [];
        const channelColumns = chRes.channelColumns || [];
        corePayload.channels = channels;
        corePayload.channelColumns = channelColumns;
        const byVk = new Map(
          (chRes.channelMatrix || []).map((m) => [
            String(m.vk || ''),
            m.channel_views || {},
          ])
        );
        if (byVk.size) {
          rows = rows.map((r) => {
            const vk = matchVk(r.vin, r.stock);
            const channelViews = byVk.get(vk) || r.channelViews || {};
            return { ...r, channelViews };
          });
        }
        onUpdate?.({ rows, makes, categories, channels, channelColumns });
      })
      .catch(() => {
        /* channels optional */
      })
  );

  await Promise.allSettled(bg);
  if (onCancelCheck?.()) {
    return { rows: [], makes: [], categories: [], channels: [], channelColumns: [] };
  }

  return {
    rows,
    makes,
    categories,
    channels: corePayload.channels,
    channelColumns: corePayload.channelColumns,
  };
}
