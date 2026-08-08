'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchChannelBreakdown } from '@/lib/api/dashboardApi';
import { colorForChannel } from '@/lib/ga4/channelDisplay';
import {
  mergeChannelComparison,
  periodMonthLabel,
  previousMonthAlignedRange,
} from '@/lib/overview/comparePeriod';
import Delta from '@/components/dashboard/Delta';

/**
 * VDP Views by Channel — always Current + Prior + MoM.
 * Independent of the Overview Compare period toggle.
 */
export default function VdpChannelCmpTable({ clientId, from, to }) {
  const [curRows, setCurRows] = useState([]);
  const [cmpRows, setCmpRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const cancelRef = useRef(false);
  const loadGenRef = useRef(0);

  const { priorFrom, priorTo } = useMemo(() => {
    const aligned = previousMonthAlignedRange(from, to);
    return {
      priorFrom: aligned.compareFrom || null,
      priorTo: aligned.compareTo || null,
    };
  }, [from, to]);

  const currentPeriodLabel = useMemo(
    () => periodMonthLabel(from, to) || 'Current',
    [from, to]
  );
  const comparePeriodLabel = useMemo(
    () => periodMonthLabel(priorFrom, priorTo) || 'Prior',
    [priorFrom, priorTo]
  );

  const load = useCallback(async () => {
    if (!clientId || !from || !to || !priorFrom || !priorTo) {
      setCurRows([]);
      setCmpRows([]);
      return;
    }

    const loadGen = loadGenRef.current + 1;
    loadGenRef.current = loadGen;
    cancelRef.current = false;
    const isStale = () => cancelRef.current || loadGenRef.current !== loadGen;

    setLoading(true);
    setError(null);

    try {
      const [cur, cmp] = await Promise.all([
        fetchChannelBreakdown({
          clientId,
          from,
          to,
          pageTypeFilter: 'VDP',
          tab: 'vdp',
          onCancelCheck: () => isStale(),
        }),
        fetchChannelBreakdown({
          clientId,
          from: priorFrom,
          to: priorTo,
          pageTypeFilter: 'VDP',
          tab: 'vdp',
          onCancelCheck: () => isStale(),
        }),
      ]);
      if (isStale()) return;
      setCurRows(cur || []);
      setCmpRows(cmp || []);
    } catch (err) {
      if (!isStale()) {
        setError(err?.message || 'Failed to load channel comparison.');
        setCurRows([]);
        setCmpRows([]);
      }
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [clientId, from, to, priorFrom, priorTo]);

  useEffect(() => {
    load();
    return () => {
      cancelRef.current = true;
    };
  }, [load]);

  const comparison = useMemo(
    () => mergeChannelComparison(curRows, cmpRows, []),
    [curRows, cmpRows]
  );

  const rowsWithColors = useMemo(
    () =>
      (comparison.rows || []).map((r, i) => ({
        ...r,
        color: colorForChannel(r.ch, i),
      })),
    [comparison.rows]
  );

  const totals = comparison.totals || {
    cur: 0,
    cmp: 0,
    ly: 0,
    delta: 0,
    curYoyDelta: 0,
  };

  const onCopy = useCallback(() => {
    const lines = [
      ['Channel', currentPeriodLabel, comparePeriodLabel, 'MoM'].join('\t'),
    ];
    rowsWithColors.forEach((r) => {
      lines.push(
        [
          r.ch,
          r.cur,
          r.cmp,
          `${r.delta >= 0 ? '+' : ''}${r.delta}%`,
        ].join('\t')
      );
    });
    lines.push(
      [
        'Total VDP',
        totals.cur,
        totals.cmp,
        `${totals.delta >= 0 ? '+' : ''}${totals.delta}%`,
      ].join('\t')
    );
    navigator.clipboard
      .writeText(lines.join('\n'))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => {});
  }, [rowsWithColors, totals, currentPeriodLabel, comparePeriodLabel]);

  return (
    <div className="vdp-card vdp-cmp-panel" style={{ marginTop: 16 }}>
      <div className="vdp-cmp-head">
        <div>
          <h3>VDP Views by Channel — Period Comparison</h3>
          <div className="vdp-cardsub" style={{ marginBottom: 0 }}>
            {currentPeriodLabel} · {comparePeriodLabel} · MoM
          </div>
        </div>
        <div className="vdp-cmp-head-actions">
          <span className="vdp-cmp-badge">Copy-ready</span>
          <button
            type="button"
            className={`vdp-cmp-copy ${copied ? 'copied' : ''}`}
            onClick={onCopy}
            disabled={loading || !!error}
          >
            {copied ? 'Copied!' : 'Copy table'}
          </button>
        </div>
      </div>

      {error ? (
        <div className="vdp-cmp-error">{error}</div>
      ) : (
        <div className="cmp-table-wrap">
          <table className="cmp-tbl cmp-tbl--period-compare">
            <thead>
              <tr>
                <th>Channel</th>
                <th className="col-cur">{currentPeriodLabel}</th>
                <th className="col-prev">{comparePeriodLabel}</th>
                <th className="col-mom">MoM</th>
              </tr>
            </thead>
            <tbody>
              {loading && rowsWithColors.length === 0 ? (
                <tr>
                  <td colSpan={4} className="cmp-table-loading">
                    Loading channel comparison…
                  </td>
                </tr>
              ) : rowsWithColors.length === 0 ? (
                <tr>
                  <td colSpan={4} className="cmp-table-loading">
                    No VDP channel data for this period.
                  </td>
                </tr>
              ) : (
                rowsWithColors.map((r) => (
                  <tr key={r.ch}>
                    <td>
                      <div className="cmp-channel-cell">
                        <div
                          className="cmp-channel-dot"
                          style={{ background: r.color }}
                        />
                        <span>{r.ch}</span>
                      </div>
                    </td>
                    <td className="col-cur">{r.cur.toLocaleString()}</td>
                    <td className="col-prev">{r.cmp.toLocaleString()}</td>
                    <td className="col-mom">
                      <Delta value={r.delta} />
                    </td>
                  </tr>
                ))
              )}
              {!loading && rowsWithColors.length > 0 && (
                <tr className="cmp-tbl-total-row">
                  <td>Total VDP</td>
                  <td className="col-cur">{totals.cur.toLocaleString()}</td>
                  <td className="col-prev">{totals.cmp.toLocaleString()}</td>
                  <td className="col-mom">
                    <Delta value={totals.delta} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="vdp-cmp-foot">
        <span className="vdp-cmp-swatch vdp-cmp-swatch--cur" />
        {currentPeriodLabel}
        <span className="vdp-cmp-swatch vdp-cmp-swatch--prev" />
        {comparePeriodLabel}
        <span className="vdp-cmp-foot-note">
          MoM: {currentPeriodLabel} vs {comparePeriodLabel}
        </span>
      </div>
    </div>
  );
}
