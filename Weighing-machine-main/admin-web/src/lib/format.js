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

export function periodToRange(period) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = (d) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

  let from;
  let to = endOfDay(now);

  switch (period) {
    case 'today':
      from = startOfDay(now);
      break;
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
