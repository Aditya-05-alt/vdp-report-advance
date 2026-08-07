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
import { Card, Kpi, Toolbar, ToolbarGroup } from './VdpUi';

function cumulativeFromDaily(dateList, dailyMap) {
  let running = 0;
  return dateList.map((iso) => {
    running += Number(dailyMap[iso]) || 0;
    return running;
  });
}

function sumDailyMap(dailyMap) {
  return Object.values(dailyMap || {}).reduce((s, v) => s + (Number(v) || 0), 0);
}

function conditionClass(condition) {
  const c = String(condition || '').toLowerCase();
  if (c.startsWith('new')) return 'new';
  if (c.startsWith('used')) return 'used';
  return 'used';
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
  } = useVdpDateRange();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pageCurDaily, setPageCurDaily] = useState({});
  const [pagePriDaily, setPagePriDaily] = useState({});
  const [vdpCurTotal, setVdpCurTotal] = useState(0);
  const [vdpPriTotal, setVdpPriTotal] = useState(0);
  const [uniqueUsers, setUniqueUsers] = useState(0);
  const [topVehicles, setTopVehicles] = useState([]);
  const [channelPageRows, setChannelPageRows] = useState([]);
  const [channelVdpRows, setChannelVdpRows] = useState([]);
  const [conditionRows, setConditionRows] = useState([]);
  const [progress, setProgress] = useState(null);
  const cancelRef = useRef(false);
  const loadGenRef = useRef(0);

  const ga4Id = String(client?.ga4CustomerId || '').trim();
  const canLoad = Boolean(ga4Id) && !isAllDealerClient(client) && !isAllDealer;

  const load = useCallback(async () => {
    if (!canLoad || !curFrom || !curTo) {
      setPageCurDaily({});
      setPagePriDaily({});
      setVdpCurTotal(0);
      setVdpPriTotal(0);
      setUniqueUsers(0);
      setTopVehicles([]);
      setChannelPageRows([]);
      setChannelVdpRows([]);
      setConditionRows([]);
      return;
    }

    const loadGen = loadGenRef.current + 1;
    loadGenRef.current = loadGen;
    cancelRef.current = false;
    const isStale = () => cancelRef.current || loadGenRef.current !== loadGen;

    setLoading(true);
    setError(null);
    setProgress({ completed: 0, total: 8 });

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

    try {
      const [
        ovCur,
        ovPri,
        vdpCur,
        vdpPri,
        vehicles,
        chPage,
        chVdp,
        conditions,
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
          fetchOverviewBundle({
            clientId: ga4Id,
            from: priFrom,
            to: priTo,
            onCancelCheck: () => isStale(),
          })
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
          fetchVdpDailyFiltered({
            clientId: ga4Id,
            from: priFrom,
            to: priTo,
            tab: 'vdp',
            onCancelCheck: () => isStale(),
          })
        ),
        track(
          fetchTopVdpVehicles({
            clientId: ga4Id,
            from: curFrom,
            to: curTo,
            priorFrom: priFrom,
            priorTo: priTo,
            limit: 5,
            onCancelCheck: () => isStale(),
          })
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
          fetchConditionBreakdown({
            clientId: ga4Id,
            from: curFrom,
            to: curTo,
            tab: 'vdp',
            onCancelCheck: () => isStale(),
          })
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

      setPageCurDaily(curNorm);
      setPagePriDaily(priNorm);
      setVdpCurTotal(Number(vdpCur?.total) || 0);
      setVdpPriTotal(Number(vdpPri?.total) || 0);
      setUniqueUsers(
        (ovCur?.userTotalsRows || []).reduce(
          (s, r) => s + (Number(r.total_users) || 0),
          0
        )
      );
      setTopVehicles(vehicles || []);
      setChannelPageRows(chPage || []);
      setChannelVdpRows(chVdp || []);
      setConditionRows(conditions || []);
    } catch (err) {
      if (!isStale()) {
        setError(err?.message || 'Failed to load overview.');
        setPageCurDaily({});
        setPagePriDaily({});
        setVdpCurTotal(0);
        setVdpPriTotal(0);
        setUniqueUsers(0);
        setTopVehicles([]);
        setChannelPageRows([]);
        setChannelVdpRows([]);
        setConditionRows([]);
      }
    } finally {
      if (!isStale()) {
        setLoading(false);
        setProgress(null);
      }
    }
  }, [canLoad, ga4Id, curFrom, curTo, priFrom, priTo]);

  useEffect(() => {
    if (dealersLoading) return undefined;
    load();
    return () => {
      cancelRef.current = true;
    };
  }, [dealersLoading, load]);

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

  const seriesCur = useMemo(
    () => cumulativeFromDaily(curDates, pageCurDaily),
    [curDates, pageCurDaily]
  );
  const seriesPri = useMemo(
    () => cumulativeFromDaily(priDates, pagePriDaily),
    [priDates, pagePriDaily]
  );

  const lineData = useMemo(() => {
    const labels = Array.from(
      { length: Math.max(seriesCur.length, seriesPri.length, 1) },
      (_, i) => 'Day ' + (i + 1)
    );
    return {
      labels,
      datasets: [
        {
          label: `${curLabel} (current)`,
          data: seriesCur,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2.5,
        },
        {
          label: `${priLabel} (prior)`,
          data: seriesPri,
          borderColor: '#94a3b8',
          backgroundColor: 'transparent',
          borderDash: [5, 4],
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    };
  }, [seriesCur, seriesPri, curLabel, priLabel]);

  const lineOptions = useMemo(
    () => ({
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
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

  const sourceChart = useMemo(() => {
    const pageMap = new Map(
      (channelPageRows || []).map((r) => [
        String(r.channel_bucket || '(not set)'),
        Number(r.views) || 0,
      ])
    );
    const vdpMap = new Map(
      (channelVdpRows || []).map((r) => [
        String(r.channel_bucket || '(not set)'),
        Number(r.views) || 0,
      ])
    );
    const labels = [
      ...new Set([...pageMap.keys(), ...vdpMap.keys()]),
    ].sort((a, b) => (pageMap.get(b) || 0) - (pageMap.get(a) || 0));

    return {
      labels,
      datasets: [
        {
          label: 'Page Views',
          data: labels.map((l) => pageMap.get(l) || 0),
          backgroundColor: '#93c5fd',
          borderRadius: 4,
        },
        {
          label: 'VDP Views',
          data: labels.map((l) => vdpMap.get(l) || 0),
          backgroundColor: '#2563eb',
          borderRadius: 4,
        },
      ],
    };
  }, [channelPageRows, channelVdpRows]);

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

  const newUsedChart = useMemo(() => {
    let newSum = 0;
    let usedSum = 0;
    for (const row of conditionRows || []) {
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
  }, [conditionRows]);

  const donutOptions = useMemo(
    () => ({
      cutout: '55%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
      },
    }),
    []
  );

  const isBusy = dealersLoading || loading;
  const loadPercent = progress?.total
    ? Math.round((Number(progress.completed) / Number(progress.total)) * 100)
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
        <ToolbarGroup label="Period">
          <span className="vdp-period-hint">
            {curLabel} vs {priLabel}
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

      <div className="vdp-kpi-grid">
        <Kpi
          label={`Page Views · ${curLabel}`}
          value={fmt(pageCur)}
          delta={pvMom}
          sub={`vs ${fmt(pagePri)} (${priLabel})`}
        />
        <Kpi
          label={`VDP Views · ${curLabel}`}
          value={fmt(vdpCurTotal)}
          delta={vdpMom}
          sub={`vs ${fmt(vdpPriTotal)} (${priLabel})`}
        />
        <Kpi
          label="VDP Rate (VDP / Page Views)"
          value={`${rateCur.toFixed(1)}%`}
          delta={rateCur - ratePri}
          sub={`vs ${ratePri.toFixed(1)}% prior`}
          isPP
        />
        <Kpi
          label="Unique Visitors"
          value={fmt(uniqueUsers)}
          sub={curLabel}
        />
      </div>

      <div className="vdp-grid-2 vdp-grid-2--overview">
        <Card
          title="Cumulative Page Views"
          sub={`Running total, ${curLabel} vs. ${priLabel} (aligned prior period)`}
        >
          <VdpChart type="line" data={lineData} options={lineOptions} height={180} />
        </Card>

        <Card
          title="Top 5 Vehicles by VDP Views"
          sub="Current comparison period · smart_final_data"
        >
          {!topVehicles.length ? (
            <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
              No VDP vehicle data for this period.
            </div>
          ) : (
            <table className="vdp-table">
              <thead>
                <tr>
                  <th>Vehicle</th>
                  <th className="right">VDP</th>
                  <th className="right">MoM</th>
                </tr>
              </thead>
              <tbody>
                {topVehicles.map((r) => (
                  <tr key={`${r.year}-${r.make}-${r.model}-${r.condition}`}>
                    <td>
                      {r.year} {r.make} {r.model}{' '}
                      <span className={`vdp-tag ${conditionClass(r.condition)}`}>
                        {r.condition}
                      </span>
                    </td>
                    <td className="right mono">{fmt(r.vdp1)}</td>
                    <td className={`right vdp-delta ${momClass(r.vdpmom / 100)}`}>
                      {r.vdp0 < 1 && r.vdp1 > 0 ? 'New' : pct(r.vdpmom)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="vdp-grid-2 vdp-grid-2--overview">
        <Card
          title="Views by Source"
          sub="Page views & VDP views, current comparison period"
        >
          {!sourceChart.labels.length ? (
            <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
              No channel data for this period.
            </div>
          ) : (
            <VdpChart
              type="bar"
              data={sourceChart}
              options={sourceOptions}
              height={160}
            />
          )}
        </Card>

        <Card
          title="New vs. Used — VDP Share"
          sub="Current comparison period · smart_final_data"
        >
          {!(
            newUsedChart.datasets[0]?.data?.[0] || newUsedChart.datasets[0]?.data?.[1]
          ) ? (
            <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
              No New/Used VDP data for this period.
            </div>
          ) : (
            <VdpChart
              type="doughnut"
              data={newUsedChart}
              options={donutOptions}
              height={160}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
