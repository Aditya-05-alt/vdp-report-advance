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
    _key: vehicleKey(row),
  };
}

async function fetchPeriod({
  clientId,
  from,
  to,
  make,
  condition,
  category,
  search,
  onCancelCheck,
}) {
  const qs = new URLSearchParams({
    clientId: String(clientId).trim(),
    from: String(from).slice(0, 10),
    to: String(to).slice(0, 10),
  });
  if (make && make !== 'all') qs.set('make', make);
  if (condition && condition !== 'all') qs.set('condition', condition);
  if (category && category !== 'all') qs.set('category', category);
  if (search) qs.set('search', search);

  const res = await fetch(`/api/dashboard/inventory-performance?${qs}`, {
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (onCancelCheck?.()) return [];
  if (!res.ok) {
    throw new Error(json.error || `Inventory performance failed (${res.status})`);
  }
  return (json.rows || []).map(normalizeRow);
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
  make = 'all',
  condition = 'all',
  category = 'all',
  search = '',
  onCancelCheck,
}) {
  if (!clientId || !from || !to) return { rows: [], makes: [], categories: [] };
  if (typeof window === 'undefined') {
    return { rows: [], makes: [], categories: [] };
  }
  if (onCancelCheck?.()) return { rows: [], makes: [], categories: [] };

  const filterOpts = { make, condition, category, search };

  const [current, prior, unfiltered] = await Promise.all([
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
      : Promise.resolve([]),
    // Unfiltered current period → populate Make / Category dropdowns
    make !== 'all' || category !== 'all' || condition !== 'all' || search
      ? fetchPeriod({
          clientId,
          from,
          to,
          make: 'all',
          condition: 'all',
          category: 'all',
          search: '',
          onCancelCheck,
        })
      : null,
  ]);

  if (onCancelCheck?.()) return { rows: [], makes: [], categories: [] };

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
      condition: row.condition,
      category: row.category,
      vdp1,
      vdp0,
      vdpmom: vdp0 > 0 ? ((vdp1 - vdp0) / vdp0) * 100 : vdp1 > 0 ? 100 : 0,
      uniq1: row.uniqueViews,
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

  return { rows, makes, categories };
}
