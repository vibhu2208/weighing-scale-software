import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import Badge from '../components/Badge.jsx';
import CreatedTripsSync from '../components/CreatedTripsSync.jsx';
import { fmtDate, fmtKg, toDatetimeLocalValue } from '../lib/format.js';
import { generateFillTimes } from '../lib/slipFillTimes.js';
import { generateFillWeights } from '../lib/slipFillWeights.js';
import { FILL_VEHICLES as VEHICLES } from '../lib/fillLists.js';

const OPERATORS = ['KARAMVEER', 'RONAK', 'MUNESH', 'CANCEL', 'SUMIT', 'PAWAN', 'MANISH'];
const FIXED = {
  material: 'RDF',
  customer_name: 'MCG',
  destination: 'MUZAFFAR NAGAR',
  vehicle_type: 'TRUCK',
  ticket_status: 'CLOSED',
};
const SAVED_LIST_CHECKS = [
  { list: 'materials', label: 'material', values: [FIXED.material] },
  { list: 'customers', label: 'customer', values: [FIXED.customer_name] },
  { list: 'destinations', label: 'destination', values: [FIXED.destination] },
  { list: 'operators', label: 'operator', values: OPERATORS },
];
const COMPLETE_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const TARE_HISTORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function emptyEntry() {
  return {
    selected: false,
    truck_number: '',
    operator_name: '',
    gross_weight: '',
    tare_weight: '',
    timestamp_in: '',
    timestamp_out: '',
    timeWarnings: [],
    weightNote: '',
    weightWarning: '',
    operatorAuto: true,
    operatorNote: '',
  };
}

function sameLocalDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

/** Operator of the neighbouring slip closest in time to `timestampIn` on the same day. */
function nearbyOperator(row, timestampIn) {
  const inMs = localMs(timestampIn);
  if (!row || !Number.isFinite(inMs)) return { operator_name: '', operatorNote: '' };
  const candidates = [row.prev, row.next]
    .filter((n) => n?.operator_name && n.timestamp_in)
    .map((n) => ({ ...n, at: new Date(n.timestamp_in).getTime() }))
    .filter((n) => Number.isFinite(n.at) && sameLocalDay(n.at, inMs))
    .sort((a, b) => Math.abs(a.at - inMs) - Math.abs(b.at - inMs));
  const hit = candidates[0];
  if (!hit) {
    return { operator_name: '', operatorNote: 'No neighbouring slip on the same day has an operator; pick one' };
  }
  const name = String(hit.operator_name).trim();
  const match = OPERATORS.find((o) => o.toLowerCase() === name.toLowerCase());
  if (!match) {
    return {
      operator_name: '',
      operatorNote: `Nearby slip ${hit.slip_number} has operator "${name}", which is not in the operator list; pick one`,
    };
  }
  return { operator_name: match, operatorNote: `Operator from ${hit.slip_number} (same day, nearest in time)` };
}

/** Re-pick the operator from neighbours unless the user chose one by hand. */
function withAutoOperator(entry, row) {
  if (!entry.operatorAuto) return entry;
  return { ...entry, ...nearbyOperator(row, entry.timestamp_in) };
}

/** Earliest point a fill row's in time can fall, minus the tare look-back. */
function tareHistorySince(rows) {
  let earliest = Date.now();
  for (const row of rows) {
    const at = new Date(row.prev?.timestamp_in || '').getTime();
    if (Number.isFinite(at) && at < earliest) earliest = at;
  }
  return new Date(earliest - TARE_HISTORY_DAYS * DAY_MS).toISOString();
}

function weightPatch(history, truck, timestampIn) {
  if (!truck) return { weightNote: '', weightWarning: '' };
  const w = generateFillWeights(history || [], truck, localMs(timestampIn));
  return {
    gross_weight: String(w.gross),
    tare_weight: w.tare == null ? '' : String(w.tare),
    weightNote: w.source,
    weightWarning: history ? w.warning : 'Tare history is still loading; use Regenerate weights',
  };
}

function applyTimes(entries, generated, rows) {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const next = { ...entries };
  for (const [id, t] of Object.entries(generated)) {
    next[id] = withAutoOperator(
      {
        ...(next[id] || emptyEntry()),
        timestamp_in: toDatetimeLocalValue(t.timestamp_in),
        timestamp_out: toDatetimeLocalValue(t.timestamp_out),
        timeWarnings: t.warnings,
      },
      rowById.get(id),
    );
  }
  return next;
}

