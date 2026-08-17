'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '@/components/dashboard/ClientContext';
import { fetchOverviewBundle } from '@/lib/api/overviewFetch';
import {
  fetchVdpDailyFiltered,
  fetchChannelBreakdown,
  fetchConditionBreakdown,
} from '@/lib/api/dashboardApi';
import { fetchTopVdpVehicles } from '@/lib/api/topVdpVehicles';
import { enumerateDatesInclusive } from '@/lib/ga4/dateRange';
import { normalizeReportDate } from '@/lib/ga4/aggregatePageDataRows';
import { sumAllTabViewsByDate } from '@/lib/ga4/overviewViews';
import { fmt, pct, momClass, safeDiv } from '@/lib/vdp/aggregates';
import { isAllDealerClient } from '@/lib/dashboard/allDealers';
import VdpChart from './VdpChart';
import { VdpLoadingCard } from './VdpLoadingBanner';
import { useVdpDateRange } from './VdpDateRangeContext';
import { useSoftLoadPercent } from './useSoftLoadPercent';
import VdpChannelCmpTable from './VdpChannelCmpTable';
import { Card, Kpi, Seg, Toolbar, ToolbarGroup } from './VdpUi';
import { VDP_COMPARE_MODES } from '@/lib/vdp/dateRange';

const METRIC_OPTS = [
  { value: 'vdp', label: 'VDP' },
  { value: 'page', label: 'Page Views' },
];

function cumulativeFromDaily(dateList, dailyMap) {
  let running = 0;
  return dateList.map((iso) => {
    running += Number(dailyMap[iso]) || 0;
    return running;
  });
}

