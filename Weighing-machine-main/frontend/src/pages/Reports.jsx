import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { mcgAPI, reportAPI, transactionAPI } from '../api/ipc.js';
import Badge from '../components/shared/Badge.jsx';
import ExportCenter from '../components/reports/ExportCenter.jsx';
import ReportDownloadPanel from '../components/reports/ReportDownloadPanel.jsx';
import DateRangeCalendar from '../components/reports/DateRangeCalendar.jsx';
import PhotoGalleryModal from '../components/reports/PhotoGalleryModal.jsx';
import ReportPreviewModal from '../components/reports/ReportPreviewModal.jsx';
import EditSlipModal from '../components/reports/EditSlipModal.jsx';
import {
  isClosedTicket,
  ticketStatusLabel,
  ticketStatusVariant,
} from '../lib/ticketStatus.js';
import { mcgStatusLabel, mcgStatusTitle, mcgStatusVariant } from '../lib/mcgStatus.js';
import { getPeriodRange, todayISO, toFilterTimestamps } from '../lib/reportDates.js';
import { listTripCameraImages } from '../lib/tripPhotos.js';

const PAGE_SIZE = 50;

const EMPTY_SUMMARY = {
  total: 0,
  open: 0,
  closed: 0,
  cancelled: 0,
  gross: 0,
  tare: 0,
  net: 0,
  vehicles: 0,
  reportsGenerated: 0,
};

function netWeightAt(ticket) {
  if (ticket?.ticket_status === 'CLOSED') {
    return ticket.timestamp_out || ticket.updated_at || null;
  }
  return null;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', { dateStyle: 'short' });
  } catch {
    return iso;
  }
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return iso;
  }
}

function tons(kg) {
  return ((kg || 0) / 1000).toFixed(2);
}

function photoLabel(count) {
  if (!count) return '—';
  if (count >= 6) return '📷 6 Photos';
  return `📷 ${count}/6`;
}

