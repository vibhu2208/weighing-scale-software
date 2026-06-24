import React, { useState } from 'react';
import { getPeriodRange, todayISO, toFilterTimestamps } from '../../lib/reportDates.js';

const FORMAT_TABS = [
  { id: 'closed_pdf_pack', label: 'Closed Reports PDF', desc: 'PDF pack for CLOSED tickets only' },
  { id: 'pdf_pack', label: 'All Tickets PDF', desc: 'Combined PDF with cover + all ticket reports' },
  { id: 'excel', label: 'Excel (Closed)', desc: 'Spreadsheet export for closed tickets in the selected range' },
  { id: 'excel_pdf', label: 'PDF (Closed Data)', desc: 'Same tabular data as Excel, saved as PDF' },
  { id: 'csv', label: 'CSV (Closed)', desc: 'Comma-separated export for closed tickets only' },
  { id: 'single', label: 'Single PDF', desc: 'One ticket report' },
];

const DATE_PRESETS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last_3_days', label: '3 Days' },
  { id: 'last_7_days', label: '7 Days' },
  { id: 'this_week', label: 'This Week' },
  { id: 'this_month', label: 'This Month' },
  { id: 'custom', label: 'Custom' },
];

function PresetChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
        active
          ? 'bg-brand-600 text-white'
          : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
      }`}
    >
      {children}
    </button>
  );
}

export default function ExportCenter({ open, onClose, onExport, selectedIds, busy }) {
  const [format, setFormat] = useState('closed_pdf_pack');
  const [preset, setPreset] = useState('today');
  const [customFrom, setCustomFrom] = useState(todayISO());
  const [customTo, setCustomTo] = useState(todayISO());
  const [singleId, setSingleId] = useState('');

  if (!open) return null;

  const range = preset === 'custom'
    ? getPeriodRange('custom', customFrom, customTo)
    : getPeriodRange(preset);

  const timestamps = toFilterTimestamps(range.from, range.to);
  const activeFormat = FORMAT_TABS.find((f) => f.id === format);

  const handleSubmit = () => {
    if (format === 'single') {
      const id = singleId || selectedIds?.[0];
      if (!id) return;
      onExport({ type: 'single', transactionId: id });
      return;
    }
    if (format === 'csv') {
      onExport({
        type: 'csv',
        filters: { ...timestamps, ticket_status: 'CLOSED' },
        periodLabel: range.label,
      });
      return;
    }
    if (format === 'excel') {
      onExport({
        type: 'excel',
        filters: { ...timestamps, ticket_status: 'CLOSED' },
        periodLabel: range.label,
      });
      return;
    }
    if (format === 'excel_pdf') {
      onExport({
        type: 'excel_pdf',
        filters: { ...timestamps, ticket_status: 'CLOSED' },
        periodLabel: range.label,
      });
      return;
    }
    if (format === 'closed_pdf_pack') {
      onExport({ type: 'closed_pdf_pack', filters: timestamps, periodLabel: range.label });
      return;
    }
    onExport({ type: 'pdf_pack', filters: timestamps, periodLabel: range.label });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Export Center</h2>
            <p className="text-xs text-slate-400">Download reports or data for any date range</p>
          </div>
          <button type="button" className="btn-ghost text-xs py-1 px-2" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Format</p>
            <div className="grid grid-cols-2 gap-2">
              {FORMAT_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFormat(tab.id)}
                  className={`rounded-lg border px-3 py-2.5 text-left transition ${
                    format === tab.id
                      ? 'border-brand-500 bg-brand-950/50'
                      : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
                  }`}
                >
                  <span className={`block text-sm font-medium ${format === tab.id ? 'text-brand-300' : 'text-white'}`}>
                    {tab.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-slate-500">{tab.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {format !== 'single' && (
            <>
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Date Range</p>
                <div className="flex flex-wrap gap-1.5">
                  {DATE_PRESETS.map((p) => (
                    <PresetChip key={p.id} active={preset === p.id} onClick={() => setPreset(p.id)}>
                      {p.label}
                    </PresetChip>
                  ))}
                </div>
              </div>

              {preset === 'custom' && (
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-sm">
                    <span className="mb-1 block text-xs text-slate-400">From</span>
                    <input type="date" className="field-input" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-xs text-slate-400">To</span>
                    <input type="date" className="field-input" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
                  </label>
                </div>
              )}

              <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-400">
                {range.label} · {range.from === range.to ? range.from : `${range.from} → ${range.to}`}
              </div>
            </>
          )}

          {format === 'single' && (
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm">
              <p className="text-xs text-slate-400 mb-2">
                {selectedIds?.length
                  ? `${selectedIds.length} ticket(s) selected — first will be used if no ID entered.`
                  : 'Select a ticket in the table or enter a transaction ID below.'}
              </p>
              <label className="block text-sm">
                <span className="mb-1 block text-xs text-slate-400">Transaction ID (optional)</span>
                <input
                  type="text"
                  className="field-input"
                  placeholder="Leave blank to use selected ticket"
                  value={singleId}
                  onChange={(e) => setSingleId(e.target.value)}
                />
              </label>
            </div>
          )}

          {format === 'pdf_pack' && (
            <p className="text-xs text-slate-500">
              PDF pack includes a cover page plus one complete ticket report per page.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-4">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={handleSubmit} disabled={busy}>
            {busy ? 'Exporting…' : `Export ${activeFormat?.label || 'File'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
