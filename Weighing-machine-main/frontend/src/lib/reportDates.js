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

export function getPeriodRange(period, customFrom, customTo) {
  const now = new Date();

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
