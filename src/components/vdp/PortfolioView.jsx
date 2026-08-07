'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useClient } from '@/components/dashboard/ClientContext';
import {
  fetchAllDealersChannelMatrix,
  sliceMapForRow,
} from '@/lib/api/allDealerChannelMatrix';
import { colorForChannel } from '@/lib/ga4/channelDisplay';
import { fmt, pct, momClass, safeDiv } from '@/lib/vdp/aggregates';
import { buildPeriods } from '@/lib/vdp/mockData';
import VdpChart from './VdpChart';
import VdpLoadingBanner, { VdpLoadingBlock } from './VdpLoadingBanner';
import { Card, Kpi, Seg, Toolbar, ToolbarGroup } from './VdpUi';

const COMPARE_OPTS = [
  { value: 'mtd', label: 'MTD vs Last Month (same dates)' },
  { value: 'mom', label: 'Full Last Month vs Prior Month' },
];

const METRIC_OPTS = [
  { value: 'page', label: 'Page Views' },
  { value: 'vdp', label: 'VDP Views' },
];

/** Live calendar periods for API (not the mock seed date). */
const LIVE_PERIODS = buildPeriods(new Date());

function dealerIncludedOnTab(dealer, metric) {
  if (metric === 'vdp') return dealer?.showAllDealersVdp !== false;
  return dealer?.showAllDealersAll !== false;
}

function dealerKey(dealer) {
  return String(dealer?.ga4CustomerId || dealer?.id || dealer?.name || '');
}

function totalForRow(row, channelId) {
  if (!row) return 0;
  if (channelId === 'all') return Math.round(Number(row.total) || 0);
  const slice = sliceMapForRow(row).get(channelId);
  return Math.round(Number(slice?.value) || 0);
}

function indexRowsByDealer(rows) {
  const map = new Map();
  for (const row of rows || []) {
    map.set(dealerKey(row.dealer), row);
  }
  return map;
}

function buildChannelGrid(matrixRows, columns) {
  const dealerRows = (matrixRows || []).map((row) => {
    const byName = sliceMapForRow(row);
    const cells = columns.map((name) =>
      Math.round(Number(byName.get(name)?.value) || 0)
    );
    return {
      dealer: row.dealer,
      error: row.error,
      cells,
      total: cells.reduce((s, v) => s + v, 0),
    };
  });

  const allChannelTotals = columns.map((name, i) => ({
    id: name,
    name,
    color: colorForChannel(name, i),
    total: dealerRows.reduce((s, row) => s + row.cells[i], 0),
  }));

  const allTotal = allChannelTotals.reduce((s, c) => s + c.total, 0);
  return { dealerRows, allChannelTotals, allTotal, columns };
}

