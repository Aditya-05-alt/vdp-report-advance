'use client';

import { useEffect, useState } from 'react';
import OverviewView from './OverviewView';
import TrafficView from './TrafficView';
import InventoryView from './InventoryView';

const TAB_IDS = ['overview', 'traffic', 'inventory'];

/**
 * Keep dealer Overview / Traffic / Inventory mounted after first visit
 * so tab switches are instant (no remount + refetch).
 * Remounts when clientKey (dealer) changes.
 */
function DealerViewsKeepAliveInner({ activeView }) {
  const [mounted, setMounted] = useState(() => ({
    overview: activeView === 'overview',
    traffic: activeView === 'traffic',
    inventory: activeView === 'inventory',
  }));

  useEffect(() => {
    if (!TAB_IDS.includes(activeView)) return;
    setMounted((prev) =>
      prev[activeView] ? prev : { ...prev, [activeView]: true }
    );
  }, [activeView]);

  // Help Chart.js fill charts remeasure after a hidden pane is shown again
  useEffect(() => {
    if (!TAB_IDS.includes(activeView)) return undefined;
    const id = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
    return () => window.cancelAnimationFrame(id);
  }, [activeView]);

  return (
    <div className="vdp-dealer-keep-alive">
      {mounted.overview ? (
        <div
          className={`vdp-tab-pane${activeView === 'overview' ? ' is-active' : ''}`}
          aria-hidden={activeView !== 'overview'}
        >
          <OverviewView />
        </div>
      ) : null}
      {mounted.traffic ? (
        <div
          className={`vdp-tab-pane${activeView === 'traffic' ? ' is-active' : ''}`}
          aria-hidden={activeView !== 'traffic'}
        >
          <TrafficView />
        </div>
      ) : null}
      {mounted.inventory ? (
        <div
          className={`vdp-tab-pane${activeView === 'inventory' ? ' is-active' : ''}`}
          aria-hidden={activeView !== 'inventory'}
        >
          <InventoryView />
        </div>
      ) : null}
    </div>
  );
}

export default function DealerViewsKeepAlive({ activeView, clientKey }) {
  return (
    <DealerViewsKeepAliveInner
      key={clientKey || 'no-dealer'}
      activeView={activeView}
    />
  );
}