function SummaryCard({ label, value, sub }) {
  return (
    <div className="card p-3">
      <p className="text-xs uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 font-medium text-white tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}

export default function Reports() {
  const [period, setPeriod] = useState('today');
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [status, setStatus] = useState('all');
  const [operator, setOperator] = useState('all');
  const [material, setMaterial] = useState('all');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [todayNetWeight, setTodayNetWeight] = useState(0);
  const [pagination, setPagination] = useState({ page: 0, pageSize: PAGE_SIZE, total: 0, totalPages: 1 });
  const [filterOptions, setFilterOptions] = useState({ operators: [], materials: [] });

  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [mcgResending, setMcgResending] = useState(() => new Set());

  const [exportOpen, setExportOpen] = useState(false);
  const [previewTicket, setPreviewTicket] = useState(null);
  const [editSlipTicket, setEditSlipTicket] = useState(null);
  const [galleryTicket, setGalleryTicket] = useState(null);
  const [calendarOpen, setCalendarOpen] = useState(false);

  useEffect(() => {
    const range = getPeriodRange(period, from, to);
    if (period !== 'custom') {
      setFrom(range.from);
      setTo(range.to);
    }
  }, [period]);

  const filters = useMemo(() => {
    const range = period === 'custom' ? { from, to } : getPeriodRange(period, from, to);
    const timestamps = toFilterTimestamps(range.from, range.to);
    const base = {
      ...timestamps,
      page,
      limit: PAGE_SIZE,
      search: search.trim() || undefined,
      operator_name: operator === 'all' ? undefined : operator,
      material: material === 'all' ? undefined : material,
    };
    if (status === 'all') return base;
    if (['OPEN', 'CLOSED', 'CANCELLED'].includes(status)) {
      return { ...base, ticket_status: status };
    }
    return { ...base, status };
  }, [from, to, period, status, operator, material, search, page]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, todayStats] = await Promise.all([
        reportAPI.getPaginatedReport(filters),
        transactionAPI.getTodayStats(),
      ]);
      setRows(data?.rows || []);
      setSummary({ ...EMPTY_SUMMARY, ...(data?.summary || {}) });
      setPagination(data?.pagination || { page: 0, pageSize: PAGE_SIZE, total: 0, totalPages: 1 });
      setTodayNetWeight(todayStats?.totalWeight || 0);
      setSelected(new Set());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    reportAPI.getFilterOptions().then(setFilterOptions).catch(() => {});
  }, []);

  const allPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someSelected = selected.size > 0;

  const toggleAllPage = () => {
    if (allPageSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        rows.forEach((r) => next.delete(r.id));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        rows.forEach((r) => next.add(r.id));
        return next;
      });
    }
  };

  const toggleOne = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  const runExport = async (payload) => {
    setExporting(true);
    try {
      if (payload.type === 'single') {
        await reportAPI.exportTripPDF(payload.transactionId);
      } else if (payload.type === 'csv') {
        await reportAPI.exportCSV({ ...payload.filters, ticket_status: 'CLOSED' });
      } else if (payload.type === 'excel') {
        await reportAPI.exportExcel({ ...payload.filters, ticket_status: 'CLOSED' });
      } else if (payload.type === 'excel_pdf') {
        await reportAPI.exportExcelPDF(
          { ...payload.filters, ticket_status: 'CLOSED' },
          { periodLabel: payload.periodLabel },
        );
      } else if (payload.type === 'pdf_pack') {
        await reportAPI.exportPDF(payload.filters, { periodLabel: payload.periodLabel });
      } else if (payload.type === 'closed_pdf_pack') {
        await reportAPI.exportPDF(
          { ...payload.filters, ticket_status: 'CLOSED' },
          { periodLabel: `${payload.periodLabel} (closed)` },
        );
      }
      setExportOpen(false);
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(false);
    }
  };

  const exportCurrentFilter = async (type) => {
    setExporting(true);
    try {
      const range = getPeriodRange(period, from, to);
      const exportFilters = {
        ...filters,
        ticket_status: 'CLOSED',
      };
      delete exportFilters.page;
      delete exportFilters.limit;
      if (type === 'excel') {
        await reportAPI.exportExcel(exportFilters);
      } else if (type === 'excel_pdf') {
        await reportAPI.exportExcelPDF(exportFilters, { periodLabel: range.label });
      } else if (type === 'csv') {
        await reportAPI.exportCSV(exportFilters);
      } else if (type === 'pdf_pack') {
        await reportAPI.exportPDF(exportFilters, { periodLabel: range.label });
      }
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(false);
    }
  };

  const activeRange = useMemo(
    () => (period === 'custom' ? getPeriodRange('custom', from, to) : getPeriodRange(period, from, to)),
    [period, from, to],
  );

  const bulkPdf = async () => {
    const closedIds = selectedIds.filter((id) => {
      const ticket = rows.find((row) => row.id === id);
      return isClosedTicket(ticket);
    });
    if (!closedIds.length) return;
    setExporting(true);
    try {
      await reportAPI.exportPDFByIds(closedIds, { periodLabel: 'Selected closed tickets' });
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(false);
    }
  };

  const bulkExcelPdf = async () => {
    const closedIds = selectedIds.filter((id) => {
      const ticket = rows.find((row) => row.id === id);
      return isClosedTicket(ticket);
    });
    if (!closedIds.length) return;
    setExporting(true);
    try {
      await reportAPI.exportExcelPDFByIds(closedIds, { periodLabel: 'Selected closed tickets' });
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(false);
    }
  };

  const bulkExcel = async () => {
    const closedIds = selectedIds.filter((id) => {
      const ticket = rows.find((row) => row.id === id);
      return isClosedTicket(ticket);
    });
    if (!closedIds.length) return;
    setExporting(true);
    try {
      await reportAPI.exportExcelByIds(closedIds);
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(false);
    }
  };

  const bulkPrint = async () => {
    if (!selectedIds.length) return;
    setExporting(true);
    try {
      await reportAPI.printReports(selectedIds, { periodLabel: 'Selected tickets' });
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(false);
    }
  };

  const printFiltered = async () => {
    setExporting(true);
    try {
      const range = getPeriodRange(period, from, to);
      await reportAPI.printFilteredReports(filters, { periodLabel: range.label });
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(false);
    }
  };

  const refreshTicketRow = useCallback((updated) => {
    const txn = updated?.transaction || updated;
    if (!txn?.id) return;
    setRows((prev) =>
      prev.map((row) => (row.id === txn.id ? { ...row, ...txn } : row)),
    );
    setGalleryTicket((current) => {
      if (!current || current.transactionId !== txn.id) return current;
      return {
        ...current,
        slip_number: txn.slip_number || current.slip_number,
        images: listTripCameraImages(txn),
      };
    });
    setPreviewTicket((current) => {
      if (!current || current.id !== txn.id) return current;
      return { ...current, ...txn };
    });
  }, []);

  const handleMcgResend = useCallback(async (ticket) => {
    if (!ticket?.id || mcgResending.has(ticket.id)) return;
    setMcgResending((prev) => new Set(prev).add(ticket.id));
    try {
      const result = await mcgAPI.resend(ticket.id);
      if (result?.transaction) {
        refreshTicketRow(result.transaction);
      }
      if (result?.ok && !result?.skipped) {
        return;
      }
      if (result?.skipped && result?.reason === 'not_configured') {
        alert('MCG portal is still not configured. Enable it in Settings first.');
        return;
      }
      alert(result?.error || 'MCG resend failed');
    } catch (e) {
      alert(e.message || 'MCG resend failed');
    } finally {
      setMcgResending((prev) => {
        const next = new Set(prev);
        next.delete(ticket.id);
        return next;
      });
    }
  }, [mcgResending, refreshTicketRow]);

  const applySearch = () => {
    setSearch(searchInput);
    setPage(0);
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Reports</h1>
          <p className="mt-1 text-sm text-slate-400">
            Browse, filter, and download weighbridge reports for any date range.
            Closed tickets are grouped by net-weight date (when the vehicle was weighed out), not arrival.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost text-xs" onClick={() => setExportOpen(true)} disabled={exporting}>
            Advanced Export
          </button>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
        <SummaryCard label="Total Tickets" value={summary.total} />
        <SummaryCard label="Open Tickets" value={summary.open} />
        <SummaryCard label="Closed Tickets" value={summary.closed} />
        <SummaryCard label="Total Gross" value={`${summary.gross?.toLocaleString('en-IN')} kg`} sub={`${tons(summary.gross)} t`} />
        <SummaryCard label="Total Tare" value={`${summary.tare?.toLocaleString('en-IN')} kg`} sub={`${tons(summary.tare)} t`} />
        <SummaryCard label="Total Net" value={`${summary.net?.toLocaleString('en-IN')} kg`} sub={`${tons(summary.net)} t`} />
        <SummaryCard
          label="Total Net Weight Today"
          value={`${todayNetWeight.toLocaleString('en-IN')} kg`}
          sub={`${tons(todayNetWeight)} t · closed tickets weighed out today`}
        />
        <SummaryCard label="Total Vehicles" value={summary.vehicles} />
        <SummaryCard label="Reports Generated" value={summary.reportsGenerated} />
      </section>

      <ReportDownloadPanel onExport={runExport} busy={exporting} />

      <section className="card p-5 flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Filter Tickets</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Showing <span className="text-brand-300">{activeRange.label}</span>
              {activeRange.from !== activeRange.to && (
                <span> · {activeRange.from} → {activeRange.to}</span>
              )}
              <span className="block mt-0.5">Closed tickets use net-weight date for this range.</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-ghost text-xs border border-emerald-800/40 text-emerald-300 hover:bg-emerald-950/30"
              disabled={exporting || !pagination.total}
              onClick={() => exportCurrentFilter('excel')}
            >
              Export Closed Excel
            </button>
            <button
              type="button"
              className="btn-ghost text-xs border border-amber-800/40 text-amber-300 hover:bg-amber-950/30"
              disabled={exporting || !pagination.total}
              onClick={() => exportCurrentFilter('excel_pdf')}
            >
              Export Closed PDF
            </button>
            <button
              type="button"
              className="btn-ghost text-xs"
              disabled={exporting || !pagination.total}
              onClick={() => exportCurrentFilter('pdf_pack')}
            >
              Export Filtered PDF
            </button>
            <button
              type="button"
              className="btn-ghost text-xs"
              disabled={exporting || !pagination.total}
              onClick={() => exportCurrentFilter('csv')}
            >
              Export Closed CSV
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-sm min-w-[140px]">
            <span className="text-slate-400 block mb-1">Period</span>
            <select className="field-input" value={period} onChange={(e) => { setPeriod(e.target.value); setPage(0); }}>
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="last_3_days">Last 3 Days</option>
              <option value="last_7_days">Last 7 Days</option>
              <option value="this_week">This Week</option>
              <option value="last_week">Last Week</option>
              <option value="this_month">This Month</option>
              <option value="last_month">Last Month</option>
              <option value="custom">Custom Range</option>
            </select>
          </label>
          <label className="text-sm min-w-[120px]">
            <span className="text-slate-400 block mb-1">Status</span>
            <select className="field-input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
              <option value="all">All</option>
              <option value="OPEN">Open</option>
              <option value="CLOSED">Closed</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </label>
          <label className="text-sm min-w-[140px]">
            <span className="text-slate-400 block mb-1">Operator</span>
            <select className="field-input" value={operator} onChange={(e) => { setOperator(e.target.value); setPage(0); }}>
              <option value="all">All Operators</option>
              {filterOptions.operators.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="text-sm min-w-[140px]">
            <span className="text-slate-400 block mb-1">Material</span>
            <select className="field-input" value={material} onChange={(e) => { setMaterial(e.target.value); setPage(0); }}>
              <option value="all">All Materials</option>
              {filterOptions.materials.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={`btn-ghost text-xs px-2.5 py-1.5 border ${
              calendarOpen ? 'border-brand-600/50 text-brand-300 bg-brand-950/30' : 'border-slate-700 text-slate-300'
            }`}
            onClick={() => setCalendarOpen((open) => !open)}
            aria-expanded={calendarOpen}
            aria-controls="filter-ticket-calendar"
          >
            {calendarOpen ? '▾' : '▸'} Calendar
          </button>
          <button type="button" className="btn-ghost" onClick={load} disabled={loading}>
            Refresh
          </button>
        </div>

        {calendarOpen && (
          <div id="filter-ticket-calendar">
            <DateRangeCalendar
              from={from}
              to={to}
              onChange={({ from: nextFrom, to: nextTo }) => {
                setPeriod('custom');
                setFrom(nextFrom);
                setTo(nextTo);
                setPage(0);
              }}
            />
          </div>
        )}

        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-sm flex-1 min-w-[240px]">
            <span className="text-slate-400 block mb-1">Global Search</span>
            <input
              type="search"
              className="field-input"
              placeholder="Slip, vehicle, RFID, transporter, operator, material, destination…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applySearch()}
            />
          </label>
          <button type="button" className="btn-ghost" onClick={applySearch}>Search</button>
          {search && (
            <button type="button" className="btn-ghost text-xs" onClick={() => { setSearch(''); setSearchInput(''); setPage(0); }}>
              Clear
            </button>
          )}
        </div>
      </section>

      {someSelected && (
        <section className="card p-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-400">{selected.size} selected</span>
          <button type="button" className="btn-ghost text-xs py-1" disabled={exporting} onClick={bulkPdf}>
            Download Closed Reports (PDF)
          </button>
          <button type="button" className="btn-ghost text-xs py-1" disabled={exporting} onClick={bulkExcel}>
            Download Closed Excel
          </button>
          <button type="button" className="btn-ghost text-xs py-1" disabled={exporting} onClick={bulkExcelPdf}>
            Download Closed PDF (Data)
          </button>
          <button type="button" className="btn-ghost text-xs py-1" disabled={exporting} onClick={bulkPrint}>
            Print Selected
          </button>
          <button type="button" className="btn-ghost text-xs py-1" onClick={() => setSelected(new Set())}>
            Clear Selection
          </button>
        </section>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-ghost text-xs" disabled={exporting || !pagination.total} onClick={printFiltered}>
          Print Current Filter Results
        </button>
      </div>

      <section className="card overflow-hidden">
        {loading ? (
          <p className="p-6 text-center text-slate-500">Loading…</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-3 w-10">
                      <input type="checkbox" checked={allPageSelected} onChange={toggleAllPage} aria-label="Select all on page" />
                    </th>
                    <th className="px-3 py-3">Slip No</th>
                    <th className="px-3 py-3">Vehicle No</th>
                    <th className="px-3 py-3">Destination</th>
                    <th className="px-3 py-3">Material</th>
                    <th className="px-3 py-3">Operator</th>
                    <th className="px-3 py-3">Gross</th>
                    <th className="px-3 py-3">Tare</th>
                    <th className="px-3 py-3">Net</th>
                    <th className="px-3 py-3">Weighed Out</th>
                    <th className="px-3 py-3">Arrival</th>
                    <th className="px-3 py-3">Departure</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">MCG</th>
                    <th className="px-3 py-3">Photos</th>
                    <th className="px-3 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={17} className="px-4 py-8 text-center text-slate-500">
                        No tickets match the current filters.
                      </td>
                    </tr>
                  ) : (
                    rows.map((t) => {
                      const photoCount = listTripCameraImages(t).length;
                      return (
                        <tr key={t.id} className="border-b border-slate-800/60 hover:bg-slate-800/30">
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={selected.has(t.id)}
                              onChange={() => toggleOne(t.id)}
                              aria-label={`Select ${t.slip_number}`}
                            />
                          </td>
                          <td className="px-3 py-2 font-mono">{t.slip_number}</td>
                          <td className="px-3 py-2">{t.truck_number}</td>
                          <td className="px-3 py-2">{t.destination || '—'}</td>
                          <td className="px-3 py-2">{t.material || '—'}</td>
                          <td className="px-3 py-2">{t.operator_name || '—'}</td>
                          <td className="px-3 py-2 tabular-nums">{t.gross_weight ?? '—'}</td>
                          <td className="px-3 py-2 tabular-nums">{t.tare_weight ?? '—'}</td>
                          <td className="px-3 py-2 tabular-nums">{t.net_weight ?? '—'}</td>
                          <td className="px-3 py-2 text-xs whitespace-nowrap">
                            {netWeightAt(t) ? (
                              <>
                                <div>{fmtDate(netWeightAt(t))}</div>
                                <div className="text-slate-500">{fmtTime(netWeightAt(t))}</div>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs whitespace-nowrap">
                            <div>{fmtDate(t.timestamp_in)}</div>
                            <div className="text-slate-500">{fmtTime(t.timestamp_in)}</div>
                          </td>
                          <td className="px-3 py-2 text-xs whitespace-nowrap">
                            <div>{fmtDate(t.timestamp_out)}</div>
                            <div className="text-slate-500">{fmtTime(t.timestamp_out)}</div>
                          </td>
                          <td className="px-3 py-2">
                            <Badge label={ticketStatusLabel(t)} variant={ticketStatusVariant(t)} />
                          </td>
                          <td className="px-3 py-2">
                            {isClosedTicket(t) ? (
                              <div className="flex flex-col items-start gap-1">
                                <span title={mcgStatusTitle(t)}>
                                  <Badge label={mcgStatusLabel(t)} variant={mcgStatusVariant(t)} />
                                </span>
                                <button
                                  type="button"
                                  title="Send this ticket to MCG again"
                                  className="text-xs text-amber-300 hover:text-amber-200 disabled:opacity-50"
                                  disabled={mcgResending.has(t.id)}
                                  onClick={() => handleMcgResend(t)}
                                >
                                  {mcgResending.has(t.id) ? 'Sending…' : 'Resend'}
                                </button>
                              </div>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {photoCount > 0 ? (
                              <button
                                type="button"
                                className="text-xs text-brand-300 hover:text-brand-200"
                                onClick={() =>
                                  setGalleryTicket({
                                    transactionId: t.id,
                                    slip_number: t.slip_number,
                                    images: listTripCameraImages(t),
                                    editable: isClosedTicket(t),
                                  })
                                }
                              >
                                {photoLabel(photoCount)}
                              </button>
                            ) : isClosedTicket(t) ? (
                              <button
                                type="button"
                                className="text-xs text-brand-300 hover:text-brand-200"
                                onClick={() =>
                                  setGalleryTicket({
                                    transactionId: t.id,
                                    slip_number: t.slip_number,
                                    images: [],
                                    editable: true,
                                  })
                                }
                              >
                                Add photos
                              </button>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs items-center">
                              <button type="button" className="text-brand-300" onClick={() => setPreviewTicket(t)}>
                                Preview
                              </button>
                              <button
                                type="button"
                                className="text-amber-300 hover:text-amber-200"
                                onClick={() => setEditSlipTicket(t)}
                              >
                                Edit Slip
                              </button>
                              {isClosedTicket(t) && (
                                <button
                                  type="button"
                                  className="rounded-md border border-emerald-700/50 bg-emerald-950/30 px-2 py-1 font-medium text-emerald-200 hover:bg-emerald-900/40"
                                  disabled={exporting}
                                  onClick={async () => {
                                    setExporting(true);
                                    try {
                                      await reportAPI.exportTripPDF(t.id);
                                    } catch (e) {
                                      console.error(e);
                                    } finally {
                                      setExporting(false);
                                    }
                                  }}
                                >
                                  Download Report
                                </button>
                              )}
                              {isClosedTicket(t) && (
                                <button
                                  type="button"
                                  className="text-brand-300"
                                  onClick={() => reportAPI.exportExcelByIds([t.id])}
                                >
                                  Excel
                                </button>
                              )}
                              <button type="button" className="text-brand-300" onClick={() => reportAPI.printReports([t.id])}>
                                Print
                              </button>
                              <button type="button" className="text-slate-400" onClick={() => reportAPI.printSlip(t.id)}>
                                Reprint
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-slate-800 px-4 py-3 text-sm text-slate-400">
              <span>
                Page {pagination.page + 1} of {pagination.totalPages} · {pagination.total} tickets
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-ghost text-xs py-1"
                  disabled={page <= 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn-ghost text-xs py-1"
                  disabled={page >= pagination.totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </section>

      <ExportCenter
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        onExport={runExport}
        selectedIds={selectedIds}
        busy={exporting}
      />

      {previewTicket && (
        <ReportPreviewModal
          transactionId={previewTicket.id}
          slipNumber={previewTicket.slip_number}
          ticket={previewTicket}
          editable={isClosedTicket(previewTicket)}
          onClose={() => setPreviewTicket(null)}
          onPhotosUpdated={refreshTicketRow}
        />
      )}

      {editSlipTicket && (
        <EditSlipModal
          ticket={editSlipTicket}
          onClose={() => setEditSlipTicket(null)}
          onSaved={refreshTicketRow}
        />
      )}

      {galleryTicket && (
        <PhotoGalleryModal
          ticket={galleryTicket}
          editable={galleryTicket.editable}
          onClose={() => setGalleryTicket(null)}
          onPhotosUpdated={refreshTicketRow}
        />
      )}
    </div>
  );
}
