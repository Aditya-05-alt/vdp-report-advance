import { resolveRangePickerValue } from '@/components/dashboard/CalendarRangePicker';
import {
  formatRangeLabel,
  previousMonthAlignedRange,
} from '@/lib/overview/comparePeriod';

/** Default on login / fresh session. */
export const VDP_DEFAULT_DATE_RANGE = 'current_month';

/**
 * Resolve CalendarRangePicker value → current + prior-month-aligned compare window.
 * Used by All Dealers + Overview / Traffic / Inventory.
 */
export function resolveVdpReportPeriod(pickerValue) {
  const resolved =
    resolveRangePickerValue(pickerValue) ||
    resolveRangePickerValue(VDP_DEFAULT_DATE_RANGE);

  const from = resolved?.start || null;
  const to = resolved?.end || null;
  const { compareFrom, compareTo } = previousMonthAlignedRange(from, to);

  return {
    from,
    to,
    priorFrom: compareFrom,
    priorTo: compareTo,
    curLabel: formatRangeLabel(from, to) || 'Current',
    priLabel: formatRangeLabel(compareFrom, compareTo) || 'Prior',
    preset: resolved?.preset || 'custom',
  };
}
