/**
 * Reports list filters live in the URL so Edit → Back restores them,
 * while a sidebar click on /reports (no query) returns to defaults.
 */

export const REPORTS_FILTER_DEFAULTS = {
  period: 'last_7_days',
  customDate: '',
  ticketStatus: 'all',
  operator: 'all',
  material: 'all',
  search: '',
  page: 0,
};

function readSearchParams(search) {
  if (search instanceof URLSearchParams) return search;
  const text = String(search || '');
  return new URLSearchParams(text.startsWith('?') ? text.slice(1) : text);
}

export function parseReportsSearch(search) {
  const params = readSearchParams(search);
  const pageRaw = Number.parseInt(params.get('page') || '0', 10);
  return {
    period: params.get('period') || REPORTS_FILTER_DEFAULTS.period,
    customDate: params.get('date') || REPORTS_FILTER_DEFAULTS.customDate,
    ticketStatus: params.get('status') || REPORTS_FILTER_DEFAULTS.ticketStatus,
    operator: params.get('operator') || REPORTS_FILTER_DEFAULTS.operator,
    material: params.get('material') || REPORTS_FILTER_DEFAULTS.material,
    search: params.get('q') || REPORTS_FILTER_DEFAULTS.search,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 0,
  };
}

export function serializeReportsSearch(state) {
  const params = new URLSearchParams();
  const period = state.period || REPORTS_FILTER_DEFAULTS.period;
  if (period !== REPORTS_FILTER_DEFAULTS.period) params.set('period', period);
  if (state.customDate) params.set('date', state.customDate);
  if (state.ticketStatus && state.ticketStatus !== REPORTS_FILTER_DEFAULTS.ticketStatus) {
    params.set('status', state.ticketStatus);
  }
  if (state.operator && state.operator !== REPORTS_FILTER_DEFAULTS.operator) {
    params.set('operator', state.operator);
  }
  if (state.material && state.material !== REPORTS_FILTER_DEFAULTS.material) {
    params.set('material', state.material);
  }
  const query = String(state.search || '').trim();
  if (query) params.set('q', query);
  if (Number(state.page) > 0) params.set('page', String(state.page));
  return params;
}

export function reportsSearchString(state) {
  const params = serializeReportsSearch(state);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function reportsListPath(searchOrState) {
  if (searchOrState && typeof searchOrState === 'object' && !(searchOrState instanceof URLSearchParams) && !('get' in searchOrState)) {
    return `/reports${reportsSearchString(searchOrState)}`;
  }
  const params = readSearchParams(searchOrState);
  const text = params.toString();
  return text ? `/reports?${text}` : '/reports';
}

export function isDefaultReportsState(state) {
  return reportsSearchString(state) === '';
}

export function reportsTableView({ loading, rows }) {
  const hasRows = Array.isArray(rows) && rows.length > 0;
  return {
    showSkeleton: Boolean(loading) && !hasRows,
    showEmpty: !loading && !hasRows,
    showRows: hasRows,
    summaryPending: Boolean(loading) && !hasRows,
  };
}