function formatShortDay(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(iso).slice(5);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function sumDailyMap(dailyMap) {
  return Object.values(dailyMap || {}).reduce((s, v) => s + (Number(v) || 0), 0);
}

function normalizeDailyMap(daily) {
  const out = {};
  for (const [k, v] of Object.entries(daily || {})) {
    const day = normalizeReportDate(k) || k;
    out[day] = (out[day] || 0) + (Number(v) || 0);
  }
  return out;
}

function conditionClass(condition) {
  const c = String(condition || '').toLowerCase();
  if (c.startsWith('new')) return 'new';
  if (c.startsWith('used')) return 'used';
  return 'used';
}

function buildSourceChart(rows, label, color) {
  const sorted = [...(rows || [])].sort(
    (a, b) => (Number(b.views) || 0) - (Number(a.views) || 0)
  );
  return {
    labels: sorted.map((r) => String(r.channel_bucket || '(not set)')),
    datasets: [
      {
        label,
        data: sorted.map((r) => Number(r.views) || 0),
        backgroundColor: color,
        borderRadius: 4,
      },
    ],
  };
}

function buildSourceCompareChart(
  curRows,
  priRows,
  curLabel,
  priLabel,
  curColor = '#2563eb',
  priColor = '#858B9A'
) {
  const curMap = {};
  for (const r of curRows || []) {
    const key = String(r.channel_bucket || '(not set)');
    curMap[key] = (curMap[key] || 0) + (Number(r.views) || 0);
  }
  const priMap = {};
  for (const r of priRows || []) {
    const key = String(r.channel_bucket || '(not set)');
    priMap[key] = (priMap[key] || 0) + (Number(r.views) || 0);
  }
  const labels = [
    ...new Set([...Object.keys(curMap), ...Object.keys(priMap)]),
  ].sort(
    (a, b) =>
      Math.max(curMap[b] || 0, priMap[b] || 0) -
      Math.max(curMap[a] || 0, priMap[a] || 0)
  );
  return {
    labels,
    datasets: [
      {
        label: `${curLabel} (current)`,
        data: labels.map((k) => curMap[k] || 0),
        backgroundColor: curColor,
        borderRadius: 4,
      },
      {
        label: `${priLabel} (prior)`,
        data: labels.map((k) => priMap[k] || 0),
        backgroundColor: priColor,
        borderRadius: 4,
      },
    ],
  };
}

function buildNewUsedChart(rows) {
  let newSum = 0;
  let usedSum = 0;
  for (const row of rows || []) {
    const name = String(row.condition_bucket || '').toLowerCase();
    const views = Number(row.views) || 0;
    if (name.startsWith('new')) newSum += views;
    else if (name.startsWith('used')) usedSum += views;
  }
  return {
    labels: ['New', 'Used'],
    datasets: [
      {
        data: [newSum, usedSum],
        backgroundColor: ['#16a34a', '#3730a3'],
        borderWidth: 0,
      },
    ],
  };
}

function sumUnknownViews(rows) {
  let sum = 0;
  for (const row of rows || []) {
    const name = String(row.condition_bucket || '').toLowerCase();
    const views = Number(row.views) || 0;
    if (name.startsWith('new') || name.startsWith('used')) continue;
    sum += views;
  }
  return sum;
}

function newUsedCounts(chart) {
  const data = chart?.datasets?.[0]?.data || [];
  const newVal = Number(data[0]) || 0;
  const usedVal = Number(data[1]) || 0;
  const total = newVal + usedVal;
  return {
    newVal,
    usedVal,
    newPct: total > 0 ? Math.round((newVal / total) * 100) : 0,
    usedPct: total > 0 ? Math.round((usedVal / total) * 100) : 0,
  };
}

function NewUsedLegend({ chart }) {
  const { newVal, usedVal, newPct, usedPct } = newUsedCounts(chart);
  return (
    <div className="vdp-newused-legend">
      <div className="vdp-newused-legend-item">
        <span className="vdp-legend-swatch" style={{ background: '#16a34a' }} />
        <span className="vdp-newused-legend-label">New</span>
        <span className="vdp-newused-legend-val mono">
          {fmt(newVal)} ({newPct}%)
        </span>
      </div>
      <div className="vdp-newused-legend-item">
        <span className="vdp-legend-swatch" style={{ background: '#3730a3' }} />
        <span className="vdp-newused-legend-label">Used</span>
        <span className="vdp-newused-legend-val mono">
          {fmt(usedVal)} ({usedPct}%)
        </span>
      </div>
    </div>
  );
}

function TopVehiclesTable({ rows, showMom, comparePctLabel = 'MoM' }) {
  if (!rows?.length) {
    return (
      <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
        No VDP vehicle data for this period.
      </div>
    );
  }
  return (
    <table className="vdp-table">
      <thead>
        <tr>
          <th>Vehicle</th>
          <th className="right">VDP</th>
          {showMom ? <th className="right">{comparePctLabel}</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.year}-${r.make}-${r.model}-${r.condition}`}>
            <td>
              {r.year} {r.make} {r.model}{' '}
              <span className={`vdp-tag ${conditionClass(r.condition)}`}>
                {r.condition}
              </span>
            </td>
            <td className="right mono">{fmt(r.vdp1)}</td>
            {showMom ? (
              <td className={`right vdp-delta ${momClass(r.vdpmom / 100)}`}>
                {r.vdp0 < 1 && r.vdp1 > 0 ? 'New' : pct(r.vdpmom)}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function OverviewView() {
  const { client, loading: dealersLoading, isAllDealer } = useClient();
  const {
    from: curFrom,
    to: curTo,
    priorFrom: priFrom,
    priorTo: priTo,
    curLabel,
    priLabel,
    compareEnabled,
    compareMode,
    toggleCompareMode,
  } = useVdpDateRange();
  const compareActive = compareMode === 'mom' || compareMode === 'pop';
  const showCompare = Boolean(priFrom && priTo && (compareActive || compareEnabled));
  const comparePctLabel = compareMode === 'pop' ? 'PoP %' : 'MoM %';
  const compareModeLabel =
    compareMode === 'pop'
      ? 'PoP · same dates last month'
      : compareMode === 'mom'
        ? 'MoM · full last month'
        : 'Compare';
  const [metric, setMetric] = useState('vdp');
  const [metricSwitching, setMetricSwitching] = useState(false);
  const [loading, setLoading] = useState(false);
  const metricSwitchTimer = useRef(null);
  const [error, setError] = useState(null);
  const [pageCurDaily, setPageCurDaily] = useState({});
  const [pagePriDaily, setPagePriDaily] = useState({});
  const [vdpCurDaily, setVdpCurDaily] = useState({});
  const [vdpPriDaily, setVdpPriDaily] = useState({});
  const [vdpCurTotal, setVdpCurTotal] = useState(0);
  const [vdpPriTotal, setVdpPriTotal] = useState(0);
  const [uniqueUsers, setUniqueUsers] = useState(0);
  const [topVehicles, setTopVehicles] = useState([]);
  const [topVehiclesPri, setTopVehiclesPri] = useState([]);
  const [channelPageRows, setChannelPageRows] = useState([]);
  const [channelPagePriRows, setChannelPagePriRows] = useState([]);
  const [channelVdpRows, setChannelVdpRows] = useState([]);
  const [channelVdpPriRows, setChannelVdpPriRows] = useState([]);
  const [conditionRows, setConditionRows] = useState([]);
  const [conditionPriRows, setConditionPriRows] = useState([]);
  const [progress, setProgress] = useState(null);
  const cancelRef = useRef(false);
  const loadGenRef = useRef(0);

  const ga4Id = String(client?.ga4CustomerId || '').trim();
  const canLoad = Boolean(ga4Id) && !isAllDealerClient(client) && !isAllDealer;
  const isVdp = metric === 'vdp';

  const load = useCallback(async () => {
    if (!canLoad || !curFrom || !curTo) {
      setPageCurDaily({});
      setPagePriDaily({});
      setVdpCurDaily({});
      setVdpPriDaily({});
      setVdpCurTotal(0);
      setVdpPriTotal(0);
      setUniqueUsers(0);
      setTopVehicles([]);
      setTopVehiclesPri([]);
      setChannelPageRows([]);
      setChannelPagePriRows([]);
      setChannelVdpRows([]);
      setChannelVdpPriRows([]);
      setConditionRows([]);
      setConditionPriRows([]);
      return;
    }

    const loadGen = loadGenRef.current + 1;
    loadGenRef.current = loadGen;
    cancelRef.current = false;
    const isStale = () => cancelRef.current || loadGenRef.current !== loadGen;

    setLoading(true);
    setError(null);
    const withCompare = Boolean(showCompare);
    setProgress({ completed: 0, total: withCompare ? 12 : 6 });

    const track = (promise) =>
      promise.finally(() => {
        if (isStale()) return;
        setProgress((prev) =>
          prev
            ? {
                ...prev,
                completed: Math.min(prev.total, (prev.completed || 0) + 1),
              }
            : prev
        );
      });

    const emptyBundle = Promise.resolve({ rows: [], userTotalsRows: [] });
    const emptyDaily = Promise.resolve({ daily: {}, total: 0 });
    const emptyList = Promise.resolve([]);

    try {
      const [
        ovCur,
        ovPri,
        vdpCur,
        vdpPri,
        vehicles,
        vehiclesPri,
        chPage,
        chPagePri,
        chVdp,
        chVdpPri,
        conditions,
        conditionsPri,
      ] = await Promise.all([
        track(
          fetchOverviewBundle({
            clientId: ga4Id,
            from: curFrom,
            to: curTo,
            onCancelCheck: () => isStale(),
          })
        ),
        track(
          withCompare
            ? fetchOverviewBundle({
                clientId: ga4Id,
                from: priFrom,
                to: priTo,
                onCancelCheck: () => isStale(),
              })
            : emptyBundle
        ),
        track(
          fetchVdpDailyFiltered({
            clientId: ga4Id,
            from: curFrom,
            to: curTo,
            tab: 'vdp',
            onCancelCheck: () => isStale(),
          })
        ),
        track(
          withCompare
            ? fetchVdpDailyFiltered({
                clientId: ga4Id,
                from: priFrom,
                to: priTo,
                tab: 'vdp',
                onCancelCheck: () => isStale(),
              })
            : emptyDaily
        ),
        track(
          fetchTopVdpVehicles({
            clientId: ga4Id,
            from: curFrom,
            to: curTo,
            priorFrom: withCompare ? priFrom : null,
            priorTo: withCompare ? priTo : null,
            limit: 5,
            onCancelCheck: () => isStale(),
          })
        ),
        track(
          withCompare
            ? fetchTopVdpVehicles({
                clientId: ga4Id,
                from: priFrom,
                to: priTo,
                limit: 5,
                onCancelCheck: () => isStale(),
              })
            : emptyList
        ),
        track(
          fetchChannelBreakdown({
            clientId: ga4Id,
            from: curFrom,
            to: curTo,
            pageTypeFilter: 'ALL',
            tab: 'all',
            onCancelCheck: () => isStale(),
          })
        ),
        track(
          withCompare
            ? fetchChannelBreakdown({
                clientId: ga4Id,
                from: priFrom,
                to: priTo,
                pageTypeFilter: 'ALL',
                tab: 'all',
                onCancelCheck: () => isStale(),
              })
            : emptyList
        ),
        track(
          fetchChannelBreakdown({
            clientId: ga4Id,
            from: curFrom,
            to: curTo,
            pageTypeFilter: 'VDP',
            tab: 'vdp',
            onCancelCheck: () => isStale(),
          })
        ),
        track(
          withCompare
            ? fetchChannelBreakdown({
                clientId: ga4Id,
                from: priFrom,
                to: priTo,
                pageTypeFilter: 'VDP',
                tab: 'vdp',
                onCancelCheck: () => isStale(),
              })
            : emptyList
        ),
        track(
          fetchConditionBreakdown({
            clientId: ga4Id,
            from: curFrom,
            to: curTo,
            tab: 'vdp',
            onCancelCheck: () => isStale(),
          })
        ),
        track(
          withCompare
            ? fetchConditionBreakdown({
                clientId: ga4Id,
                from: priFrom,
                to: priTo,
                tab: 'vdp',
                onCancelCheck: () => isStale(),
              })
            : emptyList
        ),
      ]);

      if (isStale()) return;

      const curNorm = {};
      for (const [k, v] of Object.entries(sumAllTabViewsByDate(ovCur?.rows || []))) {
        const day = normalizeReportDate(k) || k;
        curNorm[day] = (curNorm[day] || 0) + v;
      }
      const priNorm = {};
      for (const [k, v] of Object.entries(sumAllTabViewsByDate(ovPri?.rows || []))) {
        const day = normalizeReportDate(k) || k;
        priNorm[day] = (priNorm[day] || 0) + v;
      }

      const vdpCurMap = normalizeDailyMap(vdpCur?.daily);
      const vdpPriMap = normalizeDailyMap(vdpPri?.daily);

      setPageCurDaily(curNorm);
      setPagePriDaily(priNorm);
      setVdpCurDaily(vdpCurMap);
      setVdpPriDaily(vdpPriMap);
      setVdpCurTotal(Number(vdpCur?.total) || sumDailyMap(vdpCurMap));
      setVdpPriTotal(Number(vdpPri?.total) || sumDailyMap(vdpPriMap));
      setUniqueUsers(
        (ovCur?.userTotalsRows || []).reduce(
          (s, r) => s + (Number(r.total_users) || 0),
          0
        )
      );
      setTopVehicles(vehicles || []);
      setTopVehiclesPri(vehiclesPri || []);
      setChannelPageRows(chPage || []);
      setChannelPagePriRows(chPagePri || []);
      setChannelVdpRows(chVdp || []);
      setChannelVdpPriRows(chVdpPri || []);
      setConditionRows(conditions || []);
      setConditionPriRows(conditionsPri || []);
    } catch (err) {
      if (!isStale()) {
        setError(err?.message || 'Failed to load overview.');
        setPageCurDaily({});
        setPagePriDaily({});
        setVdpCurDaily({});
        setVdpPriDaily({});
        setVdpCurTotal(0);
        setVdpPriTotal(0);
        setUniqueUsers(0);
        setTopVehicles([]);
        setTopVehiclesPri([]);
        setChannelPageRows([]);
        setChannelPagePriRows([]);
        setChannelVdpRows([]);
        setChannelVdpPriRows([]);
        setConditionRows([]);
        setConditionPriRows([]);
      }
    } finally {
      if (!isStale()) {
        setLoading(false);
        setProgress(null);
      }
    }
  }, [canLoad, ga4Id, curFrom, curTo, priFrom, priTo, showCompare]);

  useEffect(() => {
    if (dealersLoading) return undefined;
    load();
    return () => {
      cancelRef.current = true;
    };
  }, [dealersLoading, load]);

  useEffect(() => {
    return () => {
      if (metricSwitchTimer.current) clearTimeout(metricSwitchTimer.current);
    };
  }, []);

  const handleMetricChange = (next) => {
    if (next === metric) return;
    setMetric(next);
    setMetricSwitching(true);
    if (metricSwitchTimer.current) clearTimeout(metricSwitchTimer.current);
    metricSwitchTimer.current = setTimeout(() => {
      setMetricSwitching(false);
      metricSwitchTimer.current = null;
    }, 650);
  };

  const pageCur = useMemo(() => sumDailyMap(pageCurDaily), [pageCurDaily]);
  const pagePri = useMemo(() => sumDailyMap(pagePriDaily), [pagePriDaily]);
  const pvMom = safeDiv(pageCur - pagePri, pagePri) * 100;
  const vdpMom = safeDiv(vdpCurTotal - vdpPriTotal, vdpPriTotal) * 100;
  const rateCur = safeDiv(vdpCurTotal, pageCur) * 100;
  const ratePri = safeDiv(vdpPriTotal, pagePri) * 100;

  const curDates = useMemo(
    () => enumerateDatesInclusive(curFrom, curTo),
    [curFrom, curTo]
  );
  const priDates = useMemo(
    () => enumerateDatesInclusive(priFrom, priTo),
    [priFrom, priTo]
  );

  const activeCurDaily = isVdp ? vdpCurDaily : pageCurDaily;
  const activePriDaily = isVdp ? vdpPriDaily : pagePriDaily;
  const activeCurTotal = isVdp ? vdpCurTotal : pageCur;
  const activePriTotal = isVdp ? vdpPriTotal : pagePri;
  const activeMom = isVdp ? vdpMom : pvMom;
  const metricLabel = isVdp ? 'VDP Views' : 'Page Views';

  const seriesCur = useMemo(
    () => cumulativeFromDaily(curDates, activeCurDaily),
    [curDates, activeCurDaily]
  );
  // MoM: full prior month on the chart. PoP: align to current day count.
  const seriesPri = useMemo(() => {
    const datesForPri =
      compareMode === 'mom'
        ? priDates
        : priDates.slice(0, Math.max(curDates.length, 0));
    return cumulativeFromDaily(datesForPri, activePriDaily);
  }, [priDates, curDates.length, activePriDaily, compareMode]);

  const chartComparePriLabel = useMemo(() => {
    if (!showCompare || !priDates.length) return priLabel;
    // MoM: full prior month label (not truncated to current MTD days)
    if (compareMode === 'mom') return priLabel;
    const aligned = priDates.slice(0, curDates.length);
    const a = aligned[0];
    const b = aligned[aligned.length - 1];
    if (!a || !b) return priLabel;
    return a === b ? formatShortDay(a) : `${formatShortDay(a)}–${formatShortDay(b)}`;
  }, [showCompare, priDates, curDates, priLabel, compareMode]);

  const dayCount = Math.max(curDates.length, 1);
  const avgPerDay = safeDiv(activeCurTotal, dayCount);

  const lineData = useMemo(() => {
    const isMomFull = showCompare && compareMode === 'mom';
    const axisLen = isMomFull
      ? Math.max(seriesCur.length, seriesPri.length, 1)
      : Math.max(seriesCur.length, 1);

    const labels = Array.from({ length: axisLen }, (_, i) => {
      if (isMomFull) {
        // Day-of-month index so current MTD and full prior month share one axis
        return String(i + 1);
      }
      const iso = curDates[i];
      if (!iso) return String(i + 1);
      const d = new Date(`${iso}T00:00:00`);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    });

    const curSeries = isMomFull
      ? [
          ...seriesCur,
          ...Array(Math.max(0, axisLen - seriesCur.length)).fill(null),
        ]
      : seriesCur;

    const datasets = [
      {
        label: `${curLabel} (current)`,
        data: curSeries,
        borderColor: '#2563eb',
        backgroundColor: 'rgba(37,99,235,.08)',
        fill: true,
        tension: 0.3,
        spanGaps: false,
        pointRadius: 0,
        pointHoverRadius: 6,
        pointHitRadius: 12,
        pointHoverBackgroundColor: '#2563eb',
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2,
        borderWidth: 2.5,
      },
    ];
    if (showCompare && priFrom && priTo) {
      const priSeries = isMomFull
        ? seriesPri
        : seriesPri.slice(0, seriesCur.length);
      datasets.push({
        label: `${chartComparePriLabel} (prior)`,
        data: priSeries,
        borderColor: '#94a3b8',
        backgroundColor: 'transparent',
        borderDash: [5, 4],
        tension: 0.3,
        spanGaps: false,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHitRadius: 12,
        pointHoverBackgroundColor: '#94a3b8',
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2,
        borderWidth: 2,
      });
    }
    return { labels, datasets };
  }, [
    seriesCur,
    seriesPri,
    curLabel,
    chartComparePriLabel,
    curDates,
    showCompare,
    compareMode,
    priFrom,
    priTo,
  ]);

  const cumulativeChartSub = useMemo(() => {
    if (!showCompare) {
      return `Running total through ${curLabel} — hover a day for values`;
    }
    if (compareMode === 'mom') {
      return `Running total, ${curLabel} (current) vs full prior month (${priLabel}) — hover a day for values`;
    }
    return `Running total, ${curLabel} vs. ${chartComparePriLabel} — hover a day for values`;
  }, [showCompare, compareMode, curLabel, priLabel, chartComparePriLabel]);

  const lineOptions = useMemo(
    () => ({
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          enabled: true,
          mode: 'index',
          intersect: false,
          backgroundColor: '#0f172a',
          titleColor: '#e2e8f0',
          bodyColor: '#f8fafc',
          borderColor: '#334155',
          borderWidth: 1,
          padding: 10,
          displayColors: true,
          callbacks: {
            title(items) {
              const item = items?.[0];
              if (!item) return '';
              return item.label || `Day ${item.dataIndex + 1}`;
            },
            label(item) {
              const val = Number(item.raw) || 0;
              return ` ${item.dataset.label}: ${fmt(val)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            maxRotation: 45,
            minRotation: 45,
            font: { size: 10 },
            autoSkip: true,
            maxTicksLimit: 15,
          },
        },
        y: { ticks: { callback: (v) => fmt(v) } },
      },
    }),
    []
  );

  const sourceChart = useMemo(
    () =>
      buildSourceChart(
        isVdp ? channelVdpRows : channelPageRows,
        metricLabel,
        isVdp ? '#2563eb' : '#93c5fd'
      ),
    [isVdp, channelPageRows, channelVdpRows, metricLabel]
  );

  const sourceCompareChart = useMemo(
    () =>
      buildSourceCompareChart(
        isVdp ? channelVdpRows : channelPageRows,
        isVdp ? channelVdpPriRows : channelPagePriRows,
        curLabel,
        priLabel,
        isVdp ? '#2563eb' : '#93c5fd',
        '#858B9A'
      ),
    [
      isVdp,
      channelVdpRows,
      channelVdpPriRows,
      channelPageRows,
      channelPagePriRows,
      curLabel,
      priLabel,
    ]
  );

  const sourceOptions = useMemo(
    () => ({
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
      },
      scales: {
        x: { ticks: { font: { size: 10.5 }, maxRotation: 0 } },
        y: { ticks: { callback: (v) => fmt(v) } },
      },
    }),
    []
  );

  const newUsedChart = useMemo(
    () => buildNewUsedChart(conditionRows),
    [conditionRows]
  );

  const newUsedPriChart = useMemo(
    () => buildNewUsedChart(conditionPriRows),
    [conditionPriRows]
  );

  const newUsedTotal =
    (newUsedChart.datasets[0]?.data?.[0] || 0) +
    (newUsedChart.datasets[0]?.data?.[1] || 0);
  const newUsedPriTotal =
    (newUsedPriChart.datasets[0]?.data?.[0] || 0) +
    (newUsedPriChart.datasets[0]?.data?.[1] || 0);
  const newUsedMom = safeDiv(newUsedTotal - newUsedPriTotal, newUsedPriTotal) * 100;

  const unknownTotal = useMemo(
    () => sumUnknownViews(conditionRows),
    [conditionRows]
  );
  const unknownPriTotal = useMemo(
    () => sumUnknownViews(conditionPriRows),
    [conditionPriRows]
  );

  const donutOptions = useMemo(
    () => ({
      cutout: '55%',
      plugins: {
        legend: { display: false },
      },
    }),
    []
  );

  const isBusy = dealersLoading || loading || metricSwitching;
  const softPercent = useSoftLoadPercent(metricSwitching && !loading && !dealersLoading);
  const loadPercent = progress?.total
    ? Math.round((Number(progress.completed) / Number(progress.total)) * 100)
    : metricSwitching && softPercent != null
      ? softPercent
      : isBusy
        ? 0
        : null;

  if (!dealersLoading && (!client || isAllDealer || !ga4Id)) {
    return (
      <div className="vdp-view">
        <div className="vdp-card" style={{ padding: 20 }}>
          <h3>Select a dealer</h3>
          <div className="vdp-cardsub" style={{ marginBottom: 0 }}>
            Open All Dealers and click a dealer row, or pick one from the dealer bar above.
            {!ga4Id && client && !isAllDealer
              ? ' This dealer has no GA4 customer ID configured.'
              : ''}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`vdp-view${isBusy ? ' vdp-view--card-loading' : ''}`}>
      <VdpLoadingCard active={isBusy} percent={loadPercent} />
      <Toolbar>
        <ToolbarGroup label="Metric">
          <Seg value={metric} options={METRIC_OPTS} onChange={handleMetricChange} />
        </ToolbarGroup>
        <ToolbarGroup label="Compare">
          <Seg
            value={compareMode}
            options={VDP_COMPARE_MODES}
            onChange={toggleCompareMode}
          />
        </ToolbarGroup>
        <ToolbarGroup label="Period">
          <span className="vdp-period-hint">
            {showCompare
              ? `${curLabel} vs ${priLabel}${compareActive ? ` (${compareModeLabel})` : ''}`
              : curLabel}
          </span>
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

      <div className={`vdp-kpi-grid${isVdp ? '' : ' vdp-kpi-grid--3'}`}>
        <Kpi
          label={`${metricLabel} · ${curLabel}`}
          value={fmt(activeCurTotal)}
          delta={showCompare ? activeMom : null}
          sub={
            showCompare
              ? `vs ${fmt(activePriTotal)} (${priLabel})`
              : curLabel
          }
        />
        {isVdp ? (
          <Kpi
            label="VDP Rate (VDP / Page Views)"
            value={`${rateCur.toFixed(1)}%`}
            delta={showCompare ? rateCur - ratePri : null}
            sub={
              showCompare
                ? `vs ${ratePri.toFixed(1)}% prior`
                : 'Current period'
            }
            isPP
          />
        ) : null}
        <Kpi
          label={`Avg ${isVdp ? 'VDP' : 'Page'} Views / Day`}
          value={fmt(avgPerDay)}
          sub={`${dayCount} day${dayCount === 1 ? '' : 's'} in period`}
        />
        {isVdp ? (
          <Kpi
            label="New + Used VDP"
            value={fmt(newUsedTotal)}
            delta={showCompare ? newUsedMom : null}
            sub={
              showCompare
                ? `Unknown ${fmt(unknownTotal)} vs ${fmt(unknownPriTotal)} (${priLabel})`
                : `Unknown ${fmt(unknownTotal)} · Condition share below`
            }
          />
        ) : (
          <Kpi
            label={`Prior ${metricLabel}`}
            value={showCompare ? fmt(activePriTotal) : '—'}
            sub={showCompare ? priLabel : 'Compare period off'}
          />
        )}
      </div>

      {isVdp ? (
        <>
          {showCompare ? (
            <>
              <Card
                className="vdp-card--chart"
                title={`Cumulative ${metricLabel}`}
                sub={cumulativeChartSub}
                style={{ marginBottom: 16 }}
              >
                <VdpChart
                  key={`ov-line-${metric}-cmp`}
                  type="line"
                  data={lineData}
                  options={lineOptions}
                  height={180}
                />
              </Card>

              <div className="vdp-grid-2 vdp-grid-2--equal vdp-grid-2--overview">
                <Card title="Top 5 Vehicles by VDP Views" sub={`${curLabel} · current`}>
                  <TopVehiclesTable rows={topVehicles} showMom={false} />
                </Card>
                <Card title="Top 5 Vehicles by VDP Views" sub={`${priLabel} · prior`}>
                  <TopVehiclesTable rows={topVehiclesPri} showMom={false} />
                </Card>
              </div>

              <Card
                className="vdp-card--chart"
                title="VDP Views by Source"
                sub={`${curLabel} vs ${priLabel} · VDP pages only`}
                style={{ marginBottom: 16 }}
              >
                {!sourceCompareChart.labels.length ? (
                  <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
                    No channel data for this period.
                  </div>
                ) : (
                  <VdpChart
                    key={`ov-source-cmp-${metric}`}
                    type="bar"
                    data={sourceCompareChart}
                    options={sourceOptions}
                    height={200}
                  />
                )}
              </Card>

              <div className="vdp-grid-2 vdp-grid-2--equal vdp-grid-2--overview">
                <Card title="New vs. Used — VDP Share" sub={`${curLabel} · current`}>
                  {!(
                    newUsedChart.datasets[0]?.data?.[0] ||
                    newUsedChart.datasets[0]?.data?.[1]
                  ) ? (
                    <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
                      No New/Used VDP data for this period.
                    </div>
                  ) : (
                    <>
                      <VdpChart
                        key="ov-donut-cur"
                        type="doughnut"
                        data={newUsedChart}
                        options={donutOptions}
                        height={150}
                      />
                      <NewUsedLegend chart={newUsedChart} />
                    </>
                  )}
                </Card>
                <Card title="New vs. Used — VDP Share" sub={`${priLabel} · prior`}>
                  {!(
                    newUsedPriChart.datasets[0]?.data?.[0] ||
                    newUsedPriChart.datasets[0]?.data?.[1]
                  ) ? (
                    <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
                      No New/Used VDP data for this period.
                    </div>
                  ) : (
                    <>
                      <VdpChart
                        key="ov-donut-pri"
                        type="doughnut"
                        data={newUsedPriChart}
                        options={donutOptions}
                        height={150}
                      />
                      <NewUsedLegend chart={newUsedPriChart} />
                    </>
                  )}
                </Card>
              </div>
            </>
          ) : (
            <>
              <div className="vdp-grid-2 vdp-grid-2--overview">
                <Card
                  title={`Cumulative ${metricLabel}`}
                  sub={`Running total · ${curLabel}`}
                >
                  <VdpChart
                    key={`ov-line-${metric}`}
                    type="line"
                    data={lineData}
                    options={lineOptions}
                    height={180}
                  />
                </Card>

                <Card
                  title="Top 5 Vehicles by VDP Views"
                  sub="Current period · smart_final_data"
                >
                  <TopVehiclesTable
                    rows={topVehicles}
                    showMom
                    comparePctLabel={comparePctLabel}
                  />
                </Card>
              </div>

              <div className="vdp-grid-2 vdp-grid-2--overview">
                <Card
                  title={`${metricLabel} by Source`}
                  sub={`${curLabel} · VDP pages only`}
                >
                  {!sourceChart.labels.length ? (
                    <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
                      No channel data for this period.
                    </div>
                  ) : (
                    <VdpChart
                      key={`ov-source-${metric}`}
                      type="bar"
                      data={sourceChart}
                      options={sourceOptions}
                      height={160}
                    />
                  )}
                </Card>

                <Card
                  title="New vs. Used — VDP Share"
                  sub="Current period · smart_final_data"
                >
                  {!(
                    newUsedChart.datasets[0]?.data?.[0] ||
                    newUsedChart.datasets[0]?.data?.[1]
                  ) ? (
                    <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
                      No New/Used VDP data for this period.
                    </div>
                  ) : (
                    <>
                      <VdpChart
                        type="doughnut"
                        data={newUsedChart}
                        options={donutOptions}
                        height={150}
                      />
                      <NewUsedLegend chart={newUsedChart} />
                    </>
                  )}
                </Card>
              </div>
            </>
          )}

          <VdpChannelCmpTable
            clientId={ga4Id}
            from={curFrom}
            to={curTo}
            priorFrom={priFrom}
            priorTo={priTo}
            compareMode={compareMode}
            metric="vdp"
          />
        </>
      ) : (
        <>
          <Card
            className="vdp-card--chart vdp-card--page-compare"
            title="Cumulative Page Views"
            sub={cumulativeChartSub}
            style={{ marginBottom: 16 }}
          >
            <div className="vdp-chart-fill vdp-chart-fill--page">
              <VdpChart
                key={`ov-line-${metric}`}
                type="line"
                data={lineData}
                options={lineOptions}
                fill
                animate
              />
            </div>
          </Card>

          <Card
            className="vdp-card--chart"
            title="Page Views by Source"
            sub={
              showCompare
                ? `${curLabel} vs ${priLabel} · all page views`
                : `${curLabel} · all page views`
            }
          >
            {!(showCompare ? sourceCompareChart : sourceChart).labels.length ? (
              <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
                No channel data for this period.
              </div>
            ) : (
              <div className="vdp-chart-fill vdp-chart-fill--page-source">
                <VdpChart
                  key={`ov-source-${metric}-${showCompare ? 'cmp' : 'single'}`}
                  type="bar"
                  data={showCompare ? sourceCompareChart : sourceChart}
                  options={sourceOptions}
                  fill
                  animate
                />
              </div>
            )}
          </Card>

          <VdpChannelCmpTable
            clientId={ga4Id}
            from={curFrom}
            to={curTo}
            priorFrom={priFrom}
            priorTo={priTo}
            compareMode={compareMode}
            metric="page"
          />
        </>
      )}
    </div>
  );
}
