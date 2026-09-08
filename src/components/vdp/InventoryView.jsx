'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '@/components/dashboard/ClientContext';
import { fetchInventoryPerformance } from '@/lib/api/inventoryPerformance';
import { fmt, pct, momClass, safeDiv } from '@/lib/vdp/aggregates';
import { isAllDealerClient } from '@/lib/dashboard/allDealers';
import VdpChart from './VdpChart';
import { VdpLoadingCard } from './VdpLoadingBanner';
import { useVdpDateRange } from './VdpDateRangeContext';
import { useSoftLoadPercent } from './useSoftLoadPercent';
import { Card, Kpi, Seg, Toolbar, ToolbarGroup } from './VdpUi';

const COND_OPTS = [
  { value: 'all', label: 'All' },
  { value: 'New', label: 'New' },
  { value: 'Used', label: 'Used' },
];

const PAGE_SIZE = 12;

function conditionClass(condition) {
  const c = String(condition || '').toLowerCase();
  if (c.startsWith('new')) return 'new';
  if (c.startsWith('used')) return 'used';
  return 'used';
}

export default function InventoryView() {
  const { client, loading: dealersLoading, isAllDealer } = useClient();
  const {
    from: curFrom,
    to: curTo,
    priorFrom: priFrom,
    priorTo: priTo,
    curLabel,
    priLabel,
  } = useVdpDateRange();
  const [make, setMake] = useState('all');
  const [cond, setCond] = useState('all');
  const [cat, setCat] = useState('all');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [sort, setSort] = useState({ k: 'vdp1', dir: -1 });
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState([]);
  const [makeOptions, setMakeOptions] = useState([]);
  const [catOptions, setCatOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const cancelRef = useRef(false);
  const loadGenRef = useRef(0);
  const searchTimer = useRef(null);

  const ga4Id = String(client?.ga4CustomerId || '').trim();
  const canLoad = Boolean(ga4Id) && !isAllDealerClient(client) && !isAllDealer;

  const load = useCallback(async () => {
    if (!canLoad || !curFrom || !curTo) {
      setRows([]);
      setMakeOptions([]);
      setCatOptions([]);
      return;
    }

    const loadGen = loadGenRef.current + 1;
    loadGenRef.current = loadGen;
    cancelRef.current = false;
    const isStale = () => cancelRef.current || loadGenRef.current !== loadGen;

    setLoading(true);
    setError(null);

    try {
      const result = await fetchInventoryPerformance({
        clientId: ga4Id,
        from: curFrom,
        to: curTo,
        priorFrom: priFrom,
        priorTo: priTo,
        make,
        condition: cond,
        category: cat,
        search,
        onCancelCheck: () => isStale(),
      });
      if (isStale()) return;
      setRows(result.rows || []);
      setMakeOptions(result.makes || []);
      setCatOptions(result.categories || []);
    } catch (err) {
      if (!isStale()) {
        setError(err?.message || 'Failed to load inventory performance.');
        setRows([]);
      }
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [canLoad, ga4Id, curFrom, curTo, priFrom, priTo, make, cond, cat, search]);

  useEffect(() => {
    if (dealersLoading) return undefined;
    load();
    return () => {
      cancelRef.current = true;
    };
  }, [dealersLoading, load]);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(0);
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchInput]);

  const sorted = useMemo(() => {
    const list = [...rows];
    list.sort((a, b) => {
      const av = a[sort.k];
      const bv = b[sort.k];
      if (typeof av === 'string') return av.localeCompare(bv) * sort.dir;
      return (av - bv) * sort.dir;
    });
    return list;
  }, [rows, sort]);

  const totalVdp1 = sorted.reduce((s, r) => s + r.vdp1, 0);
  const totalVdp0 = sorted.reduce((s, r) => s + r.vdp0, 0);
  const totalUniq = sorted.reduce((s, r) => s + r.uniq1, 0);
  const zeroView = sorted.filter((r) => r.vdp1 < 1).length;

  const makeNames = useMemo(() => {
    const fromRows = [...new Set(sorted.map((r) => r.make))];
    return (makeOptions.length ? makeOptions : fromRows).slice(0, 12);
  }, [sorted, makeOptions]);

  const makeData = useMemo(() => {
    const newByMake = makeNames.map((m) =>
      sorted
        .filter((r) => r.make === m && String(r.condition).toLowerCase().startsWith('new'))
        .reduce((s, r) => s + r.vdp1, 0)
    );
    const usedByMake = makeNames.map((m) =>
      sorted
        .filter((r) => r.make === m && String(r.condition).toLowerCase().startsWith('used'))
        .reduce((s, r) => s + r.vdp1, 0)
    );
    return {
      labels: makeNames,
      datasets: [
        { label: 'New', data: newByMake, backgroundColor: '#16a34a', borderRadius: 4 },
        { label: 'Used', data: usedByMake, backgroundColor: '#3730a3', borderRadius: 4 },
      ],
    };
  }, [sorted, makeNames]);

  const makeOptionsChart = useMemo(
    () => ({
      layout: { padding: { top: 4, right: 8, bottom: 0, left: 0 } },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { boxWidth: 12, boxHeight: 12, padding: 12, font: { size: 11 } },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { display: false },
          ticks: { font: { size: 10 }, color: '#64748b', maxRotation: 45 },
        },
        y: {
          stacked: true,
          grid: { color: 'rgba(148, 163, 184, 0.25)', drawBorder: false },
          border: { display: false },
          ticks: {
            color: '#64748b',
            font: { size: 11 },
            callback: (v) => fmt(v),
          },
        },
      },
    }),
    []
  );

  const catNames = useMemo(() => {
    const fromRows = [...new Set(sorted.map((r) => r.category))];
    return catOptions.length ? catOptions : fromRows;
  }, [sorted, catOptions]);

  const catData = useMemo(() => {
    const totals = catNames
      .map((c) => ({
        name: c,
        value: sorted
          .filter((r) => r.category === c)
          .reduce((s, r) => s + r.vdp1, 0),
      }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    const max = Math.max(...totals.map((r) => r.value), 1);
    return {
      labels: totals.map((r) => r.name),
      datasets: [
        {
          label: 'VDP Views',
          data: totals.map((r) => r.value),
          backgroundColor: totals.map((r) => {
            const t = r.value / max;
            return `rgba(8, 145, 178, ${0.45 + t * 0.5})`;
          }),
          borderColor: '#0e7490',
          borderWidth: 0,
          borderRadius: 8,
          borderSkipped: false,
          barThickness: 'flex',
          maxBarThickness: 28,
          categoryPercentage: 0.72,
          barPercentage: 0.9,
        },
      ],
    };
  }, [sorted, catNames]);

  const catOptionsChart = useMemo(
    () => ({
      indexAxis: 'y',
      layout: { padding: { top: 4, right: 28, bottom: 4, left: 0 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f172a',
          titleFont: { size: 12, weight: '600' },
          bodyFont: { size: 12 },
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => ` ${fmt(ctx.parsed.x)} VDP views`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(148, 163, 184, 0.25)', drawBorder: false },
          border: { display: false },
          ticks: {
            font: { size: 11 },
            color: '#64748b',
            callback: (v) => fmt(v),
            maxTicksLimit: 5,
          },
        },
        y: {
          grid: { display: false },
          border: { display: false },
          ticks: {
            font: { size: 11, weight: '500' },
            color: '#334155',
            autoSkip: false,
          },
        },
      },
    }),
    []
  );

  const start = page * PAGE_SIZE;
  const pageRows = sorted.slice(start, start + PAGE_SIZE);

  const onSort = (k) => {
    setSort((prev) => ({
      k,
      dir: prev.k === k ? -prev.dir : -1,
    }));
    setPage(0);
  };

  const resetPage = (fn) => (v) => {
    setPage(0);
    fn(v);
  };

  const isBusy = dealersLoading || loading;
  const loadPercent = useSoftLoadPercent(isBusy);

  if (!dealersLoading && (!client || isAllDealer || !ga4Id)) {
    return (
      <div className="vdp-view">
        <div className="vdp-card" style={{ padding: 20 }}>
          <h3>Select a dealer</h3>
          <div className="vdp-cardsub" style={{ marginBottom: 0 }}>
            Open All Dealers and click a dealer, or pick one from the dealer bar above.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`vdp-view${isBusy ? ' vdp-view--card-loading' : ''}`}>
      <VdpLoadingCard active={isBusy} percent={loadPercent} />
      <Toolbar>
        <ToolbarGroup label="Make">
          <select
            className="vdp-select"
            value={make}
            onChange={(e) => {
              setMake(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">All Makes</option>
            {makeOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </ToolbarGroup>
        <ToolbarGroup label="Condition">
          <Seg value={cond} options={COND_OPTS} onChange={resetPage(setCond)} />
        </ToolbarGroup>
        <ToolbarGroup label="Category">
          <select
            className="vdp-select"
            value={cat}
            onChange={(e) => {
              setCat(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">All Categories</option>
            {catOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </ToolbarGroup>
        <ToolbarGroup label="Search">
          <input
            type="text"
            className="vdp-search"
            placeholder="VIN, model..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </ToolbarGroup>
      </Toolbar>

      {error && (
        <div
          className="vdp-card"
          style={{
            marginBottom: 16,
            borderColor: '#fecaca',
            background: '#fef2f2',
            color: '#991b1b',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div className="vdp-kpi-grid">
        <Kpi
          label={`VDP Views · ${curLabel}`}
          value={fmt(totalVdp1)}
          delta={safeDiv(totalVdp1 - totalVdp0, totalVdp0) * 100}
          sub={`vs ${fmt(totalVdp0)} (${priLabel})`}
        />
        <Kpi
          label="Unique VDP Views"
          value={fmt(totalUniq)}
          sub={`${Math.floor(safeDiv(totalUniq, totalVdp1) * 100) || 0}% of total views`}
        />
        <Kpi
          label="Avg VDP Views / Vehicle"
          value={fmt(safeDiv(totalVdp1, sorted.length))}
          sub={`${sorted.length} vehicles in view`}
        />
        <Kpi
          label="Vehicles w/ 0 VDP Views"
          value={zeroView}
          sub={zeroView > 0 ? 'Consider repricing / photos' : 'All vehicles getting views'}
        />
      </div>

      <div className="vdp-grid-2 vdp-grid-2--inv">
        <Card
          className="vdp-card--chart"
          title="VDP Views by Make"
          sub="New vs. Used, current comparison period"
        >
          {!makeNames.length ? (
            <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
              No make data for these filters.
            </div>
          ) : (
            <VdpChart
              key={`inv-make-${curFrom}-${curTo}-${make}-${cond}-${makeNames.join('|')}`}
              type="bar"
              data={makeData}
              options={makeOptionsChart}
              fill
              animate
            />
          )}
        </Card>
        <Card
          className="vdp-card--chart"
          title="VDP Views by Category"
          sub="Current comparison period · top categories"
        >
          {!(catData.labels || []).length ? (
            <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
              No category data for these filters.
            </div>
          ) : (
            <VdpChart
              key={`inv-cat-${curFrom}-${curTo}-${cat}-${(catData.labels || []).join('|')}`}
              type="bar"
              data={catData}
              options={catOptionsChart}
              fill
              animate
            />
          )}
        </Card>
      </div>

      <Card
        title={
          <>
            Inventory Detail{' '}
            <span style={{ color: 'var(--vdp-muted)', fontWeight: 400, fontSize: 12 }}>
              ({sorted.length} vehicles)
            </span>
          </>
        }
        sub="Click a column header to sort. Data from get_inventory_performance_advance · smart_final_data"
      >
        <>
            <table className="vdp-table">
              <thead>
                <tr>
                  {[
                    ['vin', 'VIN'],
                    ['make', 'Make'],
                    ['model', 'Model'],
                    ['year', 'Year'],
                    ['condition', 'Cond.'],
                    ['category', 'Category'],
                    ['vdp1', 'VDP (Current)'],
                    ['vdp0', 'VDP (Prior)'],
                    ['vdpmom', 'MoM %'],
                    ['uniq1', 'Unique VDP'],
                  ].map(([k, label]) => (
                    <th
                      key={k}
                      className={`${['vdp1', 'vdp0', 'vdpmom', 'uniq1'].includes(k) ? 'right' : ''} ${sort.k === k ? 'sorted' : ''}`}
                      onClick={() => onSort(k)}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={10}
                      style={{
                        textAlign: 'center',
                        color: 'var(--vdp-muted)',
                        padding: 20,
                      }}
                    >
                      No vehicles match these filters
                    </td>
                  </tr>
                ) : (
                  pageRows.map((r) => (
                    <tr key={r._key}>
                      <td className="mono">{r.vin || r.stock || '—'}</td>
                      <td>{r.make}</td>
                      <td>{r.model}</td>
                      <td>{r.year}</td>
                      <td>
                        <span className={`vdp-tag ${conditionClass(r.condition)}`}>
                          {r.condition}
                        </span>
                      </td>
                      <td>{r.category}</td>
                      <td className="right mono">{fmt(r.vdp1)}</td>
                      <td className="right mono">{fmt(r.vdp0)}</td>
                      <td className={`right vdp-delta ${momClass(r.vdpmom / 100)}`}>
                        {r.vdp0 < 1 ? (r.vdp1 > 0 ? 'New' : '—') : pct(r.vdpmom)}
                      </td>
                      <td className="right mono">{fmt(r.uniq1)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <div className="vdp-pager">
              <span>
                {sorted.length
                  ? `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, sorted.length)} of ${sorted.length}`
                  : ''}
              </span>
              <div>
                <button
                  type="button"
                  disabled={page === 0}
                  onClick={() => setPage((n) => n - 1)}
                >
                  ← Prev
                </button>
                <button
                  type="button"
                  disabled={start + PAGE_SIZE >= sorted.length}
                  onClick={() => setPage((n) => n + 1)}
                >
                  Next →
                </button>
              </div>
            </div>
          </>
      </Card>
    </div>
  );
}
