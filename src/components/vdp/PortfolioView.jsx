'use client';

import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { useClient } from '@/components/dashboard/ClientContext';
import {
  fetchAllDealersChannelMatrix,
  sliceMapForRow,
} from '@/lib/api/allDealerChannelMatrix';
import { colorForChannel } from '@/lib/ga4/channelDisplay';
import { fmt, pct, momClass, safeDiv } from '@/lib/vdp/aggregates';
import VdpChart from './VdpChart';
import { VdpLoadingCard } from './VdpLoadingBanner';
import { useVdpDateRange } from './VdpDateRangeContext';
import { Card, Kpi, Seg, Toolbar, ToolbarGroup } from './VdpUi';
import { VDP_COMPARE_MODES } from '@/lib/vdp/dateRange';

const METRIC_OPTS = [
  { value: 'vdp', label: 'VDP Views' },
  { value: 'page', label: 'Page Views' },
];

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

  const [metric, setMetric] = useState('vdp');
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

  const {
    from: curFrom,
    to: curTo,
    priorFrom: priFrom,
    priorTo: priTo,
    curLabel,
    priLabel,
    compareMode,
    toggleCompareMode,
  } = useVdpDateRange();
  const metricLabel = metric === 'page' ? 'Page Views' : 'VDP Views';
  const compareActive = compareMode === 'mom' || compareMode === 'pop';
  const comparePctLabel = compareMode === 'pop' ? 'PoP %' : 'MoM %';
  const compareModeLabel =
    compareMode === 'pop'
      ? 'PoP · same dates last month'
      : 'MoM · full last month';

  const portfolioDealers = useMemo(
    () => (dealers || []).filter((d) => dealerIncludedOnTab(d, metric)),
    [dealers, metric]
  );

  const loadMatrix = useCallback(async () => {
    if (!portfolioDealers.length || !curFrom || !curTo) {
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
    const withCompare = compareActive && Boolean(priFrom && priTo);
    const fetchCount = withCompare ? 4 : 2;

    setLoading(true);
    setError(null);
    setProgress({ completed: 0, total: fetchCount });

    const progressParts = Array(fetchCount).fill(0);
    const publishProgress = () => {
      if (isStale()) return;
      setProgress({
        completed: progressParts.reduce((s, n) => s + n, 0),
        total: fetchCount,
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
      const emptyPrior = { rows: [], columns: [], warning: null };
      const [pageCurrent, pagePrior, vdpCurrent, vdpPrior] = await Promise.all([
        fetchOne(curFrom, curTo, 'ALL', 0),
        withCompare
          ? fetchOne(priFrom, priTo, 'ALL', 1)
          : Promise.resolve(emptyPrior),
        fetchOne(curFrom, curTo, 'VDP', withCompare ? 2 : 1),
        withCompare
          ? fetchOne(priFrom, priTo, 'VDP', 3)
          : Promise.resolve(emptyPrior),
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
  }, [portfolioDealers, curFrom, curTo, priFrom, priTo, compareActive]);

  useEffect(() => {
    if (dealersLoading) return undefined;
    loadMatrix();
    return () => {
      cancelRef.current = true;
    };
  }, [dealersLoading, loadMatrix]);

  const activeMatrix = metric === 'vdp' ? vdpCur : pageCur;
  const priorMatrix = metric === 'vdp' ? vdpPri : pagePri;

  const channelGrid = useMemo(
    () => buildChannelGrid(activeMatrix.rows, activeMatrix.columns),
    [activeMatrix]
  );

  const priorByDealer = useMemo(
    () => indexRowsByDealer(priorMatrix.rows),
    [priorMatrix]
  );

  const channelValue = useCallback((row, channelName) => {
    if (!row || channelName == null) return 0;
    if (channelName === 'all') return Math.round(Number(row.total) || 0);
    return Math.round(Number(sliceMapForRow(row).get(channelName)?.value) || 0);
  }, []);

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

  const priorAllTotals = useMemo(() => {
    if (!compareActive) {
      return { channels: [], total: 0 };
    }
    let total = 0;
    const channels = displayChannels.map((ch) => {
      let sum = 0;
      for (const row of priorMatrix.rows || []) {
        sum += channelValue(row, ch.id);
      }
      total += sum;
      return { id: ch.id, total: sum };
    });
    if (channelId !== 'all') {
      total = channels[0]?.total || 0;
    } else {
      total = 0;
      for (const row of priorMatrix.rows || []) {
        total += Math.round(Number(row.total) || 0);
      }
    }
    return { channels, total };
  }, [
    compareActive,
    displayChannels,
    priorMatrix.rows,
    channelValue,
    channelId,
  ]);

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
      .sort((a, b) => b.total - a.total);

    const priorRows = metric === 'vdp' ? vdpPri.rows : pagePri.rows;
    const priorMap = indexRowsByDealer(priorRows);

    const datasets = [
      {
        label: curLabel,
        data: ordered.map((r) => r.total),
        backgroundColor: '#2563eb',
        borderRadius: 4,
        maxBarThickness: 42,
      },
    ];

    if (compareActive) {
      datasets.push({
        label: priLabel,
        data: ordered.map((r) =>
          totalForRow(priorMap.get(dealerKey(r.dealer)), channelId)
        ),
        backgroundColor: '#94a3b8',
        borderRadius: 4,
        maxBarThickness: 42,
      });
    }

    return {
      labels: ordered.map((r) => r.dealer?.name || 'Dealer'),
      datasets,
    };
  }, [
    filteredDealerRows,
    curLabel,
    priLabel,
    compareActive,
    metric,
    vdpPri.rows,
    pagePri.rows,
    channelId,
  ]);

  const barOptions = useMemo(
    () => ({
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { boxWidth: 12, font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            maxRotation: 45,
            minRotation: 45,
            autoSkip: false,
            font: { size: 10 },
            color: '#64748b',
          },
          grid: { display: false },
        },
        y: {
          ticks: { callback: (v) => fmt(v), color: '#64748b' },
          grid: { color: 'rgba(148, 163, 184, 0.25)' },
        },
      },
    }),
    []
  );

  const barChartWidth = Math.max(
    720,
    (barData.labels?.length || 0) * (compareActive ? 72 : 56)
  );

  const openDealer = (dealer) => {
    if (dealer) pickClient(dealer);
    setLoading(true);
    setProgress({ completed: 0, total: compareActive ? 4 : 2 });
    router.push('/dashboard/overview');
  };

  const onSort = (k) => {
    setSort((prev) => ({
      k,
      dir: prev.k === k ? -prev.dir : -1,
    }));
  };

  const isBusy = dealersLoading || loading;
  const loadPercent = progress?.total
    ? Math.round((Number(progress.completed) / Number(progress.total)) * 100)
    : isBusy
      ? 0
      : null;
  const channelFixedScrollRef = useRef(null);
  const channelScrollRef = useRef(null);
  const syncingScrollRef = useRef(false);

  const CHANNEL_COL_W = 80;
  const DEALER_COL_W = 180;
  const TOTAL_COL_W = 88;
  const channelValueCols = displayChannels.length * (compareActive ? 2 : 1);
  const channelTableWidth = Math.max(channelValueCols * CHANNEL_COL_W, 320);
  const freezeTableWidth =
    DEALER_COL_W + (compareActive ? TOTAL_COL_W * 2 : TOTAL_COL_W);

  /** Vertical sync only — freeze columns never move horizontally. */
  const syncChannelScroll = useCallback(() => {
    if (syncingScrollRef.current) return;
    const fixed = channelFixedScrollRef.current;
    const scroll = channelScrollRef.current;
    if (!fixed || !scroll) return;
    syncingScrollRef.current = true;
    fixed.scrollTop = scroll.scrollTop;
    requestAnimationFrame(() => {
      syncingScrollRef.current = false;
    });
  }, []);

  const onFixedWheel = useCallback((e) => {
    const scroll = channelScrollRef.current;
    if (!scroll) return;
    scroll.scrollTop += e.deltaY;
    e.preventDefault();
  }, []);

  const periodSub = compareActive
    ? `${metricLabel} · ${curLabel} vs ${priLabel} (${compareModeLabel}) — click a dealer to open it.`
    : `${metricLabel}, ${curLabel} — click a dealer to open it.`;

  return (
    <div className={`vdp-view${isBusy ? ' vdp-view--card-loading' : ''}`}>
      <VdpLoadingCard active={isBusy} percent={loadPercent} />
      <Toolbar>
        <ToolbarGroup label="Metric">
          <Seg value={metric} options={METRIC_OPTS} onChange={setMetric} />
        </ToolbarGroup>
        <ToolbarGroup label="Compare">
          <Seg
            value={compareMode}
            options={VDP_COMPARE_MODES}
            onChange={toggleCompareMode}
          />
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
          value={filteredDealerRows.length}
          sub={
            dealerCategoryFilter
              ? `${channelLabel} · ${dealerCategoryFilter}`
              : channelLabel
          }
        />
        <Kpi
          label={`${metricLabel} · ${curLabel}`}
          value={fmt(displayAllTotals.total)}
          sub={channelLabel}
        />
        <Kpi
          label={`Top Channel · ${curLabel}`}
          value={topChannel?.name || '—'}
          sub={
            topChannel
              ? `${fmt(topChannel.total)} ${metricLabel.toLowerCase()}`
              : ''
          }
        />
        <Kpi
          label="Data source"
          value="Live API"
          sub={error ? 'Partial / check warning' : 'all-dealers-channel-matrix'}
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
        sub={
          compareActive
            ? `${curLabel} vs ${priLabel} (${compareModeLabel}) · scroll horizontally for all dealers`
            : `${curLabel} · scroll horizontally for all dealers`
        }
        style={{ marginBottom: 16 }}
      >
        {!(barData.labels || []).length ? (
          <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
            No dealer data for this period.
          </div>
        ) : (
          <div className="vdp-chart-scroll">
            <div
              className="vdp-chart-scroll-inner"
              style={{ width: barChartWidth, minWidth: '100%' }}
            >
              <VdpChart
                type="bar"
                data={barData}
                options={barOptions}
                fill
                height={280}
              />
            </div>
          </div>
        )}
      </Card>

      <Card
        title="Channel Breakdown by Dealer"
        sub={periodSub}
        style={{ marginBottom: 16 }}
      >
        {!channelGrid.dealerRows.length ? (
          <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
            No dealer channel data for this period.
            {!portfolioDealers.length
              ? ' No active dealers with GA4 IDs found.'
              : ''}
          </div>
        ) : (
          <>
            <div className="vdp-split-table">
              {/* Freeze: Dealer + Total — never scrolls horizontally */}
              <div
                className="vdp-split-table__freeze"
                style={{ width: freezeTableWidth }}
              >
                <div
                  ref={channelFixedScrollRef}
                  className="vdp-split-table__freeze-y vdp-table-scroll--10"
                  onWheel={onFixedWheel}
                >
                  <table
                    className={`vdp-table vdp-table--fixed-total${compareActive ? ' vdp-table--channel-compare' : ''}`}
                    style={{
                      width: freezeTableWidth,
                      tableLayout: 'fixed',
                    }}
                  >
                    <colgroup>
                      <col style={{ width: DEALER_COL_W }} />
                      {compareActive ? (
                        <>
                          <col style={{ width: TOTAL_COL_W }} />
                          <col style={{ width: TOTAL_COL_W }} />
                        </>
                      ) : (
                        <col style={{ width: TOTAL_COL_W }} />
                      )}
                    </colgroup>
                    <thead>
                      {compareActive ? (
                        <>
                          <tr>
                            <th rowSpan={2}>Dealer</th>
                            <th colSpan={2} className="vdp-th-group vdp-th-pair-end">
                              Total
                            </th>
                          </tr>
                          <tr>
                            <th className="vdp-th-sub col-cur">Current</th>
                            <th className="vdp-th-sub col-prev vdp-th-pair-end">Prior</th>
                          </tr>
                        </>
                      ) : (
                        <tr>
                          <th>Dealer</th>
                          <th className="right">Total</th>
                        </tr>
                      )}
                    </thead>
                    <tbody>
                      {filteredDealerRows.map(({ dealer, total, error: rowError }) => {
                        const priorRow = priorByDealer.get(dealerKey(dealer));
                        const priorTotal =
                          channelId === 'all'
                            ? Math.round(Number(priorRow?.total) || 0)
                            : channelValue(priorRow, channelId);
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
                            {compareActive ? (
                              <>
                                <td className="right mono col-cur" style={{ fontWeight: 700 }}>
                                  {fmt(total)}
                                </td>
                                <td className="right mono col-prev" style={{ fontWeight: 700 }}>
                                  {fmt(priorTotal)}
                                </td>
                              </>
                            ) : (
                              <td className="right mono" style={{ fontWeight: 700 }}>
                                {fmt(total)}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="vdp-split-table__freeze-foot">
                  <table
                    className={`vdp-table vdp-table--fixed-total${compareActive ? ' vdp-table--channel-compare' : ''}`}
                    style={{
                      width: freezeTableWidth,
                      tableLayout: 'fixed',
                    }}
                  >
                    <colgroup>
                      <col style={{ width: DEALER_COL_W }} />
                      {compareActive ? (
                        <>
                          <col style={{ width: TOTAL_COL_W }} />
                          <col style={{ width: TOTAL_COL_W }} />
                        </>
                      ) : (
                        <col style={{ width: TOTAL_COL_W }} />
                      )}
                    </colgroup>
                    <tbody>
                      <tr>
                        <td>All Dealers</td>
                        {compareActive ? (
                          <>
                            <td className="right mono col-cur">{fmt(displayAllTotals.total)}</td>
                            <td className="right mono col-prev">{fmt(priorAllTotals.total)}</td>
                          </>
                        ) : (
                          <td className="right mono">{fmt(displayAllTotals.total)}</td>
                        )}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Channels: horizontal scroll wraps body + total (scrollbar under total) */}
              <div className="vdp-split-table__channels">
                <div
                  className="vdp-split-table__channels-inner"
                  style={{ width: channelTableWidth }}
                >
                  <div
                    ref={channelScrollRef}
                    className="vdp-split-table__channels-y vdp-table-scroll--10"
                    onScroll={syncChannelScroll}
                  >
                    <table
                      className={`vdp-table${compareActive ? ' vdp-table--channel-compare' : ''}`}
                      style={{
                        width: channelTableWidth,
                        tableLayout: 'fixed',
                      }}
                    >
                      <colgroup>
                        {Array.from({ length: channelValueCols }).map((_, i) => (
                          <col key={i} style={{ width: CHANNEL_COL_W }} />
                        ))}
                      </colgroup>
                      <thead>
                        {compareActive ? (
                          <>
                            <tr>
                              {displayChannels.map((ch) => (
                                <th
                                  key={ch.id}
                                  colSpan={2}
                                  className="vdp-th-group vdp-th-pair-end"
                                >
                                  <span
                                    className="vdp-legend-swatch"
                                    style={{ background: ch.color }}
                                  />
                                  {ch.name}
                                </th>
                              ))}
                            </tr>
                            <tr>
                              {displayChannels.map((ch) => (
                                <Fragment key={ch.id}>
                                  <th className="vdp-th-sub col-cur">Current</th>
                                  <th className="vdp-th-sub col-prev vdp-th-pair-end">
                                    Prior
                                  </th>
                                </Fragment>
                              ))}
                            </tr>
                          </>
                        ) : (
                          <tr>
                            {displayChannels.map((ch) => (
                              <th key={ch.id} className="right">
                                <span
                                  className="vdp-legend-swatch"
                                  style={{ background: ch.color }}
                                />
                                {ch.name}
                              </th>
                            ))}
                          </tr>
                        )}
                      </thead>
                      <tbody>
                        {filteredDealerRows.map(({ dealer, cells }) => {
                          const shownCells =
                            channelId === 'all'
                              ? cells
                              : [cells[channelGrid.columns.indexOf(channelId)] || 0];
                          const priorRow = priorByDealer.get(dealerKey(dealer));
                          return (
                            <tr
                              key={dealer?.id || dealer?.ga4CustomerId || dealer?.name}
                              className="vdp-row-click"
                              onClick={() => openDealer(dealer)}
                            >
                              {compareActive
                                ? displayChannels.map((ch) => {
                                    const curIdx = channelGrid.columns.indexOf(ch.id);
                                    const curVal =
                                      channelId === 'all'
                                        ? cells[curIdx] || 0
                                        : shownCells[0] || 0;
                                    const priVal = channelValue(priorRow, ch.id);
                                    return (
                                      <Fragment key={ch.id}>
                                        <td className="right mono col-cur">
                                          {fmt(curVal)}
                                        </td>
                                        <td className="right mono col-prev">
                                          {fmt(priVal)}
                                        </td>
                                      </Fragment>
                                    );
                                  })
                                : shownCells.map((v, i) => (
                                    <td key={i} className="right mono">
                                      {fmt(v)}
                                    </td>
                                  ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="vdp-split-table__channels-foot">
                    <table
                      className={`vdp-table${compareActive ? ' vdp-table--channel-compare' : ''}`}
                      style={{
                        width: channelTableWidth,
                        tableLayout: 'fixed',
                      }}
                    >
                      <colgroup>
                        {Array.from({ length: channelValueCols }).map((_, i) => (
                          <col key={i} style={{ width: CHANNEL_COL_W }} />
                        ))}
                      </colgroup>
                      <tbody>
                        <tr>
                          {compareActive
                            ? displayAllTotals.channels.map((ct) => {
                                const pri = priorAllTotals.channels.find(
                                  (c) => c.id === ct.id
                                );
                                return (
                                  <Fragment key={ct.id}>
                                    <td className="right mono col-cur">
                                      {fmt(ct.total)}
                                    </td>
                                    <td className="right mono col-prev">
                                      {fmt(pri?.total || 0)}
                                    </td>
                                  </Fragment>
                                );
                              })
                            : displayAllTotals.channels.map((ct) => (
                                <td key={ct.id} className="right mono">
                                  {fmt(ct.total)}
                                </td>
                              ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
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
        sub={
          compareActive
            ? `Comparing ${curLabel} to ${priLabel} (${compareModeLabel}), filtered to ${channelLabel}`
            : `${curLabel} · select MoM or PoP to compare · filtered to ${channelLabel}`
        }
      >
        {!dealerSummaryRows.length ? (
          <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
            No dealer comparison data for this period.
          </div>
        ) : (
          <>
            <div className="vdp-table-scroll vdp-table-scroll--10">
              <table className="vdp-table">
                <thead>
                  <tr>
                    {(
                      compareActive
                        ? [
                            ['name', 'Dealer'],
                            ['vertical', 'Vertical'],
                            ['pv1', 'Page Views (Current)'],
                            ['pv0', 'Page Views (Prior)'],
                            ['pvmom', comparePctLabel],
                            ['vdp1', 'VDP Views (Current)'],
                            ['vdp0', 'VDP Views (Prior)'],
                            ['vdpmom', comparePctLabel],
                            ['rate', 'VDP Rate'],
                          ]
                        : [
                            ['name', 'Dealer'],
                            ['vertical', 'Vertical'],
                            ['pv1', 'Page Views'],
                            ['vdp1', 'VDP Views'],
                            ['rate', 'VDP Rate'],
                          ]
                    ).map(([k, label]) => (
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
                      {compareActive && (
                        <>
                          <td className="right mono">{fmt(r.pv0)}</td>
                          <td className={`right vdp-delta ${momClass(r.pvmom / 100)}`}>
                            {r.pv0 < 1 ? '—' : pct(r.pvmom)}
                          </td>
                        </>
                      )}
                      <td className="right mono">{fmt(r.vdp1)}</td>
                      {compareActive && (
                        <>
                          <td className="right mono">{fmt(r.vdp0)}</td>
                          <td className={`right vdp-delta ${momClass(r.vdpmom / 100)}`}>
                            {r.vdp0 < 1 ? '—' : pct(r.vdpmom)}
                          </td>
                        </>
                      )}
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
