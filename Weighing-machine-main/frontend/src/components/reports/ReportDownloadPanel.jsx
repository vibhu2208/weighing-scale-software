import React, { useState } from 'react';
import { getPeriodRange, todayISO, toFilterTimestamps } from '../../lib/reportDates.js';

const DATE_PRESETS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last_3_days', label: '3 Days' },
  { id: 'last_7_days', label: '7 Days' },
  { id: 'this_month', label: 'This Month' },
  { id: 'custom', label: 'Custom' },
];

function PresetChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
        active
          ? 'bg-brand-600 text-white shadow-sm shadow-brand-600/30'
          : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

export default function ReportDownloadPanel({ onExport, busy }) {
  const [preset, setPreset] = useState('today');
  const [customFrom, setCustomFrom] = useState(todayISO());
  const [customTo, setCustomTo] = useState(todayISO());

  const range = preset === 'custom'
    ? getPeriodRange('custom', customFrom, customTo)
    : getPeriodRange(preset);

  const runExport = (type) => {
    const timestamps = toFilterTimestamps(range.from, range.to);
    onExport({ type, filters: timestamps, periodLabel: range.label });
  };

  return (
    <section className="card overflow-hidden">
      <div className="border-b border-slate-800 bg-gradient-to-r from-brand-950/40 to-slate-900/40 px-5 py-4">
        <h2 className="text-sm font-semibold text-white">Download Reports & Data</h2>
        <p className="mt-0.5 text-xs text-slate-400">Exports include closed tickets only (Excel, PDF data, CSV, and ticket report PDFs)</p>
      </div>

      <div className="flex flex-col gap-4 p-5">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Date Range</p>
          <div className="flex flex-wrap gap-2">
            {DATE_PRESETS.map((p) => (
              <PresetChip key={p.id} active={preset === p.id} onClick={() => setPreset(p.id)}>
                {p.label}
              </PresetChip>
            ))}
          </div>
        </div>

        {preset === 'custom' && (
          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-slate-400">From</span>
              <input
                type="date"
                className="field-input"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-slate-400">To</span>
              <input
                type="date"
                className="field-input"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </label>
          </div>
        )}

        <div className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-xs text-slate-400">
          Selected: <span className="font-medium text-brand-300">{range.label}</span>
          {' · '}
          {range.from === range.to ? range.from : `${range.from} → ${range.to}`}
        </div>

        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Export Format</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary text-xs"
              disabled={busy}
              onClick={() => runExport('closed_pdf_pack')}
            >
              Closed Reports PDF
            </button>
            <button
              type="button"
              className="btn-ghost text-xs"
              disabled={busy}
              onClick={() => runExport('pdf_pack')}
            >
              All Tickets PDF
            </button>
            <button
              type="button"
              className="btn-ghost text-xs border border-emerald-800/50 text-emerald-300 hover:bg-emerald-950/40"
              disabled={busy}
              onClick={() => runExport('excel')}
            >
              Excel (Closed)
            </button>
            <button
              type="button"
              className="btn-ghost text-xs border border-amber-800/50 text-amber-300 hover:bg-amber-950/40"
              disabled={busy}
              onClick={() => runExport('excel_pdf')}
            >
              PDF (Closed Data)
            </button>
            <button
              type="button"
              className="btn-ghost text-xs"
              disabled={busy}
              onClick={() => runExport('csv')}
            >
              CSV (Closed)
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
