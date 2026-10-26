import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REPORTS_FILTER_DEFAULTS,
  isDefaultReportsState,
  parseReportsSearch,
  reportsListPath,
  reportsSearchString,
  reportsTableView,
} from './reportsListState.js';

test('round-trips applied Reports filters through the URL', () => {
  const applied = {
    period: 'today',
    customDate: '',
    ticketStatus: 'CLOSED',
    operator: 'Ravi',
    material: 'RDF',
    search: '8815',
    page: 2,
  };
  const search = reportsSearchString(applied);
  assert.equal(search, '?period=today&status=CLOSED&operator=Ravi&material=RDF&q=8815&page=2');
  assert.deepEqual(parseReportsSearch(search), applied);
  assert.equal(reportsListPath(applied), `/reports${search}`);
});

test('defaults serialize to an empty query so sidebar /reports resets the list', () => {
  assert.equal(reportsSearchString(REPORTS_FILTER_DEFAULTS), '');
  assert.equal(reportsListPath(REPORTS_FILTER_DEFAULTS), '/reports');
  assert.equal(isDefaultReportsState(parseReportsSearch('')), true);
  assert.deepEqual(parseReportsSearch(''), REPORTS_FILTER_DEFAULTS);
});

test('preserves custom date and ignores invalid page values', () => {
  const parsed = parseReportsSearch('period=custom&date=2026-10-21&page=-3');
  assert.equal(parsed.period, 'custom');
  assert.equal(parsed.customDate, '2026-10-21');
  assert.equal(parsed.page, 0);
  assert.equal(
    reportsListPath(parsed),
    '/reports?period=custom&date=2026-10-21',
  );
});

test('does not treat a loading reload as an empty reports list', () => {
  assert.deepEqual(reportsTableView({ loading: true, rows: [] }), {
    showSkeleton: true,
    showEmpty: false,
    showRows: false,
    summaryPending: true,
  });
  assert.deepEqual(reportsTableView({ loading: true, rows: [{ id: 1 }] }), {
    showSkeleton: false,
    showEmpty: false,
    showRows: true,
    summaryPending: false,
  });
  assert.deepEqual(reportsTableView({ loading: false, rows: [] }), {
    showSkeleton: false,
    showEmpty: true,
    showRows: false,
    summaryPending: false,
  });
});

test('edit URLs keep the current Reports search string', () => {
  const applied = {
    period: 'today',
    customDate: '',
    ticketStatus: 'CLOSED',
    operator: 'all',
    material: 'all',
    search: '8815',
    page: 0,
  };
  assert.equal(
    reportsListPath(applied),
    '/reports?period=today&status=CLOSED&q=8815',
  );
  assert.equal(isDefaultReportsState(parseReportsSearch('period=today')), false);
});
