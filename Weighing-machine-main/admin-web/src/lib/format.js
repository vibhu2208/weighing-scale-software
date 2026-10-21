export function toDatetimeLocalValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtKg(kg) {
  if (kg == null || !Number.isFinite(Number(kg))) return '—';
  return `${Number(kg).toLocaleString('en-IN')} kg`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN');
}

export function reportPdfFilename(truckNumber, reportDate) {
  const compactTruck = String(truckNumber || '').toUpperCase().replace(/[\s-]/g, '');
  const last4 = compactTruck.match(/(\d{4})$/)?.[1] || 'unknown-vehicle';
  const date = new Date(reportDate);
  const datePart = Number.isNaN(date.getTime())
    ? 'unknown-date'
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate(),
      ).padStart(2, '0')}`;
  return `${last4}-${datePart}.pdf`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Last N calendar months (newest first), for month-wise report filters. */
export function listRecentMonths(count = 4) {
  const now = new Date();
  const months = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      id: `month:${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
      label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
    });
  }
  return months;
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

export function periodToRange(period) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = (d) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

  const monthPeriod = parseMonthPeriod(period);
  if (monthPeriod) {
    const from = new Date(monthPeriod.year, monthPeriod.monthIndex, 1);
    const isCurrent =
      monthPeriod.year === now.getFullYear() && monthPeriod.monthIndex === now.getMonth();
    const to = isCurrent
      ? endOfDay(now)
      : new Date(monthPeriod.year, monthPeriod.monthIndex + 1, 0, 23, 59, 59, 999);
    return { from: from.toISOString(), to: to.toISOString() };
  }

  let from;
  let to = endOfDay(now);

  switch (period) {
    case 'today':
      from = startOfDay(now);
      break;
    case 'tomorrow': {
      const t = new Date(now);
      t.setDate(t.getDate() + 1);
      from = startOfDay(t);
      to = endOfDay(t);
      break;
    }
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      from = startOfDay(y);
      to = endOfDay(y);
      break;
    }
    case 'last_7_days':
      from = startOfDay(new Date(now.getTime() - 6 * 86400000));
      break;
    case 'this_month':
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'last_month': {
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      from = new Date(prev.getFullYear(), prev.getMonth(), 1);
      to = new Date(prev.getFullYear(), prev.getMonth() + 1, 0, 23, 59, 59, 999);
      break;
    }
    case 'last_4_months':
      from = new Date(now.getFullYear(), now.getMonth() - 3, 1);
      break;
    default:
      from = startOfDay(new Date(now.getTime() - 6 * 86400000));
  }

  return { from: from.toISOString(), to: to.toISOString() };
}

/** Inclusive local calendar day for a `YYYY-MM-DD` value. */
export function customDateToRange(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const from = new Date(`${dateStr}T00:00:00`);
  const to = new Date(`${dateStr}T23:59:59.999`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { from: from.toISOString(), to: to.toISOString() };
}

export function ymd(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Inclusive local calendar day, e.g. 2026-10-21. */
export function rangeForLocalDate(ymdStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymdStr || ''));
  if (!match) return periodToRange('today');
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const from = new Date(year, monthIndex, day);
  const to = new Date(year, monthIndex, day, 23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}
