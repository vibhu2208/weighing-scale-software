function pad(n) {
  return String(n).padStart(2, '0');
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfDay(d) {
  const result = new Date(d);
  result.setHours(0, 0, 0, 0);
  return result;
}

function endOfDay(d) {
  const result = new Date(d);
  result.setHours(23, 59, 59, 999);
  return result;
}

function toIsoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfWeekMonday(d) {
  const result = startOfDay(d);
  const day = result.getDay();
  const diff = day === 0 ? 6 : day - 1;
  result.setDate(result.getDate() - diff);
  return result;
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function monthKey(year, monthIndex) {
  return `month:${year}-${pad(monthIndex + 1)}`;
}

function parseMonthPeriod(period) {
  if (!period || !String(period).startsWith('month:')) return null;
  const match = /^month:(\d{4})-(\d{2})$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11) return null;
  return { year, monthIndex };
}

/** Last N calendar months (newest first), for month-wise report filters. */
export function listRecentMonths(count = 4) {
  const now = new Date();
  const months = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const monthIndex = d.getMonth();
    months.push({
      id: monthKey(year, monthIndex),
      label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
      year,
      monthIndex,
    });
  }
  return months;
}

function rangeForMonth(year, monthIndex, now = new Date()) {
  const start = new Date(year, monthIndex, 1);
  const end =
    year === now.getFullYear() && monthIndex === now.getMonth()
      ? now
      : endOfMonth(start);
  const label = start.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  return { from: toIsoDate(start), to: toIsoDate(end), label };
}

export function getPeriodRange(period, customFrom, customTo) {
  const now = new Date();
  const monthPeriod = parseMonthPeriod(period);
  if (monthPeriod) {
    return rangeForMonth(monthPeriod.year, monthPeriod.monthIndex, now);
  }

  switch (period) {
    case 'today':
      return { from: toIsoDate(now), to: toIsoDate(now), label: 'Today' };
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: toIsoDate(y), to: toIsoDate(y), label: 'Yesterday' };
    }
    case 'this_week': {
      const start = startOfWeekMonday(now);
      return { from: toIsoDate(start), to: toIsoDate(now), label: 'This Week' };
    }
    case 'last_week': {
      const start = startOfWeekMonday(now);
      start.setDate(start.getDate() - 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return { from: toIsoDate(start), to: toIsoDate(end), label: 'Last Week' };
    }
    case 'this_month': {
      const start = startOfMonth(now);
      return { from: toIsoDate(start), to: toIsoDate(now), label: 'This Month' };
    }
    case 'last_month': {
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const start = startOfMonth(prev);
      const end = endOfMonth(prev);
      return { from: toIsoDate(start), to: toIsoDate(end), label: 'Last Month' };
    }
    case 'last_4_months': {
      const start = startOfMonth(new Date(now.getFullYear(), now.getMonth() - 3, 1));
      return { from: toIsoDate(start), to: toIsoDate(now), label: 'Last 4 Months' };
    }
    case 'last_3_days': {
      const start = new Date(now);
      start.setDate(start.getDate() - 2);
      return { from: toIsoDate(start), to: toIsoDate(now), label: 'Last 3 Days' };
    }
    case 'last_7_days': {
      const start = new Date(now);
      start.setDate(start.getDate() - 6);
      return { from: toIsoDate(start), to: toIsoDate(now), label: 'Last 7 Days' };
    }
    case 'custom':
    default:
      return {
        from: customFrom || toIsoDate(now),
        to: customTo || toIsoDate(now),
        label: customFrom && customTo ? `${customFrom} to ${customTo}` : 'Custom Range',
      };
  }
}

export function toFilterTimestamps(from, to) {
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to || from}T23:59:59.999`);
  return {
    from: start.toISOString(),
    to: end.toISOString(),
  };
}
