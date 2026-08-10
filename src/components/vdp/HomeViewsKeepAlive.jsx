'use client';

import { useEffect, useState } from 'react';
import PortfolioView from './PortfolioView';
import SourceMappingPanel from '@/components/dashboard/admin/SourceMappingPanel';

const TAB_IDS = ['portfolio', 'source-mapping'];

/**
 * Keep All Dealers + Source Mapping mounted after first visit
 * so home tab switches are instant.
 */
export default function HomeViewsKeepAlive({ activeView }) {
  const [mounted, setMounted] = useState(() => ({
    portfolio: activeView === 'portfolio',
    'source-mapping': activeView === 'source-mapping',
  }));

  useEffect(() => {
    if (!TAB_IDS.includes(activeView)) return;
    setMounted((prev) =>
      prev[activeView] ? prev : { ...prev, [activeView]: true }
    );
  }, [activeView]);

  useEffect(() => {
    if (!TAB_IDS.includes(activeView)) return undefined;
    const id = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
    return () => window.cancelAnimationFrame(id);
  }, [activeView]);

  return (
    <div className="vdp-home-keep-alive">
      {mounted.portfolio ? (
        <div
          className={`vdp-tab-pane${activeView === 'portfolio' ? ' is-active' : ''}`}
          aria-hidden={activeView !== 'portfolio'}
        >
          <PortfolioView />
        </div>
      ) : null}
      {mounted['source-mapping'] ? (
        <div
          className={`vdp-tab-pane${activeView === 'source-mapping' ? ' is-active' : ''}`}
          aria-hidden={activeView !== 'source-mapping'}
        >
          <SourceMappingPanel />
        </div>
      ) : null}
    </div>
  );
}
