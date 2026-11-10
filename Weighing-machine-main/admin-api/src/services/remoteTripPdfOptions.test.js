'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Mirrors Phase 1+2 rules in routes/remoteTrips.js GET /:id/pdf:
 * - normal PDF may update canonical report_s3_key
 * - gross-print caches under report_gross.pdf and never touches report_s3_key
 */
function pdfGenerateOptions(printGross) {
  return {
    upload: true,
    grossPrint: printGross,
    updateReportKeys: !printGross,
  };
}

test('normal PDF download uploads canonical report and updates report_s3_key', () => {
  assert.deepEqual(pdfGenerateOptions(false), {
    upload: true,
    grossPrint: false,
    updateReportKeys: true,
  });
});

test('gross-print PDF uploads report_gross.pdf without updating report_s3_key', () => {
  assert.deepEqual(pdfGenerateOptions(true), {
    upload: true,
    grossPrint: true,
    updateReportKeys: false,
  });
});
