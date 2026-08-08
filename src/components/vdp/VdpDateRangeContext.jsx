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
const COMPARE_ENABLED_KEY = 'vdp_compare_enabled';
const COMPARE_RANGE_KEY = 'vdp_compare_date_range';

function readJson(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function VdpDateRangeProvider({ children }) {
  const [dateRange, setDateRangeState] = useState(VDP_DEFAULT_DATE_RANGE);
  const [compareEnabled, setCompareEnabledState] = useState(true);
  const [compareDateRange, setCompareDateRangeState] = useState(null);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(VDP_DEFAULT_DATE_RANGE)
      );
      const storedEnabled = readJson(COMPARE_ENABLED_KEY, true);
      setCompareEnabledState(storedEnabled !== false);
      const storedCompare = readJson(COMPARE_RANGE_KEY, null);
      if (storedCompare) setCompareDateRangeState(storedCompare);
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

  const setCompareEnabled = useCallback((next) => {
    const enabled = Boolean(next);
    setCompareEnabledState(enabled);
    try {
      window.sessionStorage.setItem(
        COMPARE_ENABLED_KEY,
        JSON.stringify(enabled)
      );
    } catch {
      /* ignore */
    }
  }, []);

  const toggleCompareEnabled = useCallback(() => {
    setCompareEnabledState((prev) => {
      const enabled = !prev;
      try {
        window.sessionStorage.setItem(
          COMPARE_ENABLED_KEY,
          JSON.stringify(enabled)
        );
      } catch {
        /* ignore */
      }
      return enabled;
    });
  }, []);

  const setCompareDateRange = useCallback((next) => {
    setCompareDateRangeState(next);
    try {
      window.sessionStorage.setItem(COMPARE_RANGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  const period = useMemo(
    () =>
      resolveVdpReportPeriod(dateRange, {
        compareEnabled,
        compareDateRange,
      }),
    [dateRange, compareEnabled, compareDateRange]
  );

  const value = useMemo(
    () => ({
      dateRange,
      setDateRange,
      compareEnabled,
      setCompareEnabled,
      toggleCompareEnabled,
      compareDateRange,
      setCompareDateRange,
      period,
      from: period.from,
      to: period.to,
      priorFrom: period.priorFrom,
      priorTo: period.priorTo,
      curLabel: period.curLabel,
      priLabel: period.priLabel,
    }),
    [
      dateRange,
      setDateRange,
      compareEnabled,
      setCompareEnabled,
      toggleCompareEnabled,
      compareDateRange,
      setCompareDateRange,
      period,
    ]
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
    const period = resolveVdpReportPeriod(VDP_DEFAULT_DATE_RANGE, {
      compareEnabled: true,
    });
    return {
      dateRange: VDP_DEFAULT_DATE_RANGE,
      setDateRange: () => {},
      compareEnabled: true,
      setCompareEnabled: () => {},
      toggleCompareEnabled: () => {},
      compareDateRange: null,
      setCompareDateRange: () => {},
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
