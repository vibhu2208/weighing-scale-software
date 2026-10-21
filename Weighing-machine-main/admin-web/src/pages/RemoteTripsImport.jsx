import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import Badge from '../components/Badge.jsx';
import CreatedTripsSync from '../components/CreatedTripsSync.jsx';

const MAX_TRIPS = 500;
const TIME_FIELDS = ['timestamp_in', 'timestamp_out'];
const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

const SAMPLE = [
  {
    slip_number: '',
    ticket_status: 'CLOSED',
    vehicle_type: 'HYWA',
    truck_number: 'HR38AH6118',
    gross_weight: 42150,
    tare_weight: 15200,
    timestamp_in: '2026-10-21 09:15:00',
    timestamp_out: '2026-10-21 10:05:30',
    material: 'Saved material name',
    customer_name: 'Saved customer name',
    destination: 'Saved destination name',
    operator_name: 'Saved operator name',
    transporter: '',
    rfid_tag: '',
  },
  {
    ticket_status: 'OPEN',
    vehicle_type: 'TRUCK',
    truck_number: 'HR55AB1234',
    tare_weight: 12800,
    timestamp_in: '2026-10-21 11:00:00',
    material: 'Saved material name',
    customer_name: 'Saved customer name',
    destination: 'Saved destination name',
    operator_name: 'Saved operator name',
  },
];

