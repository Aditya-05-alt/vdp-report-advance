'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '@/components/dashboard/ClientContext';
import { fetchCampaignViews } from '@/lib/api/campaignViews';
import { fmt } from '@/lib/vdp/aggregates';
import { isAllDealerClient } from '@/lib/dashboard/allDealers';
import VdpChart from './VdpChart';
import VdpLoadingBanner, { VdpLoadingBlock } from './VdpLoadingBanner';
import { useVdpDateRange } from './VdpDateRangeContext';
import { Card, Kpi, Seg, Toolbar, ToolbarGroup } from './VdpUi';

const PAGE_TYPE_OPTS = [
  { value: 'ALL', label: 'All Page Views' },
  { value: 'VDP', label: 'VDP Only' },
];

const WA_PREFIX_HINT = 'WA| / WA | campaigns only';

function aggregateByCampaign(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const name = String(row.campaign || '(not set)');
    const prev = map.get(name) || {
      campaign: name,
      views: 0,
      sessions: 0,
      total_users: 0,
      new_users: 0,
    };
    prev.views += Number(row.views) || 0;
    prev.sessions += Number(row.sessions) || 0;
    prev.total_users += Number(row.total_users) || 0;
    prev.new_users += Number(row.new_users) || 0;
    map.set(name, prev);
  }
  const sorted = [...map.values()].sort((a, b) => b.views - a.views);
  const total = sorted.reduce((s, r) => s + r.views, 0);
  return sorted.map((r, i) => ({
    ...r,
    rank: i + 1,
    pct: total > 0 ? Math.round((r.views / total) * 10000) / 100 : 0,
  }));
}

