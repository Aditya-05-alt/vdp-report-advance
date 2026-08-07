'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  resolveVdpReportPeriod,
  VDP_DEFAULT_DATE_RANGE,
} from '@/lib/vdp/dateRange';

const VdpDateRangeContext = createContext(null);

const STORAGE_KEY = 'vdp_report_date_range';

export function VdpDateRangeProvider({ children }) {
  // Always start as Current Month on login / fresh session
  const [dateRange, setDateRangeState] = useState(VDP_DEFAULT_DATE_RANGE);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(VDP_DEFAULT_DATE_RANGE)
      );
    } catch {
      /* ignore */
    }
  }, []);

  const setDateRange = useCallback((next) => {
    setDateRangeState(next);
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  const period = useMemo(
    () => resolveVdpReportPeriod(dateRange),
    [dateRange]
  );

  const value = useMemo(
    () => ({
      dateRange,
      setDateRange,
      period,
      from: period.from,
      to: period.to,
      priorFrom: period.priorFrom,
      priorTo: period.priorTo,
      curLabel: period.curLabel,
      priLabel: period.priLabel,
    }),
    [dateRange, setDateRange, period]
  );

  return (
    <VdpDateRangeContext.Provider value={value}>
      {children}
    </VdpDateRangeContext.Provider>
  );
}

export function useVdpDateRange() {
  const ctx = useContext(VdpDateRangeContext);
  if (!ctx) {
    const period = resolveVdpReportPeriod(VDP_DEFAULT_DATE_RANGE);
    return {
      dateRange: VDP_DEFAULT_DATE_RANGE,
      setDateRange: () => {},
      period,
      from: period.from,
      to: period.to,
      priorFrom: period.priorFrom,
      priorTo: period.priorTo,
      curLabel: period.curLabel,
      priLabel: period.priLabel,
    };
  }
  return ctx;
}
