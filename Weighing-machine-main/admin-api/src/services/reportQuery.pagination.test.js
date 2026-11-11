'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { queryPaginated, summarise } = require('./reportQuery');

function makeQueryFn(rows) {
  const calls = [];
  const queryFn = async (sql, params) => {
    calls.push({ sql, params });
    if (/COUNT\(\*\) AS c/.test(sql)) {
      return { rows: [{ c: String(rows.length) }] };
    }
    if (/COUNT\(\*\) AS total/.test(sql)) {
      return {
        rows: [
          {
            total: String(rows.length),
            open_count: '0',
            closed_count: String(rows.length),
            total_gross: '0',
            total_tare: '0',
            total_net: '0',
            total_vehicles: '1',
            reports_generated: '0',
          },
        ],
      };
    }
    return { rows };
  };
  queryFn.calls = calls;
  return queryFn;
}

test('queryPaginated runs count and rows in parallel by default', async () => {
  const rows = [
    { slip_number: 'A1', ticket_status: 'CLOSED', site_id: 'WB-03' },
    { slip_number: 'A2', ticket_status: 'CLOSED', site_id: 'WB-03' },
  ];
  const queryFn = makeQueryFn(rows);
  const result = await queryPaginated(queryFn, 'WB-03', { limit: 50, page: 0 });
  assert.equal(result.pagination.total, 2);
  assert.equal(result.pagination.totalPages, 1);
  assert.equal(result.rows.length, 2);
  assert.equal(queryFn.calls.length, 2);
  assert.ok(queryFn.calls.some((c) => /COUNT\(\*\) AS c/.test(c.sql)));
  assert.ok(queryFn.calls.some((c) => /SELECT \* FROM/.test(c.sql)));
});

test('queryPaginated skipCount omits the dedicated count query', async () => {
  const rows = [{ slip_number: 'A1', ticket_status: 'CLOSED', site_id: 'WB-03' }];
  const queryFn = makeQueryFn(rows);
  const result = await queryPaginated(queryFn, 'WB-03', { limit: 50, page: 0 }, { skipCount: true });
  assert.equal(result.pagination.total, null);
  assert.equal(result.pagination.totalPages, null);
  assert.equal(result.rows.length, 1);
  assert.equal(queryFn.calls.length, 1);
  assert.ok(!queryFn.calls.some((c) => /COUNT\(\*\) AS c/.test(c.sql)));
});

test('summarise total can back pagination when skipCount is used', async () => {
  const rows = [
    { slip_number: 'A1', ticket_status: 'CLOSED', site_id: 'WB-03' },
    { slip_number: 'A2', ticket_status: 'CLOSED', site_id: 'WB-03' },
  ];
  const queryFn = makeQueryFn(rows);
  const [result, summary] = await Promise.all([
    queryPaginated(queryFn, 'WB-03', { limit: 50, page: 0 }, { skipCount: true }),
    summarise(queryFn, 'WB-03', {}),
  ]);
  const total = Number(summary.total) || 0;
  assert.equal(total, 2);
  assert.equal(result.rows.length, 2);
  assert.equal(Math.max(1, Math.ceil(total / result.pagination.pageSize)), 1);
});