/** Times without a zone are read as this browser's local time (same as the single-trip form). */
function normalizeTime(value) {
  if (value === null || value === undefined || value === '') return value;
  const text = String(value).trim();
  if (!LOCAL_DATETIME_RE.test(text)) return value;
  const parsed = new Date(text.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function normalizeTrip(trip) {
  if (!trip || typeof trip !== 'object' || Array.isArray(trip)) return trip;
  const out = { ...trip };
  for (const key of TIME_FIELDS) out[key] = normalizeTime(out[key]);
  if (out.slip_number === '') delete out.slip_number;
  return out;
}

function parseTrips(text) {
  if (!text.trim()) return { trips: null, error: '' };
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { trips: null, error: `Invalid JSON: ${err.message}` };
  }
  const trips = Array.isArray(data) ? data : data?.trips;
  if (!Array.isArray(trips)) {
    return { trips: null, error: 'JSON must be an array of trips, or an object with a "trips" array' };
  }
  if (!trips.length) return { trips: null, error: 'The trips array is empty' };
  if (trips.length > MAX_TRIPS) {
    return { trips: null, error: `At most ${MAX_TRIPS} trips per import (got ${trips.length})` };
  }
  return { trips, error: '' };
}

function statusTone(status) {
  if (status === 'created') return 'success';
  if (status === 'valid') return 'info';
  return 'danger';
}

function statusLabel(status) {
  return (
    {
      valid: 'Ready',
      invalid: 'Fix',
      created: 'Created',
      failed: 'Failed',
    }[status] || status
  );
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function RemoteTripsImport() {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState(null);
  const [resultText, setResultText] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [createdIds, setCreatedIds] = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const parsed = useMemo(() => parseTrips(text), [text]);
  const resultIsCurrent = Boolean(result) && resultText === text;
  const checkIsCurrent = resultIsCurrent && result.dry_run;
  const readyCount = checkIsCurrent ? result.summary.valid : 0;

  function updateText(next) {
    setText(next);
    setError('');
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      updateText(await file.text());
      setFileName(file.name);
      setResult(null);
    } catch (err) {
      setError(`Could not read ${file.name}: ${err.message}`);
    }
  }

  async function run(dryRun) {
    if (!parsed.trips) return;
    if (!dryRun) {
      const ok = window.confirm(
        `Create ${readyCount} remote trip(s)? Rows marked Fix are skipped. This cannot be undone from here.`,
      );
      if (!ok) return;
    }
    setBusy(dryRun ? 'check' : 'import');
    setError('');
    try {
      const data = await api.importRemoteTrips(parsed.trips.map(normalizeTrip), { dryRun });
      setResult(data);
      setResultText(text);
      if (!dryRun) {
        const ids = data.results.filter((r) => r.status === 'created' && r.id).map((r) => r.id);
        setCreatedIds((prev) => [...ids, ...prev]);
        setRefreshKey((k) => k + 1);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function keepUnfinishedRows() {
    if (!resultIsCurrent || !parsed.trips) return;
    const keep = result.results
      .filter((r) => r.status === 'invalid' || r.status === 'failed')
      .map((r) => parsed.trips[r.index]);
    updateText(JSON.stringify(keep, null, 2));
    setResult(null);
  }

  const summary = result?.summary;
  const unfinished = summary ? summary.invalid + summary.failed : 0;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h2 className="text-xl font-semibold">Bulk remote trip import</h2>
        <p className="text-sm text-slate-400 mt-1">
          Paste or upload a JSON array of trips. Each trip uses the same fields and rules as the{' '}
          <Link to="/remote-trips" className="text-brand-300 hover:underline">
            single remote trip form
          </Link>
          . Check first, then import — rows that need fixing are skipped and the rest are created
          one by one. Remote trips are for{' '}
          <span className="text-slate-200 font-medium">DCC only</span>. After import, attach camera
          photos in{' '}
          <Link to="/bulk-photos" className="text-brand-300 hover:underline">
            bulk vehicle photos
          </Link>
          .
        </p>
      </div>

      <div className="card p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="btn-ghost cursor-pointer">
            Choose .json file
            <input type="file" accept=".json,application/json" className="hidden" onChange={onFile} />
          </label>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => downloadJson(SAMPLE, 'remote-trips-sample.json')}
          >
            Download sample
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              updateText(JSON.stringify(SAMPLE, null, 2));
              setFileName('');
              setResult(null);
            }}
          >
            Paste sample
          </button>
          {fileName && <span className="text-xs text-slate-500">Loaded {fileName}</span>}
        </div>

        <textarea
          className="field-input font-mono text-xs min-h-[18rem]"
          spellCheck={false}
          placeholder='[ { "vehicle_type": "HYWA", "truck_number": "HR38AH6118", ... } ]'
          value={text}
          onChange={(e) => updateText(e.target.value)}
        />

        <div className="text-xs text-slate-500 space-y-1">
          <p>
            Required: <code>vehicle_type</code> (HYWA, TRUCK, TANKER, CONTAINER),{' '}
            <code>truck_number</code>, <code>timestamp_in</code>, <code>material</code>,{' '}
            <code>customer_name</code>, <code>destination</code>, <code>operator_name</code>, plus
            weights. Closed tickets need <code>gross_weight</code>, <code>tare_weight</code> and{' '}
            <code>timestamp_out</code>; open tickets (<code>"ticket_status": "OPEN"</code>) carry
            only the first weigh — gross for HYWA, tare for others.
          </p>
          <p>
            Optional: <code>slip_number</code> (blank = next free slip), <code>replace_existing</code>,{' '}
            <code>reservation_id</code>, <code>rfid_tag</code>, <code>transporter</code>. Times like{' '}
            <code>2026-10-21 09:15:00</code> are read as your local time; ISO times with a zone are
            used as-is. Material, customer, destination and operator must match the saved lists.
          </p>
        </div>

        {parsed.error && <p className="text-sm text-red-400">{parsed.error}</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-ghost"
            disabled={!parsed.trips || Boolean(busy)}
            onClick={() => run(true)}
          >
            {busy === 'check'
              ? 'Checking…'
              : parsed.trips
                ? `Check ${parsed.trips.length} trip(s)`
                : 'Check'}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!readyCount || Boolean(busy)}
            onClick={() => run(false)}
          >
            {busy === 'import' ? 'Importing…' : `Import ${readyCount} ready trip(s)`}
          </button>
          {!checkIsCurrent && parsed.trips && !busy && (
            <span className="text-xs text-slate-500">Run Check before importing.</span>
          )}
        </div>
      </div>

      {result && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-slate-300">
              {result.dry_run ? (
                <>
                  Checked {summary.total}: <span className="text-emerald-400">{summary.valid} ready</span>
                  {summary.invalid > 0 && (
                    <>
                      , <span className="text-red-400">{summary.invalid} need fixing</span>
                    </>
                  )}
                  {summary.warnings > 0 && (
                    <>
                      , <span className="text-amber-400">{summary.warnings} with warnings</span>
                    </>
                  )}
                </>
              ) : (
                <>
                  Imported: <span className="text-emerald-400">{summary.created} created</span>
                  {summary.failed > 0 && (
                    <>
                      , <span className="text-red-400">{summary.failed} failed</span>
                    </>
                  )}
                  {summary.invalid > 0 && (
                    <>
                      , <span className="text-red-400">{summary.invalid} skipped (need fixing)</span>
                    </>
                  )}
                  . The weighbridge PC picks them up on its next pull.
                </>
              )}
            </div>
            <div className="flex gap-2">
              {!result.dry_run && resultIsCurrent && unfinished > 0 && (
                <button type="button" className="btn-ghost text-xs" onClick={keepUnfinishedRows}>
                  Keep only the {unfinished} unfinished row(s) to fix
                </button>
              )}
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() =>
                  downloadJson(
                    result,
                    result.dry_run ? 'remote-trips-check.json' : 'remote-trips-import-result.json',
                  )
                }
              >
                Download results
              </button>
            </div>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-800">
                  <th className="p-3">Row</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Slip</th>
                  <th className="p-3">Vehicle</th>
                  <th className="p-3">Details</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((row) => (
                  <tr key={row.index} className="border-b border-slate-800/60 align-top">
                    <td className="p-3 text-slate-400">{row.index + 1}</td>
                    <td className="p-3">
                      <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
                    </td>
                    <td className="p-3 font-mono text-xs">{row.slip_number || 'auto'}</td>
                    <td className="p-3">{row.truck_number || '—'}</td>
                    <td className="p-3 text-xs space-y-1">
                      {row.errors.map((msg) => (
                        <p key={msg} className="text-red-300">
                          {msg}
                        </p>
                      ))}
                      {row.warnings.map((msg) => (
                        <p key={msg} className="text-amber-300">
                          {msg}
                        </p>
                      ))}
                      {!row.errors.length && !row.warnings.length && (
                        <span className="text-slate-500">
                          {row.status === 'created' ? 'Created' : 'All fields match'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <CreatedTripsSync highlightIds={createdIds} refreshKey={refreshKey} />
    </div>
  );
}
