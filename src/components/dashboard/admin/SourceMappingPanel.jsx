'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useClient } from '@/components/dashboard/ClientContext';
import {
  CHANNEL_PALETTE,
  UNMAPPED_ID,
  defaultChannels,
  defaultMappingEntries,
  rawPairKey,
} from '@/lib/sourceMapping/defaults';
import { aggregateRawToChannels, toMappingMap } from '@/lib/sourceMapping/apply';
import { buildPeriods } from '@/lib/vdp/mockData';
import { invalidateSourceMappingCache } from '@/lib/api/sourceMapping';
import VdpLoadingBanner, { VdpLoadingBlock } from '@/components/vdp/VdpLoadingBanner';

const MTD = buildPeriods(new Date()).mtd;

function fmt(n) {
  return Math.round(Number(n) || 0).toLocaleString();
}

function rulesFromMappingObj(mapping) {
  return Object.entries(mapping || {}).map(([key, channelId]) => {
    const [rawSource, rawMedium] = String(key).split('|||');
    return {
      rawSource: rawSource || '(direct)',
      rawMedium: rawMedium || '(none)',
      channelId,
    };
  });
}

export default function SourceMappingPanel() {
  const { dealers, client, loading: dealersLoading } = useClient();
  const [channels, setChannels] = useState(defaultChannels());
  const [mapping, setMapping] = useState(() =>
    Object.fromEntries(
      defaultMappingEntries().map((e) => [
        rawPairKey(e.rawSource, e.rawMedium),
        e.channelId,
      ])
    )
  );
  const [rawRows, setRawRows] = useState([]);
  const [clientId, setClientId] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [bulkTarget, setBulkTarget] = useState('');
  const [loading, setLoading] = useState(true);
  const [rawLoading, setRawLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState(null);
  const [status, setStatus] = useState(null);

  const dealerOptions = useMemo(
    () =>
      (dealers || [])
        .map((d) => ({
          id: String(d.ga4CustomerId || '').trim(),
          name: d.name || d.customerName || 'Unnamed',
        }))
        .filter((d) => d.id),
    [dealers]
  );

  useEffect(() => {
    if (clientId) return;
    const fromClient = String(client?.ga4CustomerId || '').trim();
    if (fromClient) {
      setClientId(fromClient);
      return;
    }
    if (dealerOptions[0]?.id) setClientId(dealerOptions[0].id);
  }, [clientId, client, dealerOptions]);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/dashboard/source-mapping', {
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to load mapping');
      setChannels(json.channels?.length ? json.channels : defaultChannels());
      setMapping(json.mapping || {});
      setWarning(json.warning || null);
    } catch (err) {
      setError(err.message || 'Failed to load mapping');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRaw = useCallback(async () => {
    if (!clientId || !MTD.curFrom || !MTD.curTo) {
      setRawRows([]);
      return;
    }
    setRawLoading(true);
    try {
      const qs = new URLSearchParams({
        clientId,
        from: MTD.curFrom,
        to: MTD.curTo,
      });
      const res = await fetch(`/api/dashboard/source-mapping/raw?${qs}`, {
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || 'Failed to load raw sources');
        setRawRows([]);
        return;
      }
      setRawRows(json.rows || []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load raw sources');
    } finally {
      setRawLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    loadRaw();
  }, [loadRaw]);

  const mappingMap = useMemo(() => toMappingMap(mapping), [mapping]);

  const previewRows = useMemo(
    () => aggregateRawToChannels(rawRows, channels, mappingMap),
    [rawRows, channels, mappingMap]
  );

  const filteredRaw = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = rawRows.map((r) => ({
      ...r,
      channelId: mappingMap.get(rawPairKey(r.rawSource, r.rawMedium)) || UNMAPPED_ID,
    }));
    if (q) {
      rows = rows.filter(
        (r) =>
          String(r.rawSource).toLowerCase().includes(q) ||
          String(r.rawMedium).toLowerCase().includes(q)
      );
    }
    return rows;
  }, [rawRows, mappingMap, search]);

  const channelCounts = useMemo(() => {
    const counts = Object.fromEntries(channels.map((c) => [c.id, 0]));
    for (const r of rawRows) {
      const id = mappingMap.get(rawPairKey(r.rawSource, r.rawMedium)) || UNMAPPED_ID;
      counts[id] = (counts[id] || 0) + 1;
    }
    for (const [key, channelId] of Object.entries(mapping)) {
      const inRaw = rawRows.some(
        (r) => rawPairKey(r.rawSource, r.rawMedium) === key
      );
      if (!inRaw) counts[channelId] = (counts[channelId] || 0) + 1;
    }
    return counts;
  }, [channels, rawRows, mapping, mappingMap]);

  const pvByChannel = useMemo(() => {
    return Object.fromEntries(previewRows.map((r) => [r.id, r.pageViews]));
  }, [previewRows]);

  const persist = async (nextChannels, nextMapping, { reset = false } = {}) => {
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const res = await fetch('/api/dashboard/source-mapping', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          reset
            ? { reset: true }
            : {
                channels: nextChannels,
                rules: rulesFromMappingObj(nextMapping),
              }
        ),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          [json.error, json.hint].filter(Boolean).join(' ') || 'Save failed'
        );
      }
      setChannels(json.channels?.length ? json.channels : nextChannels);
      setMapping(json.mapping || nextMapping);
      setWarning(json.warning || null);
      invalidateSourceMappingCache();
      setStatus('Saved — Traffic and All Dealers columns will use this mapping.');
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const assignOne = (rawSource, rawMedium, channelId) => {
    const key = rawPairKey(rawSource, rawMedium);
    const next = { ...mapping, [key]: channelId };
    setMapping(next);
    persist(channels, next);
  };

  const addChannel = () => {
    const color = CHANNEL_PALETTE[channels.length % CHANNEL_PALETTE.length];
    const id = `ch-${Date.now()}`;
    const idx = channels.findIndex((c) => c.id === UNMAPPED_ID);
    const next = [...channels];
    const row = {
      id,
      name: 'New Channel',
      color,
      sortOrder: (idx < 0 ? next.length : idx) * 10,
      isUnmapped: false,
    };
    if (idx < 0) next.push(row);
    else next.splice(idx, 0, row);
    setChannels(next);
    persist(next, mapping);
  };

  const renameChannel = (id, name) => {
    const next = channels.map((c) =>
      c.id === id ? { ...c, name: name || c.name } : c
    );
    setChannels(next);
    persist(next, mapping);
  };

  const deleteChannel = (id) => {
    if (id === UNMAPPED_ID) return;
    const nextMapping = { ...mapping };
    for (const k of Object.keys(nextMapping)) {
      if (nextMapping[k] === id) nextMapping[k] = UNMAPPED_ID;
    }
    const nextChannels = channels.filter((c) => c.id !== id);
    setChannels(nextChannels);
    setMapping(nextMapping);
    persist(nextChannels, nextMapping);
  };

  const mergeChannel = (fromId, intoId) => {
    if (!intoId || fromId === intoId) return;
    const nextMapping = { ...mapping };
    for (const k of Object.keys(nextMapping)) {
      if (nextMapping[k] === fromId) nextMapping[k] = intoId;
    }
    const nextChannels =
      fromId === UNMAPPED_ID
        ? channels
        : channels.filter((c) => c.id !== fromId);
    setChannels(nextChannels);
    setMapping(nextMapping);
    persist(nextChannels, nextMapping);
  };

  const resetMapping = () => {
    const ch = defaultChannels();
    const map = Object.fromEntries(
      defaultMappingEntries().map((e) => [
        rawPairKey(e.rawSource, e.rawMedium),
        e.channelId,
      ])
    );
    setChannels(ch);
    setMapping(map);
    setSelected(new Set());
    persist(ch, map, { reset: true });
  };

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = (checked) => {
    if (!checked) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(filteredRaw.map((r) => r.id)));
  };

  const applyBulk = () => {
    if (!bulkTarget || selected.size === 0) return;
    const next = { ...mapping };
    for (const r of filteredRaw) {
      if (!selected.has(r.id)) continue;
      next[rawPairKey(r.rawSource, r.rawMedium)] = bulkTarget;
    }
    setMapping(next);
    setSelected(new Set());
    persist(channels, next);
  };

  if (loading) {
    return (
      <div className="src-map-page">
        <VdpLoadingBanner
          active
          label="Loading source mapping…"
          detail="Fetching channels and mapping rules"
        />
        <VdpLoadingBlock label="Preparing Source Mapping…" minHeight={220} />
      </div>
    );
  }

  return (
    <div className="src-map-page">
      <VdpLoadingBanner
        active={rawLoading || saving}
        label={saving ? 'Saving mapping…' : 'Loading raw sources…'}
        detail={
          saving
            ? 'Updating channel rules for Traffic and All Dealers'
            : 'Fetching source / medium rows for preview dealer'
        }
      />
      <div className="src-map-card">
        <h3 className="src-map-h3">How this works</h3>
        <p className="src-map-sub" style={{ marginBottom: 0 }}>
          GA4 reports traffic as raw <code>source / medium</code> pairs —{' '}
          <code>google / organic</code>, <code>facebook / paid</code>, and so on.
          Map each raw source into a clean channel (the column names used on Traffic
          and All Dealers). Renaming, merging, or reassigning here updates those
          pages after save. Mapping is shared across all dealers; view counts below
          are for the dealer selected for preview.
        </p>
      </div>

      {(error || warning || status) && (
        <div className="src-map-card">
          {error && <p className="src-map-msg src-map-msg--err">{error}</p>}
          {warning && <p className="src-map-msg src-map-msg--warn">{warning}</p>}
          {status && <p className="src-map-msg src-map-msg--ok">{status}</p>}
        </div>
      )}

      <div className="src-map-toolbar">
        <label>
          Preview dealer
          <select
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="src-map-select"
            disabled={dealersLoading || !dealerOptions.length}
          >
            {!dealerOptions.length && <option value="">No dealers</option>}
            {dealerOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <span className="src-map-meta">
          MTD {MTD.curLabel}
          {rawLoading ? ' · Loading raw…' : ''}
          {saving ? ' · Saving…' : ''}
        </span>
      </div>

      <div className="src-map-grid2">
        <div className="src-map-card src-map-card--panel">
          <h3 className="src-map-h3">Channels</h3>
          <p className="src-map-sub">
            Rename, merge, or delete. &quot;Unmapped&quot; catches anything not yet
            assigned.
          </p>
          <div className="src-map-table-wrap">
            <table className="src-map-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th className="right">Raw Sources</th>
                  <th className="right">Page Views (MTD)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {channels.map((ch) => (
                  <tr key={ch.id}>
                    <td>
                      <span
                        className="src-map-swatch"
                        style={{ background: ch.color }}
                      />
                      <input
                        type="text"
                        className="src-map-rename"
                        defaultValue={ch.name}
                        key={`${ch.id}-${ch.name}`}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v && v !== ch.name) renameChannel(ch.id, v);
                        }}
                      />
                    </td>
                    <td className="right src-map-num">{channelCounts[ch.id] || 0}</td>
                    <td className="right src-map-num">{fmt(pvByChannel[ch.id] || 0)}</td>
                    <td className="right src-map-actions">
                      <select
                        className="src-map-select src-map-select--sm"
                        defaultValue=""
                        onChange={(e) => {
                          if (e.target.value) {
                            mergeChannel(ch.id, e.target.value);
                            e.target.value = '';
                          }
                        }}
                      >
                        <option value="">Merge into…</option>
                        {channels
                          .filter((c) => c.id !== ch.id)
                          .map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                      </select>
                      {ch.id !== UNMAPPED_ID && (
                        <button
                          type="button"
                          className="src-map-btn src-map-btn--danger"
                          onClick={() => deleteChannel(ch.id)}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="src-map-btn-row">
            <button type="button" className="src-map-btn" onClick={addChannel}>
              + Add Channel
            </button>
            <button type="button" className="src-map-btn" onClick={resetMapping}>
              Reset to Default Mapping
            </button>
          </div>
        </div>

        <div className="src-map-card src-map-card--panel">
          <h3 className="src-map-h3">Live Preview — Channel Totals</h3>
          <p className="src-map-sub">
            Month-to-date, selected dealer. This is what the Traffic tab will show.
          </p>
          <div className="src-map-table-wrap">
            <table className="src-map-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th className="right">Page Views</th>
                  <th className="right">VDP Views</th>
                  <th className="right">VDP Rate</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="src-map-empty">
                      Nothing mapped yet
                    </td>
                  </tr>
                ) : (
                  previewRows.map((r) => {
                    const rate =
                      r.pageViews > 0 ? (r.vdpViews / r.pageViews) * 100 : 0;
                    return (
                      <tr key={r.id}>
                        <td>
                          <span
                            className="src-map-swatch"
                            style={{ background: r.color }}
                          />
                          {r.name}
                        </td>
                        <td className="right src-map-num">{fmt(r.pageViews)}</td>
                        <td className="right src-map-num">{fmt(r.vdpViews)}</td>
                        <td className="right src-map-num">{rate.toFixed(1)}%</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="src-map-card">
        <h3 className="src-map-h3">
          Raw Sources{' '}
          <span className="src-map-count">
            ({filteredRaw.length}
            {search ? ` of ${rawRows.length}` : ''})
          </span>
        </h3>
        <p className="src-map-sub">
          Select rows to bulk-assign, or change a single row&apos;s channel from its
          dropdown.
        </p>
        <div className="src-map-toolbar" style={{ marginBottom: 10 }}>
          <label>
            Search
            <input
              type="text"
              className="src-map-search"
              placeholder="source, medium..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          {selected.size > 0 && (
            <div className="src-map-bulk">
              <span>{selected.size} selected</span>
              <select
                className="src-map-select"
                value={bulkTarget}
                onChange={(e) => setBulkTarget(e.target.value)}
              >
                <option value="">Assign to…</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button type="button" className="src-map-btn" onClick={applyBulk}>
                Assign
              </button>
              <button
                type="button"
                className="src-map-btn"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </button>
            </div>
          )}
        </div>
        <div className="src-map-table-wrap src-map-table-wrap--raw">
          <table className="src-map-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    checked={
                      filteredRaw.length > 0 &&
                      filteredRaw.every((r) => selected.has(r.id))
                    }
                    onChange={(e) => selectAllVisible(e.target.checked)}
                  />
                </th>
                <th>Raw Source</th>
                <th>Raw Medium</th>
                <th className="right">Page Views (MTD)</th>
                <th className="right">VDP Views (MTD)</th>
                <th>Mapped Channel</th>
              </tr>
            </thead>
            <tbody>
              {filteredRaw.length === 0 ? (
                <tr>
                  <td colSpan={6} className="src-map-empty">
                    {rawLoading
                      ? 'Loading…'
                      : 'No raw sources for this dealer / period. Deploy source_mapping.sql if the RPC is missing.'}
                  </td>
                </tr>
              ) : (
                filteredRaw.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggleSelect(r.id)}
                      />
                    </td>
                    <td>{r.rawSource}</td>
                    <td>{r.rawMedium}</td>
                    <td className="right src-map-num">{fmt(r.pageViews)}</td>
                    <td className="right src-map-num">{fmt(r.vdpViews)}</td>
                    <td>
                      <select
                        className="src-map-select"
                        value={r.channelId}
                        onChange={(e) =>
                          assignOne(r.rawSource, r.rawMedium, e.target.value)
                        }
                      >
                        {channels.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