function localMs(value) {
  if (!COMPLETE_LOCAL_RE.test(String(value || ''))) return NaN;
  return new Date(value).getTime();
}

function rowErrors(entry) {
  const errors = [];
  if (!entry.truck_number) errors.push('Pick a vehicle');
  if (!entry.operator_name) errors.push('Pick an operator');
  const gross = Number(entry.gross_weight);
  const tare = Number(entry.tare_weight);
  if (!entry.gross_weight || !(gross > 0)) errors.push('Enter gross weight');
  if (!entry.tare_weight || !(tare > 0)) errors.push('Enter tare weight');
  if (gross > 0 && tare > 0 && gross <= tare) errors.push('Gross must be greater than tare');
  const inMs = localMs(entry.timestamp_in);
  const outMs = localMs(entry.timestamp_out);
  if (!Number.isFinite(inMs)) errors.push('In time needs date and HH:mm:ss');
  if (!Number.isFinite(outMs)) errors.push('Out time needs date and HH:mm:ss');
  if (Number.isFinite(inMs) && Number.isFinite(outMs) && outMs <= inMs) {
    errors.push('Out time must be after in time');
  }
  return errors;
}

/** Same vehicle on two selected slips whose in-to-out windows overlap. */
function overlapErrors(rows, entries) {
  const byId = {};
  const picked = rows
    .map((row) => ({ row, entry: entries[row.id] }))
    .filter(({ entry }) => entry?.selected && entry.truck_number)
    .map(({ row, entry }) => ({
      id: row.id,
      slip: row.slip_number,
      truck: entry.truck_number,
      inMs: localMs(entry.timestamp_in),
      outMs: localMs(entry.timestamp_out),
    }))
    .filter((p) => Number.isFinite(p.inMs) && Number.isFinite(p.outMs));

  for (let i = 0; i < picked.length; i += 1) {
    for (let j = i + 1; j < picked.length; j += 1) {
      const a = picked[i];
      const b = picked[j];
      if (a.truck !== b.truck) continue;
      if (a.inMs < b.outMs && b.inMs < a.outMs) {
        (byId[a.id] ||= []).push(`${a.truck} is still on slip ${b.slip} at this time`);
        (byId[b.id] ||= []).push(`${b.truck} is still on slip ${a.slip} at this time`);
      }
    }
  }
  return byId;
}

function statusTone(status) {
  if (status === 'created') return 'success';
  if (status === 'valid') return 'info';
  return 'danger';
}

function statusLabel(status) {
  return { valid: 'Ready', invalid: 'Fix', created: 'Created', failed: 'Failed' }[status] || status;
}

