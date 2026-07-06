import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import Badge from '../components/Badge.jsx';
import { fmtDate, fmtKg, periodToRange } from '../lib/format.js';

function SummaryCard({ label, value }) {
  return (
    <div className="card p-3">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="text-lg font-semibold mt-1">{value}</p>
    </div>
  );
}

export default function Reports() {
  const [period, setPeriod] = useState('last_7_days');
  const [ticketStatus, setTicketStatus] = useState('CLOSED');
  const [operator, setOperator] = useState('all');
  const [material, setMaterial] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  const [pagination, setPagination] = useState({ totalPages: 1, total: 0 });
  const [filterOptions, setFilterOptions] = useState({ operators: [], materials: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const range = periodToRange(period);
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
      setRows(data.rows || []);
      setSummary(data.summary || {});
      setPagination(data.pagination || { totalPages: 1, total: 0 });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [period, ticketStatus, operator, material, search, page]);

  useEffect(() => {
    api.getReportFilters().then(setFilterOptions).catch(console.error);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function exportFile(type) {
    try {
      const range = periodToRange(period);
      const params = { ...range };
      if (ticketStatus !== 'all') params.ticket_status = ticketStatus;
      if (operator !== 'all') params.operator_name = operator;
      if (material !== 'all') params.material = material;
      if (search.trim()) params.search = search.trim();

      const path = type === 'csv' ? '/reports/export/csv' : '/reports/export/excel';
      const blob = await api.downloadExport(path, params);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = type === 'csv' ? 'weighbridge-report.csv' : 'weighbridge-report.xlsx';
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
        <SummaryCard label="Total tickets" value={summary.total ?? 0} />
        <SummaryCard label="Closed" value={summary.closed_count ?? 0} />
        <SummaryCard label="Open" value={summary.open_count ?? 0} />
        <SummaryCard label="Total gross" value={fmtKg(summary.total_gross)} />
        <SummaryCard label="Total tare" value={fmtKg(summary.total_tare)} />
        <SummaryCard label="Vehicles" value={summary.total_vehicles ?? 0} />
        <SummaryCard label="Reports PDF" value={summary.reports_generated ?? 0} />
      </div>

      <div className="card p-4 grid grid-cols-1 md:grid-cols-5 gap-3">
        <select
          className="field-input"
          value={period}
          onChange={(e) => {
            setPage(0);
            setPeriod(e.target.value);
          }}
        >
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="last_7_days">Last 7 days</option>
          <option value="this_month">This month</option>
        </select>
        <select
          className="field-input"
          value={ticketStatus}
          onChange={(e) => {
            setPage(0);
            setTicketStatus(e.target.value);
          }}
        >
          <option value="all">All statuses</option>
          <option value="CLOSED">Closed</option>
          <option value="OPEN">Open</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <select
          className="field-input"
          value={operator}
          onChange={(e) => {
            setPage(0);
            setOperator(e.target.value);
          }}
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
          onChange={(e) => {
            setPage(0);
            setMaterial(e.target.value);
          }}
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
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
        />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {loading && <p className="text-sm text-slate-400">Loading…</p>}

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
              <th className="p-3">Closed</th>
              <th className="p-3">Status</th>
              <th className="p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-slate-800/60 hover:bg-slate-800/30">
                <td className="p-3 font-mono text-xs">{row.slip_number}</td>
                <td className="p-3">{row.truck_number}</td>
                <td className="p-3">{row.material || '—'}</td>
                <td className="p-3">{row.operator_name || '—'}</td>
                <td className="p-3">{fmtKg(row.gross_weight)}</td>
                <td className="p-3">{fmtKg(row.tare_weight)}</td>
                <td className="p-3">{fmtKg(row.net_weight)}</td>
                <td className="p-3 text-xs">{fmtDate(row.timestamp_out)}</td>
                <td className="p-3">
                  <Badge tone={row.ticket_status === 'CLOSED' ? 'success' : 'default'}>
                    {row.ticket_status}
                  </Badge>
                </td>
                <td className="p-3 space-x-2">
                  <Link
                    to={`/reports/${encodeURIComponent(row.slip_number)}/edit`}
                    className="text-brand-400 hover:underline text-xs"
                  >
                    Edit
                  </Link>
                  {row.report_url && (
                    <a
                      href={row.report_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-400 hover:underline text-xs"
                    >
                      PDF
                    </a>
                  )}
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={10} className="p-6 text-center text-slate-500">
                  No reports found. Close a ticket on the weighbridge PC to sync data.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-400">
          Page {page + 1} of {pagination.totalPages} ({pagination.total} total)
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={page <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous
          </button>
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={page + 1 >= pagination.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
