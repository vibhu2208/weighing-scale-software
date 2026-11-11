'use strict';

const REPORT_TZ = process.env.REPORT_TZ || 'Asia/Kolkata';

function calendarDateInTz(reportDate, timeZone = REPORT_TZ) {
  const date = new Date(reportDate);
  if (Number.isNaN(date.getTime())) return 'unknown-date';
  // en-CA → YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Same naming as admin-web reportPdfFilename: last4-YYYY-MM-DD.pdf (no slip).
 * Example: truck …4672 on 10 Nov 2026 → 4672-2026-11-10.pdf
 * Dates use Asia/Kolkata so filenames match weighbridge local day.
 */
function reportZipFilename(truckNumber, reportDate) {
  const compactTruck = String(truckNumber || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
  const last4 = compactTruck.match(/(\d{4})$/)?.[1] || 'unknown-vehicle';
  return `${last4}-${calendarDateInTz(reportDate)}.pdf`;
}

/**
 * Keep duplicate last4+date entries as file-2.pdf, file-3.pdf
 * (matches the old client-side ZIP behavior).
 */
function uniqueZipEntryName(baseFilename, filenameCounts) {
  const count = (filenameCounts.get(baseFilename) || 0) + 1;
  filenameCounts.set(baseFilename, count);
  if (count === 1) return baseFilename;
  return `${baseFilename.slice(0, -4)}-${count}.pdf`;
}

module.exports = { reportZipFilename, uniqueZipEntryName, calendarDateInTz };