export default function CampaignsView() {
  const { client, loading: dealersLoading, isAllDealer } = useClient();
  const { from: curFrom, to: curTo, curLabel } = useVdpDateRange();

  const [pageType, setPageType] = useState('ALL');
  const [campaignSort, setCampaignSort] = useState({ k: 'views', dir: -1 });
  const [dailySort, setDailySort] = useState({ k: 'report_date', dir: 1 });
  const [campaigns, setCampaigns] = useState([]);
  const [daily, setDaily] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const cancelRef = useRef(false);
  const loadGenRef = useRef(0);

  const ga4Id = String(client?.ga4CustomerId || '').trim();
  const dealerName = client?.name || 'Dealer';
  const canLoad =
    Boolean(ga4Id) && !isAllDealerClient(client) && !isAllDealer;

  useEffect(() => {
    setCampaigns([]);
    setDaily([]);
    setError(null);
  }, [ga4Id]);

  const load = useCallback(async () => {
    if (!canLoad || !curFrom || !curTo) {
      setCampaigns([]);
      setDaily([]);
      return;
    }

    const loadGen = loadGenRef.current + 1;
    loadGenRef.current = loadGen;
    cancelRef.current = false;
    const requestedClientId = ga4Id;
    const isStale = () =>
      cancelRef.current ||
      loadGenRef.current !== loadGen ||
      requestedClientId !== String(client?.ga4CustomerId || '').trim();

    setLoading(true);
    setError(null);
    setCampaigns([]);
    setDaily([]);

    try {
      const data = await fetchCampaignViews({
        clientId: requestedClientId,
        from: curFrom,
        to: curTo,
        pageType,
        onCancelCheck: () => isStale(),
      });
      if (isStale() || data == null) return;
      setCampaigns(data.campaigns || []);
      setDaily(data.daily || []);
    } catch (err) {
      if (!isStale()) {
        setError(err?.message || 'Failed to load campaign views.');
        setCampaigns([]);
        setDaily([]);
      }
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [canLoad, ga4Id, client?.ga4CustomerId, curFrom, curTo, pageType]);

  useEffect(() => {
    if (dealersLoading) return undefined;
    load();
    return () => {
      cancelRef.current = true;
    };
  }, [dealersLoading, load]);

  const byCampaign = useMemo(
    () => aggregateByCampaign(campaigns),
    [campaigns]
  );

  const sortedCampaigns = useMemo(() => {
    const list = [...byCampaign];
    list.sort((a, b) => {
      const av = a[campaignSort.k];
      const bv = b[campaignSort.k];
      if (typeof av === 'string') return av.localeCompare(bv) * campaignSort.dir;
      return ((av || 0) - (bv || 0)) * campaignSort.dir;
    });
    return list;
  }, [byCampaign, campaignSort]);

  const sortedDaily = useMemo(() => {
    const list = [...daily];
    list.sort((a, b) => {
      const av = a[dailySort.k];
      const bv = b[dailySort.k];
      if (typeof av === 'string') return av.localeCompare(bv) * dailySort.dir;
      return ((av || 0) - (bv || 0)) * dailySort.dir;
    });
    return list;
  }, [daily, dailySort]);

  const totalViews = useMemo(
    () => byCampaign.reduce((s, r) => s + r.views, 0),
    [byCampaign]
  );
  const dailyTotal = useMemo(
    () => daily.reduce((s, r) => s + r.views, 0),
    [daily]
  );
  const topCampaign = byCampaign[0] || null;

  const campaignLineData = useMemo(() => {
    const top = byCampaign.slice(0, 20);
    return {
      labels: top.map((r) => r.campaign),
      datasets: [
        {
          label: curLabel,
          data: top.map((r) => r.views),
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: '#2563eb',
          pointBorderColor: '#2563eb',
          borderWidth: 2.5,
        },
      ],
    };
  }, [byCampaign, curLabel]);

  const dailyLineData = useMemo(
    () => ({
      labels: daily.map((r) => r.report_date),
      datasets: [
        {
          label: 'Views',
          data: daily.map((r) => r.views),
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          pointHoverRadius: 4,
          pointBackgroundColor: '#2563eb',
          pointBorderColor: '#2563eb',
          borderWidth: 2.5,
        },
      ],
    }),
    [daily]
  );

  const lineOptions = useMemo(
    () => ({
      plugins: {
        legend: {
          position: 'bottom',
          labels: { boxWidth: 12, font: { size: 11 } },
        },
      },
      scales: {
        x: {
          ticks: {
            maxRotation: 45,
            minRotation: 45,
            font: { size: 10 },
            autoSkip: true,
            maxTicksLimit: 20,
          },
        },
        y: { ticks: { callback: (v) => fmt(v) } },
      },
    }),
    []
  );

  const onCampaignSort = (k) => {
    setCampaignSort((prev) => ({
      k,
      dir: prev.k === k ? -prev.dir : -1,
    }));
  };

  const onDailySort = (k) => {
    setDailySort((prev) => ({
      k,
      dir: prev.k === k ? -prev.dir : k === 'report_date' ? 1 : -1,
    }));
  };

  const isBusy = dealersLoading || loading;
  const pageLabel = pageType === 'VDP' ? 'VDP Views' : 'Page Views';

  if (!dealersLoading && (!client || isAllDealer || !ga4Id)) {
    return (
      <div className="vdp-view">
        <div className="vdp-card" style={{ padding: 20 }}>
          <h3>Select a dealer first</h3>
          <div className="vdp-cardsub" style={{ marginBottom: 0 }}>
            Campaign Views is dealer-specific and only includes campaigns that
            start with <code>WA|</code> or <code>WA |</code>. Open{' '}
            <strong>All Dealers</strong>, click one dealer, then open this tab —
            or pick a dealer in the bar above.
            {!ga4Id && client && !isAllDealer
              ? ' This dealer has no GA4 customer ID configured.'
              : ''}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`vdp-view${isBusy ? ' vdp-view--loading' : ''}`}>
      <VdpLoadingBanner
        active={isBusy}
        label={`Loading WA campaigns for ${dealerName}…`}
        detail={`get_wa_campaign_views_advance · ${WA_PREFIX_HINT} · client_id ${ga4Id}`}
      />
      <Toolbar>
        <ToolbarGroup label="Page type">
          <Seg value={pageType} options={PAGE_TYPE_OPTS} onChange={setPageType} />
        </ToolbarGroup>
      </Toolbar>

      <div className="vdp-kpi-grid">
        <Kpi
          label={`${pageLabel} · ${curLabel}`}
          value={isBusy ? '…' : fmt(totalViews)}
          sub={dealerName}
        />
        <Kpi
          label="Campaigns"
          value={isBusy ? '…' : byCampaign.length}
          sub={WA_PREFIX_HINT}
        />
        <Kpi
          label="Top campaign"
          value={isBusy ? '…' : topCampaign?.campaign || '—'}
          sub={topCampaign ? `${fmt(topCampaign.views)} views` : dealerName}
        />
        <Kpi
          label="Days with data"
          value={isBusy ? '…' : daily.length}
          sub={daily.length ? `${fmt(dailyTotal)} date-wise total` : dealerName}
        />
      </div>

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

      <Card
        title={`${dealerName} — WA Campaign Views`}
        sub={`${pageLabel} · ${curLabel} · ${WA_PREFIX_HINT}`}
        style={{ marginBottom: 16 }}
      >
        {isBusy && !byCampaign.length ? (
          <VdpLoadingBlock label="Loading campaigns…" minHeight={140} />
        ) : !byCampaign.length ? (
          <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
            No WA| / WA | campaign data for this period.
            {!error
              ? ' If this persists, deploy get_wa_campaign_views_advance.sql in Supabase.'
              : ''}
          </div>
        ) : (
          <VdpChart
            type="line"
            data={campaignLineData}
            options={lineOptions}
            height={120}
          />
        )}
      </Card>

      <Card
        title={`${dealerName} — WA Campaign Detail`}
        sub={`${WA_PREFIX_HINT} · click a column to sort`}
        style={{ marginBottom: 16 }}
      >
        {isBusy && !sortedCampaigns.length ? (
          <VdpLoadingBlock label="Loading campaign detail…" minHeight={100} />
        ) : !sortedCampaigns.length ? (
          <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
            No WA| / WA | campaign rows for this period.
          </div>
        ) : (
          <>
            <div className="vdp-table-scroll vdp-table-scroll--10">
              <table className="vdp-table">
                <thead>
                  <tr>
                    {[
                      ['rank', '#'],
                      ['campaign', 'Session Campaign'],
                      ['views', 'Views'],
                      ['sessions', 'Sessions'],
                      ['total_users', 'Users'],
                      ['new_users', 'New Users'],
                      ['pct', '% of Total'],
                    ].map(([k, label]) => (
                      <th
                        key={k}
                        className={`${k !== 'campaign' ? 'right' : ''} ${
                          campaignSort.k === k ? 'sorted' : ''
                        }`}
                        onClick={() => onCampaignSort(k)}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedCampaigns.map((r) => (
                    <tr key={r.campaign}>
                      <td className="right mono">{r.rank}</td>
                      <td>{r.campaign}</td>
                      <td className="right mono">{fmt(r.views)}</td>
                      <td className="right mono">{fmt(r.sessions)}</td>
                      <td className="right mono">{fmt(r.total_users)}</td>
                      <td className="right mono">{fmt(r.new_users)}</td>
                      <td className="right mono">{r.pct.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sortedCampaigns.length > 10 && (
              <div className="vdp-scroll-hint">
                Showing 10 of {sortedCampaigns.length} campaigns — scroll for more
              </div>
            )}
          </>
        )}
      </Card>

      <Card
        title={`${dealerName} — Date-wise Views (WA campaigns)`}
        sub={`${pageLabel} · ${curLabel} · WA| / WA | rows only`}
        style={{ marginBottom: 16 }}
      >
        {isBusy && !daily.length ? (
          <VdpLoadingBlock label="Loading date-wise views…" minHeight={140} />
        ) : !daily.length ? (
          <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
            No date-wise data for this period.
          </div>
        ) : (
          <VdpChart
            type="line"
            data={dailyLineData}
            options={lineOptions}
            height={120}
          />
        )}
      </Card>

      <Card
        title={`${dealerName} — Date-wise Detail (WA campaigns)`}
        sub="WA| / WA | only · one row per report_date · click a column to sort"
      >
        {isBusy && !sortedDaily.length ? (
          <VdpLoadingBlock label="Loading date detail…" minHeight={100} />
        ) : !sortedDaily.length ? (
          <div style={{ color: 'var(--vdp-muted)', fontSize: 13, padding: 12 }}>
            No daily rows for this period.
          </div>
        ) : (
          <>
            <div className="vdp-table-scroll vdp-table-scroll--10">
              <table className="vdp-table">
                <thead>
                  <tr>
                    {[
                      ['report_date', 'Date'],
                      ['views', 'Views'],
                    ].map(([k, label]) => (
                      <th
                        key={k}
                        className={`${k !== 'report_date' ? 'right' : ''} ${
                          dailySort.k === k ? 'sorted' : ''
                        }`}
                        onClick={() => onDailySort(k)}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedDaily.map((r) => (
                    <tr key={r.report_date}>
                      <td className="mono">{r.report_date}</td>
                      <td className="right mono">{fmt(r.views)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total</td>
                    <td className="right mono">{fmt(dailyTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {sortedDaily.length > 10 && (
              <div className="vdp-scroll-hint">
                Showing 10 of {sortedDaily.length} days — scroll for more
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
