import { resolveRangePickerValue } from '@/components/dashboard/CalendarRangePicker';
import {
  formatRangeLabel,
  previousMonthAlignedRange,
} from '@/lib/overview/comparePeriod';

/** Default on login / fresh session. */
export const VDP_DEFAULT_DATE_RANGE = 'current_month';

/**
 * Resolve primary report period (+ optional compare window).
 * When compareEnabled and no custom compare range → prior-month-aligned.
 */
export function resolveVdpReportPeriod(
  pickerValue,
  { compareEnabled = true, compareDateRange = null } = {}
) {
  const resolved =
    resolveRangePickerValue(pickerValue) ||
    resolveRangePickerValue(VDP_DEFAULT_DATE_RANGE);

  const from = resolved?.start || null;
  const to = resolved?.end || null;

  let priorFrom = null;
  let priorTo = null;

  if (compareEnabled) {
    const custom = compareDateRange
      ? resolveRangePickerValue(compareDateRange)
      : null;
    if (custom?.start && custom?.end) {
      priorFrom = custom.start;
      priorTo = custom.end;
    } else {
      const aligned = previousMonthAlignedRange(from, to);
      priorFrom = aligned.compareFrom;
      priorTo = aligned.compareTo;
    }
  }

  return {
    from,
    to,
    priorFrom,
    priorTo,
    curLabel: formatRangeLabel(from, to) || 'Current',
    priLabel: formatRangeLabel(priorFrom, priorTo) || 'Prior',
    preset: resolved?.preset || 'custom',
    compareEnabled: Boolean(compareEnabled),
  };
}