export default function PortfolioView() {
  const router = useRouter();
  const {
    dealers,
    pickClient,
    loading: dealersLoading,
    error: dealersError,
    dealerCategoryFilter,
  } = useClient();

  const [mode, setMode] = useState('mtd');
  const [metric, setMetric] = useState('page');
  const [channelId, setChannelId] = useState('all');
  const [sort, setSort] = useState({ k: 'pv1', dir: -1 });

  const [pageCur, setPageCur] = useState({ rows: [], columns: [] });
  const [pagePri, setPagePri] = useState({ rows: [], columns: [] });
  const [vdpCur, setVdpCur] = useState({ rows: [], columns: [] });
  const [vdpPri, setVdpPri] = useState({ rows: [], columns: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const cancelRef = useRef(false);
  const loadGenRef = useRef(0);

  const p = LIVE_PERIODS[mode];
  const metricLabel = metric === 'page' ? 'Page Views' : 'VDP Views';

  const portfolioDealers = useMemo(
    () => (dealers || []).filter((d) => dealerIncludedOnTab(d, metric)),
    [dealers, metric]
  );

  const loadMatrix = useCallback(async () => {
    if (!portfolioDealers.length || !p.curFrom || !p.curTo) {
      setPageCur({ rows: [], columns: [] });
      setPagePri({ rows: [], columns: [] });
      setVdpCur({ rows: [], columns: [] });
      setVdpPri({ rows: [], columns: [] });
      return;
    }

    const loadGen = loadGenRef.current + 1;
    loadGenRef.current = loadGen;
    cancelRef.current = false;
    const isStale = () => cancelRef.current || loadGenRef.current !== loadGen;

    setLoading(true);
    setError(null);
    setProgress({ completed: 0, total: 4 });

    const progressParts = [0, 0, 0, 0];
    const publishProgress = () => {
      if (isStale()) return;
      setProgress({
        completed: progressParts.reduce((s, n) => s + n, 0),
        total: 4,
      });
    };

    const fetchOne = (from, to, pageTypeFilter, idx) =>
      fetchAllDealersChannelMatrix({
        dealers: portfolioDealers,
        from,
        to,
        pageTypeFilter,
        onProgress: (prog) => {
          progressParts[idx] = prog.total
            ? prog.completed / prog.total
            : 0;
          publishProgress();
        },
        onCancelCheck: () => isStale(),
      });

    try {
      const [pageCurrent, pagePrior, vdpCurrent, vdpPrior] = await Promise.all([
        fetchOne(p.curFrom, p.curTo, 'ALL', 0),
        fetchOne(p.priFrom, p.priTo, 'ALL', 1),
        fetchOne(p.curFrom, p.curTo, 'VDP', 2),
        fetchOne(p.priFrom, p.priTo, 'VDP', 3),
      ]);

      if (isStale()) return;

      setPageCur({ rows: pageCurrent.rows || [], columns: pageCurrent.columns || [] });
      setPagePri({ rows: pagePrior.rows || [], columns: pagePrior.columns || [] });
      setVdpCur({ rows: vdpCurrent.rows || [], columns: vdpCurrent.columns || [] });
      setVdpPri({ rows: vdpPrior.rows || [], columns: vdpPrior.columns || [] });
      setError(
        pageCurrent.warning ||
          pagePrior.warning ||
          vdpCurrent.warning ||
          vdpPrior.warning ||
          null
      );
    } catch (err) {
      if (!isStale()) {
        setError(err?.message || 'Failed to load dealer channel data.');
        setPageCur({ rows: [], columns: [] });
        setPagePri({ rows: [], columns: [] });
        setVdpCur({ rows: [], columns: [] });
        setVdpPri({ rows: [], columns: [] });
      }
    } finally {
      if (!isStale()) {
        setLoading(false);
        setProgress(null);
      }
    }
  }, [portfolioDealers, p.curFrom, p.curTo, p.priFrom, p.priTo]);

  useEffect(() => {
    if (dealersLoading) return undefined;
    loadMatrix();
    return () => {
      cancelRef.current = true;
    };
  }, [dealersLoading, loadMatrix]);

  const activeMatrix = metric === 'vdp' ? vdpCur : pageCur;

  const channelGrid = useMemo(
    () => buildChannelGrid(activeMatrix.rows, activeMatrix.columns),
    [activeMatrix]
  );

  const channelOptions = useMemo(
    () =>
      channelGrid.allChannelTotals.map((ch) => ({
        id: ch.id,
        name: ch.name,
      })),
    [channelGrid]
  );

  useEffect(() => {
    if (
      channelId !== 'all' &&
      channelOptions.length > 0 &&
      !channelOptions.some((c) => c.id === channelId)
    ) {
      setChannelId('all');
    }
  }, [channelId, channelOptions]);

  const channelLabel =
    channelId === 'all'
      ? 'All Channels'
      : channelOptions.find((c) => c.id === channelId)?.name || 'All Channels';

  const filteredDealerRows = useMemo(() => {
    if (channelId === 'all') return channelGrid.dealerRows;
    const idx = channelGrid.columns.indexOf(channelId);
    if (idx < 0) return channelGrid.dealerRows;
    return channelGrid.dealerRows.map((row) => ({
      ...row,
      cells: row.cells.map((v, i) => (i === idx ? v : 0)),
      total: row.cells[idx] || 0,
    }));
  }, [channelGrid, channelId]);

  const displayChannels =
    channelId === 'all'
      ? channelGrid.allChannelTotals
      : channelGrid.allChannelTotals.filter((c) => c.id === channelId);

  const displayAllTotals = useMemo(() => {
    if (channelId === 'all') {
      return {
        channels: channelGrid.allChannelTotals,
        total: channelGrid.allTotal,
      };
    }
    const one = channelGrid.allChannelTotals.find((c) => c.id === channelId);
    return {
      channels: one ? [one] : [],
      total: one?.total || 0,
    };
  }, [channelGrid, channelId]);

  const topChannel = useMemo(() => {
    const list =
      channelId === 'all'
        ? channelGrid.allChannelTotals
        : displayAllTotals.channels;
    return [...list].sort((a, b) => b.total - a.total)[0];
  }, [channelGrid, channelId, displayAllTotals]);

  const dealerSummaryRows = useMemo(() => {
    const pageCurMap = indexRowsByDealer(pageCur.rows);
    const pagePriMap = indexRowsByDealer(pagePri.rows);
    const vdpCurMap = indexRowsByDealer(vdpCur.rows);
    const vdpPriMap = indexRowsByDealer(vdpPri.rows);

    const keys = new Set([
      ...pageCurMap.keys(),
      ...vdpCurMap.keys(),
    ]);

    const rows = [];
    for (const key of keys) {
      const curPage = pageCurMap.get(key);
      const priPage = pagePriMap.get(key);
      const curVdp = vdpCurMap.get(key);
      const priVdp = vdpPriMap.get(key);
      const dealer =
        curPage?.dealer || curVdp?.dealer || priPage?.dealer || priVdp?.dealer;
      if (!dealer) continue;

      const pv1 = totalForRow(curPage, channelId);
      const pv0 = totalForRow(priPage, channelId);
      const vdp1 = totalForRow(curVdp, channelId);
      const vdp0 = totalForRow(priVdp, channelId);

      rows.push({
        id: key,
        dealer,
        name: dealer.name || 'Unnamed',
        vertical: dealer.dealerCategory || '—',
        pv1,
        pv0,
        pvmom: safeDiv(pv1 - pv0, pv0) * 100,
        vdp1,
        vdp0,
        vdpmom: safeDiv(vdp1 - vdp0, vdp0) * 100,
        rate: safeDiv(vdp1, pv1) * 100,
        error: curPage?.error || curVdp?.error || null,
      });
    }

    rows.sort((a, b) => {
      const av = a[sort.k];
      const bv = b[sort.k];
      if (typeof av === 'string') return av.localeCompare(bv) * sort.dir;
      return (av - bv) * sort.dir;
    });

    return rows;
  }, [pageCur, pagePri, vdpCur, vdpPri, channelId, sort]);

  const barData = useMemo(() => {
    const ordered = [...filteredDealerRows]
      .filter((r) => !r.error)
      .sort((a, b) => b.total - a.total)
      .slice(0, 20);
    return {
      labels: ordered.map((r) => r.dealer?.name || 'Dealer'),
      datasets: [
        {
          label: p.curLabel,
          data: ordered.map((r) => r.total),
          backgroundColor: '#2563eb',
          borderRadius: 4,
        },
      ],
    };
  }, [filteredDealerRows, p.curLabel]);

  const barOptions = useMemo(
    () => ({
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
      },
      scales: { y: { ticks: { callback: (v) => fmt(v) } } },
    }),
    []
  );

  const openDealer = (dealer) => {
    if (dealer) pickClient(dealer);
    router.push('/dashboard/overview');
  };

  const onSort = (k) => {
    setSort((prev) => ({
      k,
      dir: prev.k === k ? -prev.dir : -1,
    }));
  };

  const isBusy = dealersLoading || loading;
  const periodSub = `${metricLabel}, ${p.curLabel} — click a dealer to open it.`;

  return (
    <div className={`vdp-view${isBusy ? ' vdp-view--loading' : ''}`}>
      <VdpLoadingBanner
        active={isBusy}
        label="Loading All Dealers…"
        detail={
          progress?.total
            ? `Fetching channel matrix (${Math.round(progress.completed)}/${progress.total})`
            : 'Fetching channel matrix for dealers'
        }
      />
      <Toolbar>
        <ToolbarGroup label="Comparison">
          <Seg value={mode} options={COMPARE_OPTS} onChange={setMode} />
        </ToolbarGroup>
        <ToolbarGroup label="Metric">
          <Seg value={metric} options={METRIC_OPTS} onChange={setMetric} />
        </ToolbarGroup>
        <ToolbarGroup label="Channel">
          <select
            className="vdp-select"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            disabled={isBusy && !channelOptions.length}
          >
            <option value="all">All Channels</option>
            {channelOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </ToolbarGroup>
      </Toolbar>

      <div className="vdp-kpi-grid">
        <Kpi
          label="Dealers Tracked"
          value={isBusy ? '…' : filteredDealerRows.length}
          sub={
            dealerCategoryFilter
              ? `${channelLabel} · ${dealerCategoryFilter}`
              : channelLabel
          }
        />
        <Kpi
          label={`${metricLabel} · ${p.curLabel}`}
          value={isBusy ? '…' : fmt(displayAllTotals.total)}
          sub={channelLabel}
        />
        <Kpi
          label={`Top Channel · ${p.curLabel}`}
          value={isBusy ? '…' : topChannel?.name || '—'}
          sub={
            topChannel
              ? `${fmt(topChannel.total)} ${metricLabel.toLowerCase()}`
              : ''
          }
        />
        <Kpi
          label="Data source"
          value="Live API"
          sub={
            progress
              ? `Loading ${Math.round(progress.completed)}/${progress.total}…`
              : error
                ? 'Partial / check warning'
                : 'all-dealers-channel-matrix'
          }
        />
      </div>

      {(dealersError || error) && (
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
          {dealersError || error}
        </div>
      )}

      <Card
        title={`${metricLabel} by Dealer — ${channelLabel}`}
        sub={`${p.curLabel}${isBusy ? ' · loading…' : ''}`}
        style={{ marginBottom: 16 }}
      >
        {isBusy && !filteredDealerRows.length ? (
          <VdpLoadingBlock
            label={`Loading dealer channel data${
              progress
                ? ` (${Math.round(progress.completed)}/${progress.total})`
                : '…'
            }`}
            minHeight={120}
          />
        ) : (
          <VdpChart type="bar" data={barData} options={barOptions} height={110} />
        )}
      </Card>

      <Card
        title="Channel Breakdown by Dealer"
        sub={periodSub}
        style={{ marginBottom: 16 }}
      >
        {isBusy && !channelGrid.dealerRows.length ? (
          <VdpLoadingBlock
            label={`Loading channel matrix${
              progress
                ? ` ${Math.round(progress.completed)}/${progress.total}`
                : '…'
            }`}
            minHeight={160}
          />
        ) : !channelGrid.dealerRows.length ? (
          <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
            No dealer channel data for this period.
            {!portfolioDealers.length
              ? ' No active dealers with GA4 IDs found.'
              : ''}
          </div>
        ) : (
          <>
            <div className="vdp-table-scroll vdp-table-scroll--10">
              <table className="vdp-table">
                <thead>
                  <tr>
                    <th>Dealer</th>
                    {displayChannels.map((ch) => (
                      <th key={ch.id} className="right">
                        <span
                          className="vdp-legend-swatch"
                          style={{ background: ch.color }}
                        />
                        {ch.name}
                      </th>
                    ))}
                    <th
                      className="right"
                      style={{ borderLeft: '2px solid var(--vdp-border)' }}
                    >
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDealerRows.map(({ dealer, cells, total, error: rowError }) => {
                    const shownCells =
                      channelId === 'all'
                        ? cells
                        : [cells[channelGrid.columns.indexOf(channelId)] || 0];
                    return (
                      <tr
                        key={dealer?.id || dealer?.ga4CustomerId || dealer?.name}
                        className="vdp-row-click"
                        onClick={() => openDealer(dealer)}
                      >
                        <td className="vdp-dealer-name">
                          {dealer?.name || 'Unnamed'}
                          {dealer?.dealerCategory ? (
                            <span className="vdp-vert-tag">
                              {dealer.dealerCategory}
                            </span>
                          ) : null}
                          {rowError ? (
                            <span className="vdp-vert-tag" style={{ color: '#dc2626' }}>
                              {rowError}
                            </span>
                          ) : null}
                        </td>
                        {shownCells.map((v, i) => (
                          <td key={i} className="right mono">
                            {fmt(v)}
                          </td>
                        ))}
                        <td
                          className="right mono"
                          style={{
                            borderLeft: '2px solid var(--vdp-border)',
                            fontWeight: 700,
                          }}
                        >
                          {fmt(total)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td>All Dealers</td>
                    {displayAllTotals.channels.map((ct) => (
                      <td key={ct.id} className="right mono">
                        {fmt(ct.total)}
                      </td>
                    ))}
                    <td
                      className="right mono"
                      style={{ borderLeft: '2px solid var(--vdp-border)' }}
                    >
                      {fmt(displayAllTotals.total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {filteredDealerRows.length > 10 && (
              <div className="vdp-scroll-hint">
                Showing 10 of {filteredDealerRows.length} dealers — scroll for more
              </div>
            )}
          </>
        )}
      </Card>

      <Card
        title={
          <>
            All Dealers{' '}
            <span style={{ color: 'var(--vdp-muted)', fontWeight: 400, fontSize: 12 }}>
              — click a row to open that dealer
            </span>
          </>
        }
        sub={`Comparing ${p.curLabel} to ${p.priLabel}, filtered to ${channelLabel}`}
      >
        {isBusy && !dealerSummaryRows.length ? (
          <VdpLoadingBlock label="Loading dealer comparison…" minHeight={140} />
        ) : !dealerSummaryRows.length ? (
          <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
            No dealer comparison data for this period.
          </div>
        ) : (
          <>
            <div className="vdp-table-scroll vdp-table-scroll--10">
              <table className="vdp-table">
                <thead>
                  <tr>
                    {[
                      ['name', 'Dealer'],
                      ['vertical', 'Vertical'],
                      ['pv1', 'Page Views (Current)'],
                      ['pv0', 'Page Views (Prior)'],
                      ['pvmom', 'MoM %'],
                      ['vdp1', 'VDP Views (Current)'],
                      ['vdp0', 'VDP Views (Prior)'],
                      ['vdpmom', 'MoM %'],
                      ['rate', 'VDP Rate'],
                    ].map(([k, label]) => (
                      <th
                        key={k}
                        className={`${['pv1', 'pv0', 'pvmom', 'vdp1', 'vdp0', 'vdpmom', 'rate'].includes(k) ? 'right' : ''} ${sort.k === k ? 'sorted' : ''}`}
                        onClick={() => onSort(k)}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dealerSummaryRows.map((r) => (
                    <tr
                      key={r.id}
                      className="vdp-row-click"
                      onClick={() => openDealer(r.dealer)}
                    >
                      <td className="vdp-dealer-name">
                        {r.name}
                        {r.error ? (
                          <span className="vdp-vert-tag" style={{ color: '#dc2626' }}>
                            {r.error}
                          </span>
                        ) : null}
                      </td>
                      <td>{r.vertical}</td>
                      <td className="right mono">{fmt(r.pv1)}</td>
                      <td className="right mono">{fmt(r.pv0)}</td>
                      <td className={`right vdp-delta ${momClass(r.pvmom / 100)}`}>
                        {r.pv0 < 1 ? '—' : pct(r.pvmom)}
                      </td>
                      <td className="right mono">{fmt(r.vdp1)}</td>
                      <td className="right mono">{fmt(r.vdp0)}</td>
                      <td className={`right vdp-delta ${momClass(r.vdpmom / 100)}`}>
                        {r.vdp0 < 1 ? '—' : pct(r.vdpmom)}
                      </td>
                      <td className="right mono">{r.rate.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {dealerSummaryRows.length > 10 && (
              <div className="vdp-scroll-hint">
                Showing 10 of {dealerSummaryRows.length} dealers — scroll for more
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
