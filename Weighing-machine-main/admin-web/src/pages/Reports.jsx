import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import Badge from '../components/Badge.jsx';
import { customDateToRange, fmtDate, fmtKg, listRecentMonths, periodToRange } from '../lib/format.js';
import {
  parseReportsSearch,
  reportsTableView,
  serializeReportsSearch,
} from '../lib/reportsListState.js';

function SummaryCard({ label, value }) {
  return (
    <div className="card p-3">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="text-lg font-semibold mt-1">{value}</p>
    </div>
  );
}

export default function Reports() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = parseReportsSearch(searchParams);
  const { period, customDate, ticketStatus, operator, material, search, page } = filters;
  const [searchInput, setSearchInput] = useState(search);
  const loadSeq = useRef(0);
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  const [pagination, setPagination] = useState({ totalPages: 1, total: 0 });
  const [filterOptions, setFilterOptions] = useState({ operators: [], materials: [] });
  const [loading, setLoading] = useState(true);
  const tableView = reportsTableView({ loading, rows });
  const [error, setError] = useState('');
  const [pdfBusy, setPdfBusy] = useState('');
  const recentMonths = listRecentMonths(4);
  const listQuery = searchParams.toString();
  const editSuffix = listQuery ? `?${listQuery}` : '';

  function activeRange() {
    if (period === 'custom') return customDateToRange(customDate);
    return periodToRange(period);
  }

  function updateFilters(patch) {
    const next = {
      ...filters,
      ...patch,
    };
    if (patch.period && patch.period !== 'custom') next.customDate = '';
    setSearchParams(serializeReportsSearch(next), { replace: true });
  }

  function resetFilters() {
    setSearchInput('');
    setSearchParams({}, { replace: true });
  }

  useEffect(() => {
    setSearchInput(search);
  }, [search]);

  useEffect(() => {
    const next = searchInput.trim();
    const timer = setTimeout(() => {
      setSearchParams((current) => {
        const parsed = parseReportsSearch(current);
        if (next === parsed.search) return current;
        return serializeReportsSearch({ ...parsed, search: next, page: 0 });
      }, { replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, setSearchParams]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError('');
    const range = period === 'custom' ? customDateToRange(customDate) : periodToRange(period);
    if (period === 'custom' && !range) {
      if (seq !== loadSeq.current) return;
      setRows([]);
      setSummary({});
      setPagination({ totalPages: 1, total: 0 });
      setLoading(false);
      return;
    }
    try {
      const params = {
        ...range,
        page: String(page),
        limit: '50',
      };
      if (ticketStatus !== 'all') params.ticket_status = ticketStatus;
      if (operator !== 'all') params.operator_name = operator;
      if (material !== 'all') params.material = material;
      if (search.trim()) params.search = search.trim();

      const data = await api.getReports(params);
      if (seq !== loadSeq.current) return;
      setRows(data.rows || []);
      setSummary(data.summary || {});
      setPagination(data.pagination || { totalPages: 1, total: 0 });
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(err.message);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [period, customDate, ticketStatus, operator, material, search, page]);

  useEffect(() => {
    api.getReportFilters().then(setFilterOptions).catch(console.error);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function exportFile(type) {
    try {
      const range = activeRange();
      if (period === 'custom' && !range) {
        alert('Choose a date to download that day’s report.');
        return;
      }
      const params = { ...range };
      if (ticketStatus !== 'all') params.ticket_status = ticketStatus;
      if (operator !== 'all') params.operator_name = operator;
      if (material !== 'all') params.material = material;
      const typed = searchInput.trim();
      if (typed) params.search = typed;

      const path = type === 'csv' ? '/reports/export/csv' : '/reports/export/excel';
      const blob = await api.downloadExport(path, params);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = period === 'custom' && customDate ? `-${customDate}` : '';
      a.download = type === 'csv' ? `weighbridge-report${stamp}.csv` : `weighbridge-report${stamp}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h2 className="text-xl font-semibold">Reports</h2>
        <div className="flex gap-2">
          <button type="button" className="btn-ghost text-xs" onClick={() => exportFile('csv')}>
            Export CSV
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => exportFile('excel')}>
            Export Excel
          </button>
          <button type="button" className="btn-primary text-xs" onClick={load}>
            Refresh
          </button>
        </div>
      </div>

      <div className="card p-4 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <SummaryCard label="Total tickets" value={tableView.summaryPending ? '—' : (summary.total ?? 0)} />
        <SummaryCard label="Closed" value={tableView.summaryPending ? '—' : (summary.closed_count ?? 0)} />
        <SummaryCard label="Open" value={tableView.summaryPending ? '—' : (summary.open_count ?? 0)} />
        <SummaryCard label="Total gross" value={tableView.summaryPending ? '—' : fmtKg(summary.total_gross)} />
        <SummaryCard label="Total tare" value={tableView.summaryPending ? '—' : fmtKg(summary.total_tare)} />
        <SummaryCard label="Vehicles" value={tableView.summaryPending ? '—' : (summary.total_vehicles ?? 0)} />
        <SummaryCard label="Reports PDF" value={tableView.summaryPending ? '—' : (summary.reports_generated ?? 0)} />
      </div>

      <div className="card p-4 grid grid-cols-1 md:grid-cols-6 gap-3">
        <select
          className="field-input"
          value={period}
          onChange={(e) => updateFilters({ period: e.target.value, page: 0 })}
        >
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="last_7_days">Last 7 days</option>
          <option value="this_month">This month</option>
          <option value="last_month">Previous month</option>
          <option value="custom">Custom date</option>
          <option value="last_4_months">Last 4 months</option>
          <optgroup label="Month wise">
            {recentMonths.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </optgroup>
        </select>
        <select
          className="field-input"
          value={ticketStatus}
          onChange={(e) => updateFilters({ ticketStatus: e.target.value, page: 0 })}
        >
          <option value="all">All statuses</option>
          <option value="CLOSED">Closed</option>
          <option value="OPEN">Open</option>
          <option value="CANCELLED">Cancelled</option>
          <option value="DELETED">Deleted</option>
        </select>
        <select
          className="field-input"
          value={operator}
          onChange={(e) => updateFilters({ operator: e.target.value, page: 0 })}
        >
          <option value="all">All operators</option>
          {filterOptions.operators.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <select
          className="field-input"
          value={material}
          onChange={(e) => updateFilters({ material: e.target.value, page: 0 })}
        >
          <option value="all">All materials</option>
          {filterOptions.materials.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          className="field-input"
          placeholder="Search slip, truck…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const next = e.currentTarget.value.trim();
            updateFilters({ search: next, page: 0 });
            if (next === search) load();
          }}
        />
        {period === 'custom' && (
          <input
            type="date"
            aria-label="Particular date"
            title="Particular date"
            className="field-input [color-scheme:dark]"
            value={customDate}
            onChange={(e) => updateFilters({ customDate: e.target.value, page: 0 })}
          />
        )}
        <button type="button" className="btn-ghost text-xs self-center whitespace-nowrap" onClick={resetFilters}>
          Reset Filters
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {loading && (
        <p className="text-sm text-slate-400" role="status">
          Loading reports…
        </p>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-800">
              <th className="p-3">Slip</th>
              <th className="p-3">Vehicle</th>
              <th className="p-3">Material</th>
              <th className="p-3">Operator</th>
              <th className="p-3">Gross</th>
              <th className="p-3">Tare</th>
              <th className="p-3">Net</th>
              <th className="p-3">In / Out</th>
              <th className="p-3">Status</th>
              <th className="p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tableView.showRows && rows.map((row) => (
              <tr key={row.id} className="border-b border-slate-800/60 hover:bg-slate-800/30">
                <td className="p-3 font-mono text-xs">{row.slip_number}</td>
                <td className="p-3">{row.truck_number}</td>
                <td className="p-3">{row.material || '—'}</td>
                <td className="p-3">{row.operator_name || '—'}</td>
                <td className="p-3">{fmtKg(row.gross_weight)}</td>
                <td className="p-3">{fmtKg(row.tare_weight)}</td>
                <td className="p-3">{fmtKg(row.net_weight)}</td>
                <td className="p-3 text-xs">
                  {row.ticket_status === 'OPEN'
                    ? fmtDate(row.timestamp_in)
                    : fmtDate(row.timestamp_out || row.timestamp_in)}
                </td>
                <td className="p-3">
                  <Badge
                    tone={
                      row.ticket_status === 'CLOSED'
                        ? 'success'
                        : row.ticket_status === 'OPEN'
                          ? 'warning'
                          : 'default'
                    }
                  >
                    {row.ticket_status}
                  </Badge>
                </td>
                <td className="p-3 space-x-2">
                  <Link
                    to={`/reports/${encodeURIComponent(row.slip_number)}/edit${editSuffix}`}
                    className="text-brand-400 hover:underline text-xs"
                  >
                    Edit
                  </Link>
                  {row.ticket_status === 'CLOSED' && (
                    <button
                      type="button"
                      className="text-emerald-400 hover:underline text-xs disabled:opacity-50"
                      disabled={pdfBusy === row.slip_number}
                      onClick={async () => {
                        setPdfBusy(row.slip_number);
                        setError('');
                        try {
                          await api.downloadReportPdf(
                            row.slip_number,
                            row.truck_number,
                            row.timestamp_out || row.timestamp_in,
                          );
                        } catch (err) {
                          setError(err.message);
                        } finally {
                          setPdfBusy('');
                        }
                      }}
                    >
                      {pdfBusy === row.slip_number ? 'PDF…' : 'PDF'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {tableView.showSkeleton && (
              <tr>
                <td colSpan={10} className="p-6 text-center text-slate-500">
                  Loading reports…
                </td>
              </tr>
            )}
            {tableView.showEmpty && (
              <tr>
                <td colSpan={10} className="p-6 text-center text-slate-500">
                  {period === 'custom' && !customDate
                    ? 'Choose a date to view and download that day’s report.'
                    : 'No tickets found for this filter. Open or closed tickets sync from the weighbridge PC — check Sync Status if the list stays empty.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-400">
          Page {page + 1} of {tableView.summaryPending ? '—' : pagination.totalPages} ({tableView.summaryPending ? '—' : pagination.total} total)
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={page <= 0}
            onClick={() => updateFilters({ page: Math.max(0, page - 1) })}
          >
            Previous
          </button>
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={page + 1 >= pagination.totalPages}
            onClick={() => updateFilters({ page: page + 1 })}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