export default function FillBlockedSlips() {
  const [rows, setRows] = useState([]);
  const [entries, setEntries] = useState({});
  const [lists, setLists] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState(null);
  const [createdIds, setCreatedIds] = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [tareHistory, setTareHistory] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getHeldSlipWindows();
      const fresh = data.rows || [];
      setRows(fresh);
      api
        .getVehicleTares(VEHICLES, tareHistorySince(fresh))
        .then((res) => setTareHistory(res.rows || []))
        .catch((err) => {
          setTareHistory([]);
          setError(`Could not load vehicle tare history: ${err.message}`);
        });
      setEntries((prev) => {
        const kept = {};
        for (const row of fresh) kept[row.id] = prev[row.id] || emptyEntry();
        const needTimes = fresh.filter((row) => !kept[row.id].timestamp_in).map((r) => r.id);
        return applyTimes(kept, generateFillTimes(fresh, needTimes), fresh);
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    Promise.all(SAVED_LIST_CHECKS.map(({ list }) => api.getList(list)))
      .then((res) => {
        const out = {};
        SAVED_LIST_CHECKS.forEach(({ list }, i) => {
          out[list] = res[i].items || [];
        });
        setLists(out);
      })
      .catch(() => setLists(null));
  }, []);

  const missingFromLists = useMemo(() => {
    if (!lists) return [];
    const missing = [];
    for (const { list, label, values } of SAVED_LIST_CHECKS) {
      const saved = (lists[list] || []).map((v) => String(v).trim().toLowerCase());
      if (!saved.length) continue;
      for (const value of values) {
        if (!saved.includes(value.toLowerCase())) missing.push(`${label} "${value}"`);
      }
    }
    return missing;
  }, [lists]);

  const overlaps = useMemo(() => overlapErrors(rows, entries), [rows, entries]);
  const selectedRows = rows.filter((row) => entries[row.id]?.selected);
  const problems = useMemo(() => {
    const out = {};
    for (const row of rows) {
      const entry = entries[row.id];
      if (!entry?.selected) continue;
      const errs = [...rowErrors(entry), ...(overlaps[row.id] || [])];
      if (errs.length) out[row.id] = errs;
    }
    return out;
  }, [rows, entries, overlaps]);
  const blocked = selectedRows.length === 0 || Object.keys(problems).length > 0;
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;

  function update(id, patch) {
    setEntries((prev) => ({ ...prev, [id]: { ...(prev[id] || emptyEntry()), ...patch } }));
    setResult(null);
  }

  function updateInTime(row, value) {
    setEntries((prev) => ({
      ...prev,
      [row.id]: withAutoOperator({ ...(prev[row.id] || emptyEntry()), timestamp_in: value }, row),
    }));
    setResult(null);
  }

  function toggleAll(checked) {
    setEntries((prev) => {
      const next = { ...prev };
      for (const row of rows) next[row.id] = { ...(next[row.id] || emptyEntry()), selected: checked };
      return next;
    });
  }

  function pickVehicle(id, truck) {
    setEntries((prev) => {
      const entry = prev[id] || emptyEntry();
      return {
        ...prev,
        [id]: { ...entry, truck_number: truck, ...weightPatch(tareHistory, truck, entry.timestamp_in) },
      };
    });
    setResult(null);
  }

  function regenerate() {
    const ids = selectedRows.length ? selectedRows.map((r) => r.id) : rows.map((r) => r.id);
    setEntries((prev) => applyTimes(prev, generateFillTimes(rows, ids), rows));
    setResult(null);
  }

  function regenerateWeights() {
    setEntries((prev) => {
      const next = { ...prev };
      for (const row of selectedRows) {
        const entry = next[row.id];
        if (!entry?.truck_number) continue;
        next[row.id] = {
          ...entry,
          ...weightPatch(tareHistory, entry.truck_number, entry.timestamp_in),
        };
      }
      return next;
    });
    setResult(null);
  }

  function buildTrips() {
    return selectedRows.map((row) => {
      const entry = entries[row.id];
      return {
        ...FIXED,
        reservation_id: row.id,
        slip_number: row.slip_number,
        truck_number: entry.truck_number,
        operator_name: entry.operator_name,
        gross_weight: Number(entry.gross_weight),
        tare_weight: Number(entry.tare_weight),
        timestamp_in: new Date(entry.timestamp_in).toISOString(),
        timestamp_out: new Date(entry.timestamp_out).toISOString(),
      };
    });
  }

  async function run(dryRun) {
    if (blocked) return;
    const trips = buildTrips();
    if (
      !dryRun &&
      !window.confirm(`Create ${trips.length} remote trip(s) on the selected blocked slips?`)
    ) {
      return;
    }
    setBusy(dryRun ? 'check' : 'create');
    setError('');
    setMessage('');
    try {
      const data = await api.importRemoteTrips(trips, { dryRun });
      setResult({
        ...data,
        results: data.results.map((r) => ({ ...r, slip_number: trips[r.index].slip_number })),
      });
      if (!dryRun) {
        const ids = data.results.filter((r) => r.status === 'created' && r.id).map((r) => r.id);
        setCreatedIds((prev) => [...ids, ...prev]);
        setRefreshKey((k) => k + 1);
        setMessage(
          `Created ${data.summary.created} trip(s). The weighbridge PC picks them up on its next pull` +
            ' (out times in the future wait until that time). Attach vehicle photos from Bulk Photos.',
        );
        await load();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h2 className="text-xl font-semibold">Fill blocked slips</h2>
        <p className="text-sm text-slate-400 mt-1">
          Pick the blocked slips to fill and choose a vehicle and operator for each. Tare is filled
          from that vehicle&apos;s previous-day tare ± 50–200 kg and gross at random between 65,000
          and 65,500 kg. The in time (tare, 1st weigh) is placed at random between the previous and
          next slip&apos;s in times; the out time (gross) is 1 h 45 m to 2 h 30 m later. Weights and
          times can be edited before creating.{' '}
          <Link to="/plan-gaps" className="text-brand-300 hover:underline">
            Back to Plan Gaps
          </Link>
          {' · '}
          <Link to="/bulk-photos" className="text-brand-300 hover:underline">
            Bulk vehicle photos
          </Link>
        </p>
      </div>

      <div className="rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm flex flex-wrap gap-x-6 gap-y-1">
        <span>
          <span className="text-slate-400">Material</span>{' '}
          <span className="font-medium text-white">{FIXED.material}</span>
        </span>
        <span>
          <span className="text-slate-400">Customer</span>{' '}
          <span className="font-medium text-white">{FIXED.customer_name}</span>
        </span>
        <span>
          <span className="text-slate-400">Destination</span>{' '}
          <span className="font-medium text-white">{FIXED.destination}</span>
        </span>
        <span>
          <span className="text-slate-400">Vehicle type</span>{' '}
          <span className="font-medium text-white">TRUCK (tare first)</span>
        </span>
        <span>
          <span className="text-slate-400">Ticket</span>{' '}
          <span className="font-medium text-white">Closed</span>
        </span>
      </div>

      {missingFromLists.length > 0 && (
        <p className="text-sm text-amber-300">
          Not in the saved lists yet: {missingFromLists.join(', ')}. Trips using them will be
          rejected until you add them in{' '}
          <Link to="/settings/advance" className="underline">
            Advance Settings
          </Link>
          .
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-ghost text-xs" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh slips'}
        </button>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={regenerate}
          disabled={!rows.length}
        >
          {selectedRows.length ? `Regenerate times (${selectedRows.length} selected)` : 'Regenerate all times'}
        </button>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={regenerateWeights}
          disabled={!selectedRows.some((row) => entries[row.id]?.truck_number) || !tareHistory}
          title="Re-roll tare and gross for selected rows that have a vehicle"
        >
          {tareHistory ? 'Regenerate weights' : 'Loading tare history…'}
        </button>
        <span className="text-xs text-slate-500">
          {rows.length} blocked slip(s) · {selectedRows.length} selected
        </span>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-800">
              <th className="p-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => toggleAll(e.target.checked)}
                  aria-label="Select all"
                />
              </th>
              <th className="p-2">Slip</th>
              <th className="p-2">Between</th>
              <th className="p-2">Vehicle</th>
              <th className="p-2">Operator</th>
              <th className="p-2">Gross kg</th>
              <th className="p-2">Tare kg</th>
              <th className="p-2">In (tare)</th>
              <th className="p-2">Out (gross)</th>
              <th className="p-2">Net</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const entry = entries[row.id] || emptyEntry();
              const errs = problems[row.id] || [];
              const net =
                Number(entry.gross_weight) > 0 && Number(entry.tare_weight) > 0
                  ? Number(entry.gross_weight) - Number(entry.tare_weight)
                  : null;
              const hasNotes =
                errs.length > 0 ||
                entry.timeWarnings.length > 0 ||
                Boolean(entry.weightNote || entry.weightWarning || entry.operatorNote);
              return (
                <React.Fragment key={row.id}>
                  <tr className={`align-top ${hasNotes ? '' : 'border-b border-slate-800/60'}`}>
                    <td className="p-2">
                      <input
                        type="checkbox"
                        checked={entry.selected}
                        onChange={(e) => update(row.id, { selected: e.target.checked })}
                        aria-label={`Select ${row.slip_number}`}
                      />
                    </td>
                    <td className="p-2 font-mono text-xs">{row.slip_number}</td>
                    <td className="p-2 text-xs text-slate-400 whitespace-nowrap">
                      <div>
                        {row.prev ? (
                          <>
                            <span className="font-mono text-slate-300">{row.prev.slip_number}</span>{' '}
                            {fmtDate(row.prev.timestamp_in)}
                          </>
                        ) : (
                          '—'
                        )}
                      </div>
                      <div>
                        {row.next ? (
                          <>
                            <span className="font-mono text-slate-300">{row.next.slip_number}</span>{' '}
                            {fmtDate(row.next.timestamp_in)}
                          </>
                        ) : (
                          '—'
                        )}
                      </div>
                    </td>
                    <td className="p-2">
                      <select
                        className="field-input text-xs py-1 min-w-[8.5rem]"
                        value={entry.truck_number}
                        onChange={(e) => pickVehicle(row.id, e.target.value)}
                      >
                        <option value="">Select…</option>
                        {VEHICLES.map((v, i) => (
                          <option key={v} value={v}>
                            {i + 1}. {v}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-2">
                      <select
                        className="field-input text-xs py-1 min-w-[7.5rem]"
                        value={entry.operator_name}
                        onChange={(e) =>
                          update(row.id, {
                            operator_name: e.target.value,
                            operatorAuto: !e.target.value,
                            operatorNote: '',
                          })
                        }
                      >
                        <option value="">Select…</option>
                        {OPERATORS.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-2">
                      <input
                        type="number"
                        min={1}
                        className="field-input text-xs py-1 w-24"
                        value={entry.gross_weight}
                        onChange={(e) => update(row.id, { gross_weight: e.target.value })}
                      />
                    </td>
                    <td className="p-2">
                      <input
                        type="number"
                        min={1}
                        className="field-input text-xs py-1 w-24"
                        value={entry.tare_weight}
                        onChange={(e) => update(row.id, { tare_weight: e.target.value })}
                      />
                    </td>
                    <td className="p-2">
                      <input
                        type="datetime-local"
                        step={1}
                        className="field-input text-xs py-1"
                        value={entry.timestamp_in}
                        onChange={(e) => updateInTime(row, e.target.value)}
                      />
                    </td>
                    <td className="p-2">
                      <input
                        type="datetime-local"
                        step={1}
                        className="field-input text-xs py-1"
                        value={entry.timestamp_out}
                        onChange={(e) => update(row.id, { timestamp_out: e.target.value })}
                      />
                    </td>
                    <td className="p-2 text-xs whitespace-nowrap">{fmtKg(net)}</td>
                  </tr>
                  {hasNotes && (
                    <tr className="border-b border-slate-800/60">
                      <td />
                      <td colSpan={9} className="px-2 pb-2 text-xs space-y-0.5">
                        {errs.map((msg) => (
                          <p key={msg} className="text-red-300">
                            {msg}
                          </p>
                        ))}
                        {entry.weightWarning && (
                          <p className="text-amber-300">{entry.weightWarning}</p>
                        )}
                        {entry.timeWarnings.map((msg) => (
                          <p key={msg} className="text-amber-300">
                            {msg}
                          </p>
                        ))}
                        {entry.weightNote && <p className="text-slate-500">{entry.weightNote}</p>}
                        {entry.operatorNote && (
                          <p className={entry.operator_name ? 'text-slate-500' : 'text-amber-300'}>
                            {entry.operatorNote}
                          </p>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={10} className="p-6 text-center text-slate-500">
                  No blocked slips to fill.{' '}
                  <Link to="/plan-gaps" className="text-brand-300 hover:underline">
                    Plan or block gaps
                  </Link>{' '}
                  first.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {message && <p className="text-sm text-emerald-400">{message}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-ghost"
          disabled={blocked || Boolean(busy)}
          onClick={() => run(true)}
        >
          {busy === 'check' ? 'Checking…' : `Check ${selectedRows.length} trip(s)`}
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={blocked || Boolean(busy)}
          onClick={() => run(false)}
        >
          {busy === 'create' ? 'Creating…' : `Create ${selectedRows.length} trip(s)`}
        </button>
        {selectedRows.length > 0 && Object.keys(problems).length > 0 && (
          <span className="text-xs text-red-300">
            Fix {Object.keys(problems).length} selected row(s) first.
          </span>
        )}
      </div>

      {result && (
        <div className="space-y-2">
          <p className="text-sm text-slate-300">
            {result.dry_run
              ? `Checked ${result.summary.total}: ${result.summary.valid} ready, ${result.summary.invalid} need fixing.`
              : `Created ${result.summary.created}, failed ${result.summary.failed}, skipped ${result.summary.invalid}.`}
          </p>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-800">
                  <th className="p-3">Slip</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Vehicle</th>
                  <th className="p-3">Details</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.index} className="border-b border-slate-800/60 align-top">
                    <td className="p-3 font-mono text-xs">{r.slip_number}</td>
                    <td className="p-3">
                      <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                    </td>
                    <td className="p-3">{r.truck_number}</td>
                    <td className="p-3 text-xs space-y-1">
                      {r.errors.map((msg) => (
                        <p key={msg} className="text-red-300">
                          {msg}
                        </p>
                      ))}
                      {r.warnings.map((msg) => (
                        <p key={msg} className="text-amber-300">
                          {msg}
                        </p>
                      ))}
                      {!r.errors.length && !r.warnings.length && (
                        <span className="text-slate-500">
                          {r.status === 'created' ? 'Created' : 'All fields match'}
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
