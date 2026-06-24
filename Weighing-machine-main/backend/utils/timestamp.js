'use strict';

/**
 * Single source of truth for date/time across the application.
 * Never call `new Date()` directly anywhere else.
 */

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** Current ISO 8601 UTC timestamp. */
function now() {
  return new Date().toISOString();
}

/** Convert ISO string to DD/MM/YYYY (local time). */
function toDisplayDate(iso) {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** Convert ISO string to HH:mm:ss (local 24-hour time). */
function toDisplayTime(iso) {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Convert ISO string to DD/MM/YYYY HH:mm:ss (local time). */
function toDisplay(iso) {
  const date = toDisplayDate(iso);
  if (!date) return '';
  return `${date} ${toDisplayTime(iso)}`;
}

/** Convert ISO string to DD/MM/YYYY HH:mm:ss AM/PM (local time). */
function toDisplay12h(iso) {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return (
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${pad(hours)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ampm}`
  );
}

/** ISO timestamp at 00:00:00.000 local time of today. */
function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** ISO timestamp at 23:59:59.999 local time of today. */
function todayEnd() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

/** ISO timestamp N days before now (local calendar days). */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/** Filesystem-safe compact timestamp e.g. 20250518_131245. */
function fileSafe(date) {
  const d = date instanceof Date ? date : new Date();
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** YYYY-MM-DD in local calendar for an ISO timestamp. */
function toLocalDateIso(iso) {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local start/end of a calendar day from YYYY-MM-DD. */
function dayBounds(isoDate) {
  const [year, month, day] = String(isoDate).slice(0, 10).split('-').map(Number);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day, 23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Inclusive local-day range for report filters (from/to are YYYY-MM-DD). */
function dayBoundsRange(fromDate, toDate) {
  const from = dayBounds(fromDate).from;
  const to = dayBounds(toDate || fromDate).to;
  return { from, to };
}

/** Returns { year, month, day } as zero-padded strings for path building. */
function parts(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  return {
    year: String(d.getFullYear()),
    month: pad(d.getMonth() + 1),
    day: pad(d.getDate()),
  };
}

module.exports = {
  now,
  toDisplayDate,
  toDisplayTime,
  toDisplay,
  toDisplay12h,
  toLocalDateIso,
  dayBounds,
  dayBoundsRange,
  todayStart,
  todayEnd,
  daysAgo,
  fileSafe,
  parts,
};
