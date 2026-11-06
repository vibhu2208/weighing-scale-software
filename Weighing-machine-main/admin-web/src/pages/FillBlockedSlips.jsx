import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import Badge from '../components/Badge.jsx';
import CreatedTripsSync from '../components/CreatedTripsSync.jsx';
import {
  customDateToRange,
  fmtDate,
  fmtKg,
  periodToRange,
  toDatetimeLocalValue,
  ymd,
} from '../lib/format.js';
import { generateFillTimes, timesCollide } from '../lib/slipFillTimes.js';
import { generateFillWeights } from '../lib/slipFillWeights.js';
import {
  FILL_OPERATORS as OPERATORS,
  FILL_KIND_COMPOST,
  FILL_KIND_RDF,
  FILL_KINDS,
  DEFAULT_FILL_DESTINATION as DEFAULT_DESTINATION,
  compactPlate,
  defaultFillDestinations,
  defaultFillVehicles,
  destinationsForKind,
  fillDestinationNames,
  fillVehiclePlates,
  fillVehicleProfile,
  lookupFillVehicle,
  normalizeFillDestinations,
  normalizeFillKind,
  normalizeFillVehicles,
  samePlate,
} from '../lib/fillLists.js';

const CANCEL_LABEL = 'CANCEL';
const FIXED = {
  customer_name: 'MCG',
  ticket_status: 'CLOSED',
};
const CANCELLED_FIXED = {
  material: CANCEL_LABEL,
  customer_name: CANCEL_LABEL,
  destination: CANCEL_LABEL,
  vehicle_type: 'TRUCK',
  ticket_status: 'CANCELLED',
};
const SAVED_LIST_CHECKS = [
  { list: 'materials', label: 'material', values: ['RDF', 'COMPOST'] },
  { list: 'customers', label: 'customer', values: [FIXED.customer_name] },
  { list: 'operators', label: 'operator', values: OPERATORS },
];
const COMPLETE_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const TARE_HISTORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function emptyEntry() {
  return {
    selected: false,
    ticket_status: 'CLOSED',
    truck_number: '',
    destination: DEFAULT_DESTINATION,
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

function isCancelled(entry) {
  return String(entry?.ticket_status || '').toUpperCase() === 'CANCELLED';
}

function asCancelled(entry) {
  const timestampIn = entry.timestamp_in || entry.timestamp_out || '';
  return {
    ...entry,
    ticket_status: 'CANCELLED',
    operator_name: CANCEL_LABEL,
    operatorAuto: false,
    operatorNote: 'Cancelled ticket uses CANCEL',
    gross_weight: '0',
    tare_weight: '0',
    weightNote: 'Cancelled ticket uses 0 kg; tare and gross time are the same',
    weightWarning: '',
    timestamp_in: timestampIn,
    timestamp_out: timestampIn,
    timeWarnings: [],
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

function isCancelOperator(name) {
  return String(name || '').trim().toLowerCase() === 'cancel';
}

/**
 * Operator of the neighbouring slip closest in time to `timestampIn` on the same day.
 * Neighbours marked CANCEL are skipped; the other neighbour is used instead.
 */
function nearbyOperator(row, timestampIn) {
  const inMs = localMs(timestampIn);
  if (!row || !Number.isFinite(inMs)) return { operator_name: '', operatorNote: '' };
  const candidates = [row.prev, row.next]
    .filter((n) => n?.operator_name && n.timestamp_in && !isCancelOperator(n.operator_name))
    .map((n) => ({ ...n, at: new Date(n.timestamp_in).getTime() }))
    .filter((n) => Number.isFinite(n.at) && sameLocalDay(n.at, inMs))
    .sort((a, b) => Math.abs(a.at - inMs) - Math.abs(b.at - inMs));
  const hit = candidates[0];
  if (!hit) {
    return {
      operator_name: '',
      operatorNote: 'No neighbouring slip on the same day has a usable operator (cancel skipped); pick one',
    };
  }
  const name = String(hit.operator_name).trim();
  const match = OPERATORS.find((o) => o.toLowerCase() === name.toLowerCase());
  return {
    operator_name: match || name,
    operatorNote: `Operator from ${hit.slip_number} (same day, nearest in time)`,
  };
}

function operatorChoices(entry) {
  const extra = String(entry?.operator_name || '').trim();
  if (
    extra &&
    !isCancelOperator(extra) &&
    !OPERATORS.some((o) => o.toLowerCase() === extra.toLowerCase())
  ) {
    return [...OPERATORS, extra];
  }
  return OPERATORS;
}

/** Vehicles still free for this row (already-picked plates are hidden elsewhere). */
function vehicleChoices(rowId, entries, vehicles) {
  const taken = [];
  for (const [id, entry] of Object.entries(entries || {})) {
    if (id === rowId) continue;
    const truck = String(entry?.truck_number || '').trim();
    if (truck) taken.push(truck);
  }
  const current = String(entries?.[rowId]?.truck_number || '').trim();
  return vehicles
    .filter(
      (v) =>
        samePlate(v.truck_number, current) || !taken.some((t) => samePlate(t, v.truck_number)),
    )
    .map((v, i) => {
      const profile = fillVehicleProfile(v.kind);
      return {
        value: v.truck_number,
        kind: profile.kind,
        label: `${i + 1}. ${v.truck_number} · ${profile.kind}`,
      };
    });
}

function FillListsConfigModal({ open, vehicles, destinations, onClose, onSaved }) {
  const [draftVehicles, setDraftVehicles] = useState(vehicles);
  const [draftDestinations, setDraftDestinations] = useState(destinations);
  const [vehicleInput, setVehicleInput] = useState('');
  const [vehicleKind, setVehicleKind] = useState(FILL_KIND_RDF);
  const [vehicleDefaultTare, setVehicleDefaultTare] = useState('');
  const [vehicleNetMin, setVehicleNetMin] = useState('');
  const [vehicleNetMax, setVehicleNetMax] = useState('');
  const [destinationInput, setDestinationInput] = useState('');
  const [destinationKind, setDestinationKind] = useState(FILL_KIND_RDF);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setDraftVehicles(normalizeFillVehicles(vehicles));
    setDraftDestinations(normalizeFillDestinations(destinations));
    setVehicleInput('');
    setVehicleKind(FILL_KIND_RDF);
    setVehicleDefaultTare('');
    setVehicleNetMin('');
    setVehicleNetMax('');
    setDestinationInput('');
    setDestinationKind(FILL_KIND_RDF);
    setError('');
  }, [open, vehicles, destinations]);

  if (!open) return null;

  function addVehicle() {
    const plate = compactPlate(vehicleInput);
    if (!plate) return;
    if (!(Number(vehicleDefaultTare) > 0)) {
      setError('Enter a fixed tare (kg) for this vehicle');
      return;
    }
    if (vehicleKind === FILL_KIND_COMPOST) {
      if (!(Number(vehicleNetMin) > 0) || !(Number(vehicleNetMax) > 0)) {
        setError('Compost vehicles need net min and max (kg), e.g. 30000–33000');
        return;
      }
    }
    setError('');
    setDraftVehicles((prev) =>
      normalizeFillVehicles([
        ...prev,
        {
          truck_number: plate,
          kind: vehicleKind,
          default_tare: vehicleDefaultTare,
          net_min: vehicleNetMin,
          net_max: vehicleNetMax,
        },
      ]),
    );
    setVehicleInput('');
    setVehicleDefaultTare('');
    setVehicleNetMin('');
    setVehicleNetMax('');
  }

  function setVehicleItemKind(plate, kind) {
    const nextKind = normalizeFillKind(kind);
    setDraftVehicles((prev) =>
      prev.map((v) => {
        if (!samePlate(v.truck_number, plate)) return v;
        if (nextKind === FILL_KIND_COMPOST) {
          return {
            ...v,
            kind: nextKind,
            default_tare: v.default_tare || null,
            net_min: v.net_min || null,
            net_max: v.net_max || null,
          };
        }
        return {
          truck_number: v.truck_number,
          kind: nextKind,
          default_tare: v.default_tare || null,
        };
      }),
    );
  }

  function patchVehicle(plate, patch) {
    setDraftVehicles((prev) =>
      normalizeFillVehicles(
        prev.map((v) => (samePlate(v.truck_number, plate) ? { ...v, ...patch } : v)),
      ),
    );
  }

  function addDestination() {
    const name = String(destinationInput || '').trim();
    if (!name) return;
    setDraftDestinations((prev) =>
      normalizeFillDestinations([...prev, { name, kind: destinationKind }]),
    );
    setDestinationInput('');
  }

  function setDestinationItemKind(name, kind, prevKind) {
    setDraftDestinations((prev) =>
      normalizeFillDestinations(
        prev.map((d) =>
          d.name.toLowerCase() === String(name).toLowerCase() && d.kind === prevKind
            ? { ...d, kind: normalizeFillKind(kind) }
            : d,
        ),
      ),
    );
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const nextVehicles = normalizeFillVehicles(draftVehicles);
      const nextDestinations = normalizeFillDestinations(draftDestinations);
      if (!nextVehicles.length) throw new Error('Add at least one vehicle');
      if (!nextDestinations.length) throw new Error('Add at least one destination');
      for (const v of nextVehicles) {
        if (!(v.default_tare > 0)) {
          throw new Error(`Vehicle ${v.truck_number} needs a fixed tare (kg)`);
        }
        if (v.kind === FILL_KIND_COMPOST && (!(v.net_min > 0) || !(v.net_max > 0))) {
          throw new Error(
            `Compost vehicle ${v.truck_number} needs net min/max (kg)`,
          );
        }
      }
      const masterNames = fillDestinationNames(nextDestinations);
      await Promise.all([
        api.putList('fill_vehicles', nextVehicles),
        api.putList('fill_destinations', nextDestinations),
        api.putList('destinations', masterNames),
      ]);
      onSaved({ vehicles: nextVehicles, destinations: nextDestinations });
      onClose();
    } catch (err) {
      setError(err.message || 'Could not save configuration');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-6">
      <div className="card flex w-full max-w-6xl max-h-[95vh] flex-col overflow-hidden p-6 sm:p-8 space-y-5">
        <div className="flex shrink-0 items-start justify-between gap-4">
          <div>
            <h3 className="text-xl font-semibold sm:text-2xl">Fill configuration</h3>
            <p className="text-sm text-slate-400 mt-1 max-w-3xl">
              Tag vehicles and destinations as RDF or Compost. Every vehicle needs a fixed tare.
              Compost also needs a net weight range (min–max kg).
            </p>
          </div>
          <button type="button" className="btn-ghost shrink-0" onClick={onClose} disabled={saving}>
            Close
          </button>
        </div>

        {error && <p className="shrink-0 text-sm text-red-400">{error}</p>}

        <div className="grid min-h-0 flex-1 gap-5 overflow-hidden lg:grid-cols-2">
          <section className="flex min-h-0 flex-col space-y-3 overflow-hidden rounded-lg border border-slate-800 p-4 sm:p-5">
            <h4 className="shrink-0 text-base font-medium text-brand-300">Vehicles</h4>
            <div className="flex flex-wrap gap-2">
              <input
                className="field-input text-sm min-w-[10rem] flex-1"
                value={vehicleInput}
                placeholder="e.g. HR58E3515"
                onChange={(e) => setVehicleInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addVehicle();
                  }
                }}
              />
              <select
                className="field-input text-sm py-2 w-[9.5rem]"
                value={vehicleKind}
                onChange={(e) => setVehicleKind(normalizeFillKind(e.target.value))}
                title="Vehicle flow / material"
              >
                {FILL_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind === FILL_KIND_COMPOST ? 'Compost (HYWA)' : 'RDF (TRUCK)'}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-ghost shrink-0" onClick={addVehicle}>
                Add
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Fixed tare (kg)
                <input
                  type="number"
                  min={1}
                  className="field-input text-sm w-36"
                  value={vehicleDefaultTare}
                  placeholder="e.g. 12000"
                  onChange={(e) => setVehicleDefaultTare(e.target.value)}
                />
              </label>
              {vehicleKind === FILL_KIND_COMPOST && (
                <>
                  <label className="flex flex-col gap-1 text-xs text-slate-400">
                    Net min (kg)
                    <input
                      type="number"
                      min={1}
                      className="field-input text-sm w-36"
                      value={vehicleNetMin}
                      placeholder="e.g. 30000 (30t)"
                      onChange={(e) => setVehicleNetMin(e.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-slate-400">
                    Net max (kg)
                    <input
                      type="number"
                      min={1}
                      className="field-input text-sm w-36"
                      value={vehicleNetMax}
                      placeholder="e.g. 33000 (33t)"
                      onChange={(e) => setVehicleNetMax(e.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
            <p className="text-xs text-slate-500">
              RDF → fixed tare ±50–200 kg, gross 65,000–65,500. Compost → fixed tare ±30–70 kg; net
              random in min–max; gross = tare + net.
            </p>
            <ul className="min-h-0 flex-1 space-y-2 overflow-auto text-sm pr-1">
              {draftVehicles.map((item) => (
                <li
                  key={item.truck_number}
                  className="space-y-2 rounded-md bg-slate-900/70 px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono">{item.truck_number}</span>
                    <div className="flex items-center gap-2">
                      <select
                        className="field-input text-xs py-1 w-[8.5rem]"
                        value={normalizeFillKind(item.kind)}
                        onChange={(e) => setVehicleItemKind(item.truck_number, e.target.value)}
                      >
                        <option value={FILL_KIND_RDF}>RDF</option>
                        <option value={FILL_KIND_COMPOST}>Compost</option>
                      </select>
                      <button
                        type="button"
                        className="text-xs text-red-300 hover:text-red-200"
                        onClick={() =>
                          setDraftVehicles((prev) =>
                            prev.filter((v) => !samePlate(v.truck_number, item.truck_number)),
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                      Fixed tare
                      <input
                        type="number"
                        min={1}
                        className="field-input text-xs py-1 w-28"
                        value={item.default_tare ?? ''}
                        onChange={(e) =>
                          patchVehicle(item.truck_number, { default_tare: e.target.value })
                        }
                      />
                    </label>
                    {normalizeFillKind(item.kind) === FILL_KIND_COMPOST && (
                      <>
                        <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                          Net min
                          <input
                            type="number"
                            min={1}
                            className="field-input text-xs py-1 w-28"
                            value={item.net_min ?? ''}
                            onChange={(e) =>
                              patchVehicle(item.truck_number, { net_min: e.target.value })
                            }
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                          Net max
                          <input
                            type="number"
                            min={1}
                            className="field-input text-xs py-1 w-28"
                            value={item.net_max ?? ''}
                            onChange={(e) =>
                              patchVehicle(item.truck_number, { net_max: e.target.value })
                            }
                          />
                        </label>
                      </>
                    )}
                  </div>
                </li>
              ))}
              {!draftVehicles.length && (
                <li className="text-xs text-slate-500">No vehicles yet.</li>
              )}
            </ul>
          </section>

          <section className="flex min-h-0 flex-col space-y-3 overflow-hidden rounded-lg border border-slate-800 p-4 sm:p-5">
            <h4 className="shrink-0 text-base font-medium text-brand-300">Destinations</h4>
            <div className="flex flex-wrap gap-2">
              <input
                className="field-input text-sm min-w-[10rem] flex-1"
                value={destinationInput}
                placeholder="e.g. MUZAFFAR NAGAR"
                onChange={(e) => setDestinationInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addDestination();
                  }
                }}
              />
              <select
                className="field-input text-sm py-2 w-[9.5rem]"
                value={destinationKind}
                onChange={(e) => setDestinationKind(normalizeFillKind(e.target.value))}
              >
                {FILL_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind === FILL_KIND_COMPOST ? 'Compost' : 'RDF'}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-ghost shrink-0" onClick={addDestination}>
                Add
              </button>
            </div>
            <p className="shrink-0 text-xs text-slate-500">
              Destinations are filtered in the table by the selected vehicle&apos;s RDF/Compost kind.
            </p>
            <ul className="min-h-0 flex-1 space-y-2 overflow-auto text-sm pr-1">
              {draftDestinations.map((item) => (
                <li
                  key={`${item.name}|${item.kind}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-900/70 px-3 py-2.5"
                >
                  <span>{item.name}</span>
                  <div className="flex items-center gap-2">
                    <select
                      className="field-input text-xs py-1 w-[8.5rem]"
                      value={normalizeFillKind(item.kind)}
                      onChange={(e) =>
                        setDestinationItemKind(item.name, e.target.value, item.kind)
                      }
                    >
                      <option value={FILL_KIND_RDF}>RDF</option>
                      <option value={FILL_KIND_COMPOST}>Compost</option>
                    </select>
                    <button
                      type="button"
                      className="text-xs text-red-300 hover:text-red-200"
                      onClick={() =>
                        setDraftDestinations((prev) =>
                          prev.filter(
                            (d) =>
                              !(
                                d.name.toLowerCase() === item.name.toLowerCase() &&
                                d.kind === item.kind
                              ),
                          ),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
              {!draftDestinations.length && (
                <li className="text-xs text-slate-500">No destinations yet.</li>
              )}
            </ul>
          </section>
        </div>

        <div className="flex shrink-0 justify-end gap-3 border-t border-slate-800 pt-4">
          <button type="button" className="btn-ghost px-5" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn-primary px-6" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function defaultDestinationForKind(destinations, kind) {
  const match = destinationsForKind(destinations, kind);
  if (match.length) return match[0].name;
  if (normalizeFillKind(kind) === FILL_KIND_RDF) return DEFAULT_DESTINATION;
  return '';
}

function destinationChoices(destinations, kind, current) {
  const opts = destinationsForKind(destinations, kind).map((d) => d.name);
  const cur = String(current || '').trim();
  if (cur && !opts.some((name) => name.toLowerCase() === cur.toLowerCase())) {
    opts.unshift(cur);
  }
  return opts;
}

/** Re-pick the operator from neighbours unless the user chose one by hand. */
function withAutoOperator(entry, row) {
  if (isCancelled(entry)) return asCancelled(entry);
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

function weightPatch(history, truck, timestampIn, vehicles = []) {
  if (!truck) return { weightNote: '', weightWarning: '' };
  const configured = lookupFillVehicle(vehicles, truck);
  const kind = fillVehicleProfile(configured?.kind).kind;
  const w = generateFillWeights(history || [], truck, localMs(timestampIn), Math.random, {
    kind,
    defaultTare: configured?.default_tare,
    netMin: configured?.net_min,
    netMax: configured?.net_max,
  });
  return {
    gross_weight: w.gross == null ? '' : String(w.gross),
    tare_weight: w.tare == null ? '' : String(w.tare),
    weightNote: w.source,
    weightWarning: w.warning,
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
  if (!isCancelled(entry)) {
    if (!entry.truck_number) errors.push('Pick a vehicle');
    if (!String(entry.destination || '').trim()) errors.push('Pick a destination');
    if (!entry.operator_name) errors.push('Pick an operator');
    else if (isCancelOperator(entry.operator_name)) errors.push('Cancel is not allowed as operator');
    const gross = Number(entry.gross_weight);
    const tare = Number(entry.tare_weight);
    if (!entry.gross_weight || !(gross > 0)) errors.push('Enter gross weight');
    if (!entry.tare_weight || !(tare > 0)) errors.push('Enter tare weight');
    if (gross > 0 && tare > 0 && gross <= tare) errors.push('Gross must be greater than tare');
  }
  const inMs = localMs(entry.timestamp_in);
  const outMs = localMs(entry.timestamp_out);
  if (!Number.isFinite(inMs)) errors.push('In time needs date and HH:mm:ss');
  if (!isCancelled(entry) && !Number.isFinite(outMs)) errors.push('Out time needs date and HH:mm:ss');
  if (!isCancelled(entry) && Number.isFinite(inMs) && Number.isFinite(outMs) && outMs <= inMs) {
    errors.push('Out time must be after in time');
  }
  return errors;
}

/** Same vehicle on two selected slips whose in-to-out windows overlap. */
function overlapErrors(rows, entries) {
  const byId = {};
  const picked = rows
    .map((row) => ({ row, entry: entries[row.id] }))
    .filter(({ entry }) => entry?.selected && entry.truck_number && !isCancelled(entry))
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

function neighborEvents(row) {
  const events = [];
  for (const side of [row.prev, row.next]) {
    if (!side) continue;
    const slip = side.slip_number || 'neighbour';
    const inAt = new Date(side.timestamp_in || '').getTime();
    if (Number.isFinite(inAt)) events.push({ slip, label: 'in', at: inAt });
    const outAt = new Date(side.timestamp_out || '').getTime();
    if (Number.isFinite(outAt)) events.push({ slip, label: 'out', at: outAt });
  }
  return events;
}

/**
 * In/out of selected fills must stay more than 1 minute from each other and
 * from neighbouring real slips' in/out times.
 */
function timeCollisionErrors(rows, entries) {
  const byId = {};
  const selected = rows
    .map((row) => ({ row, entry: entries[row.id] }))
    .filter(({ entry }) => entry?.selected)
    .map(({ row, entry }) => ({
      id: row.id,
      slip: row.slip_number,
      row,
      events: [
        { label: 'in', at: localMs(entry.timestamp_in) },
        { label: 'out', at: localMs(entry.timestamp_out) },
      ].filter((e) => Number.isFinite(e.at)),
    }));

  for (const item of selected) {
    for (const ev of item.events) {
      for (const n of neighborEvents(item.row)) {
        if (!timesCollide(ev.at, n.at)) continue;
        (byId[item.id] ||= []).push(
          `${ev.label} time collides with ${n.slip} ${n.label} (need >1 min apart)`,
        );
      }
    }
  }

  for (let i = 0; i < selected.length; i += 1) {
    for (let j = i + 1; j < selected.length; j += 1) {
      const a = selected[i];
      const b = selected[j];
      for (const ae of a.events) {
        for (const be of b.events) {
          if (!timesCollide(ae.at, be.at)) continue;
          (byId[a.id] ||= []).push(
            `${ae.label} time collides with ${b.slip} ${be.label} (need >1 min apart)`,
          );
          (byId[b.id] ||= []).push(
            `${be.label} time collides with ${a.slip} ${ae.label} (need >1 min apart)`,
          );
        }
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
  const [configOpen, setConfigOpen] = useState(false);
  const [exportPeriod, setExportPeriod] = useState('today');
  const [exportCustomDate, setExportCustomDate] = useState(ymd());
  const [exportBusy, setExportBusy] = useState(false);

  function activeExportRange() {
    if (exportPeriod === 'custom') return customDateToRange(exportCustomDate);
    return periodToRange(exportPeriod);
  }

  const vehicles = useMemo(() => {
    const saved = normalizeFillVehicles(lists?.fill_vehicles || []);
    return saved.length ? saved : defaultFillVehicles();
  }, [lists]);

  const destinations = useMemo(() => {
    const saved = normalizeFillDestinations(lists?.fill_destinations || []);
    if (saved.length) return saved;
    // Migrate plain master destinations as RDF until configured.
    const legacy = normalizeFillDestinations(
      (lists?.destinations || []).map((name) => ({ name, kind: FILL_KIND_RDF })),
    );
    return legacy.length ? legacy : defaultFillDestinations();
  }, [lists]);

  const vehiclePlates = useMemo(() => fillVehiclePlates(vehicles), [vehicles]);

  const loadLists = useCallback(async () => {
    try {
      const names = [
        ...SAVED_LIST_CHECKS.map(({ list }) => list),
        'destinations',
        'fill_vehicles',
        'fill_destinations',
      ];
      const res = await Promise.all(names.map((list) => api.getList(list)));
      const out = {};
      names.forEach((list, i) => {
        out[list] = res[i].items || [];
      });
      setLists(out);
    } catch {
      setLists(null);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const range =
        exportPeriod === 'custom'
          ? customDateToRange(exportCustomDate)
          : periodToRange(exportPeriod);
      if (exportPeriod === 'custom' && !range) {
        throw new Error('Choose a valid custom date');
      }
      const data = await api.getHeldSlipWindows(range || {});
      const fresh = data.rows || [];
      setRows(fresh);
      setEntries((prev) => {
        const kept = {};
        for (const row of fresh) {
          const prior = prev[row.id] || emptyEntry();
          kept[row.id] = {
            ...emptyEntry(),
            ...prior,
            destination: prior.destination || DEFAULT_DESTINATION,
          };
        }
        const needTimes = fresh.filter((row) => !kept[row.id].timestamp_in).map((r) => r.id);
        return applyTimes(
          kept,
          generateFillTimes(fresh, needTimes, { existing: kept }),
          fresh,
        );
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [exportPeriod, exportCustomDate]);

  useEffect(() => {
    load();
  }, [load]);

  async function downloadExcel() {
    const range = activeExportRange();
    if (exportPeriod === 'custom' && !range) {
      setError('Choose a valid custom date to download Excel');
      return;
    }
    setExportBusy(true);
    setError('');
    try {
      // Same closed-ticket Excel layout as the weighbridge machine export.
      const blob = await api.downloadExport('/reports/export/excel', {
        ...(range || {}),
        ticket_status: 'CLOSED',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp =
        exportPeriod === 'custom' && exportCustomDate
          ? exportCustomDate
          : exportPeriod;
      a.download = `weighbridge-report-${stamp}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'Excel download failed');
    } finally {
      setExportBusy(false);
    }
  }

  useEffect(() => {
    loadLists();
  }, [loadLists]);

  useEffect(() => {
    if (!rows.length || !vehiclePlates.length) {
      setTareHistory([]);
      return;
    }
    let cancelled = false;
    api
      .getVehicleTares(vehiclePlates, tareHistorySince(rows))
      .then((res) => {
        if (!cancelled) setTareHistory(res.rows || []);
      })
      .catch((err) => {
        if (cancelled) return;
        setTareHistory([]);
        setError(`Could not load vehicle tare history: ${err.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [rows, vehiclePlates]);

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
    const savedDest = (lists.destinations || []).map((v) => String(v).trim().toLowerCase());
    if (savedDest.length) {
      const seen = new Set();
      for (const row of rows) {
        const entry = entries[row.id];
        if (!entry?.selected || isCancelled(entry)) continue;
        const dest = String(entry.destination || '').trim();
        if (!dest) continue;
        const key = dest.toLowerCase();
        if (seen.has(key) || savedDest.includes(key)) continue;
        seen.add(key);
        missing.push(`destination "${dest}"`);
      }
    }
    return missing;
  }, [lists, rows, entries]);

  const overlaps = useMemo(() => overlapErrors(rows, entries), [rows, entries]);
  const collisions = useMemo(() => timeCollisionErrors(rows, entries), [rows, entries]);
  const selectedRows = rows.filter((row) => entries[row.id]?.selected);
  const problems = useMemo(() => {
    const out = {};
    for (const row of rows) {
      const entry = entries[row.id];
      if (!entry?.selected) continue;
      const errs = [
        ...rowErrors(entry),
        ...(overlaps[row.id] || []),
        ...(collisions[row.id] || []),
      ];
      if (errs.length) out[row.id] = errs;
    }
    return out;
  }, [rows, entries, overlaps, collisions]);
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
      if (isCancelled(entry)) {
        return { ...prev, [id]: { ...entry, truck_number: truck } };
      }
      const kind = lookupFillVehicle(vehicles, truck)?.kind || FILL_KIND_RDF;
      const allowed = destinationsForKind(destinations, kind);
      const current = String(entry.destination || '').trim();
      const stillValid = allowed.some((d) => d.name.toLowerCase() === current.toLowerCase());
      return {
        ...prev,
        [id]: {
          ...entry,
          truck_number: truck,
          destination: stillValid ? current : defaultDestinationForKind(destinations, kind),
          ...weightPatch(tareHistory, truck, entry.timestamp_in, vehicles),
        },
      };
    });
    setResult(null);
  }

  function regenerate() {
    const ids = selectedRows.length ? selectedRows.map((r) => r.id) : rows.map((r) => r.id);
    setEntries((prev) =>
      applyTimes(prev, generateFillTimes(rows, ids, { existing: prev }), rows),
    );
    setResult(null);
  }

  function regenerateWeights() {
    setEntries((prev) => {
      const next = { ...prev };
      for (const row of selectedRows) {
        const entry = next[row.id];
        if (!entry?.truck_number || isCancelled(entry)) continue;
        next[row.id] = {
          ...entry,
          ...weightPatch(tareHistory, entry.truck_number, entry.timestamp_in, vehicles),
        };
      }
      return next;
    });
    setResult(null);
  }

  function setTicketStatus(row, status) {
    setEntries((prev) => {
      const entry = prev[row.id] || emptyEntry();
      if (status === 'CANCELLED') {
        return { ...prev, [row.id]: asCancelled(entry) };
      }
      const restored = {
        ...entry,
        ticket_status: 'CLOSED',
        operator_name: entry.operator_name === CANCEL_LABEL ? '' : entry.operator_name,
        operatorAuto: entry.operator_name === CANCEL_LABEL || entry.operatorAuto,
        operatorNote: '',
        gross_weight: entry.gross_weight === '0' ? '' : entry.gross_weight,
        tare_weight: entry.tare_weight === '0' ? '' : entry.tare_weight,
        weightNote: '',
        weightWarning: '',
      };
      let next = withAutoOperator(restored, row);
      if (next.timestamp_in && next.timestamp_out === next.timestamp_in) {
        const generated = generateFillTimes(rows, [row.id]);
        next = applyTimes({ [row.id]: next }, generated, rows)[row.id];
      }
      return { ...prev, [row.id]: next };
    });
    setResult(null);
  }

  function markSelectedCancelled() {
    if (!selectedRows.length) return;
    setEntries((prev) => {
      const next = { ...prev };
      for (const row of selectedRows) {
        next[row.id] = asCancelled(next[row.id] || emptyEntry());
      }
      return next;
    });
    setResult(null);
  }

  function buildTrips() {
    return selectedRows.map((row) => {
      const entry = entries[row.id];
      const cancelled = isCancelled(entry);
      const configured = lookupFillVehicle(vehicles, entry.truck_number);
      const profile = fillVehicleProfile(configured?.kind);
      return {
        ...(cancelled
          ? CANCELLED_FIXED
          : {
              ...FIXED,
              destination: String(entry.destination || '').trim(),
              material: profile.material,
              vehicle_type: profile.vehicle_type,
            }),
        reservation_id: row.id,
        slip_number: row.slip_number,
        truck_number: cancelled ? entry.truck_number || CANCEL_LABEL : entry.truck_number,
        operator_name: cancelled ? CANCEL_LABEL : entry.operator_name,
        gross_weight: cancelled ? 0 : Number(entry.gross_weight),
        tare_weight: cancelled ? 0 : Number(entry.tare_weight),
        timestamp_in: new Date(entry.timestamp_in).toISOString(),
        timestamp_out: new Date(cancelled ? entry.timestamp_in : entry.timestamp_out).toISOString(),
      };
    });
  }

  async function run(dryRun) {
    if (blocked) return;
    const trips = buildTrips();
    const cancelledCount = trips.filter((t) => t.ticket_status === 'CANCELLED').length;
    const closedCount = trips.length - cancelledCount;
    const confirmParts = [
      closedCount ? `${closedCount} closed` : null,
      cancelledCount ? `${cancelledCount} cancelled` : null,
    ].filter(Boolean);
    if (
      !dryRun &&
      !window.confirm(
        `Create ${trips.length} remote trip(s) on the selected blocked slips (${confirmParts.join(', ')})?`,
      )
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

  function handleConfigSaved({ vehicles: nextVehicles, destinations: nextDestinations }) {
    const typedVehicles = normalizeFillVehicles(nextVehicles);
    const typedDestinations = normalizeFillDestinations(nextDestinations);
    const destNames = fillDestinationNames(typedDestinations);
    setLists((prev) => ({
      ...(prev || {}),
      fill_vehicles: typedVehicles,
      fill_destinations: typedDestinations,
      destinations: destNames,
    }));
    setEntries((prev) => {
      const next = { ...prev };
      for (const [id, entry] of Object.entries(next)) {
        let patch = { ...entry };
        if (
          entry?.truck_number &&
          !typedVehicles.some((v) => samePlate(v.truck_number, entry.truck_number))
        ) {
          patch = {
            ...patch,
            truck_number: '',
            destination: defaultDestinationForKind(typedDestinations, FILL_KIND_RDF),
            gross_weight: '',
            tare_weight: '',
            weightNote: '',
            weightWarning: '',
          };
        } else {
          const kind =
            lookupFillVehicle(typedVehicles, entry?.truck_number)?.kind || FILL_KIND_RDF;
          const allowed = destinationsForKind(typedDestinations, kind);
          const current = String(entry?.destination || '').trim();
          const stillValid = allowed.some((d) => d.name.toLowerCase() === current.toLowerCase());
          if (!stillValid) {
            patch.destination = defaultDestinationForKind(typedDestinations, kind);
          }
        }
        next[id] = patch;
      }
      return next;
    });
  }

  return (
    <div className="space-y-6 w-full">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Fill blocked slips</h2>
          <p className="text-sm text-slate-400 mt-1">
            Pick the blocked slips to fill and choose a vehicle, destination, and operator for each
            closed ticket. Vehicle kind (RDF or Compost) sets material and report flow: RDF = TRUCK
            tare-first; Compost = HYWA gross-first. Set Ticket to Cancelled to fill a void slip
            (CANCEL / 0 kg, same tare and gross time). Tare/gross weights are generated the same way;
            only labels and report mapping change. The 1st weigh is placed between neighbouring in
            times; the 2nd weigh is 1 h 45 m to 2 h 30 m later.{' '}
            <Link to="/plan-gaps" className="text-brand-300 hover:underline">
              Back to Plan Gaps
            </Link>
            {' · '}
            <Link to="/bulk-photos" className="text-brand-300 hover:underline">
              Bulk vehicle photos
            </Link>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-ghost shrink-0" onClick={() => setConfigOpen(true)}>
            Configure vehicles & destinations
          </button>
          <button
            type="button"
            className="btn-primary shrink-0"
            onClick={downloadExcel}
            disabled={exportBusy}
          >
            {exportBusy ? 'Downloading…' : 'Download Excel'}
          </button>
        </div>
      </div>

      <div className="rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Date filter
          <select
            className="field-input text-sm py-1.5 min-w-[9rem]"
            value={exportPeriod}
            onChange={(e) => setExportPeriod(e.target.value)}
          >
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="custom">Custom date</option>
          </select>
        </label>
        {exportPeriod === 'custom' && (
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Day
            <input
              type="date"
              className="field-input text-sm py-1.5"
              value={exportCustomDate}
              onChange={(e) => setExportCustomDate(e.target.value)}
            />
          </label>
        )}
        <p className="text-xs text-slate-500 pb-1.5">
          List filters blocked slips by blocked/planned time. Excel downloads closed tickets for
          that day in the same format as the weighbridge machine.
        </p>
      </div>

      <FillListsConfigModal
        open={configOpen}
        vehicles={vehicles}
        destinations={destinations}
        onClose={() => setConfigOpen(false)}
        onSaved={handleConfigSaved}
      />

      <div className="rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm flex flex-wrap items-center gap-x-6 gap-y-2">
        <span>
          <span className="text-slate-400">Material</span>{' '}
          <span className="font-medium text-white">by vehicle (RDF / COMPOST)</span>
        </span>
        <span>
          <span className="text-slate-400">Customer</span>{' '}
          <span className="font-medium text-white">{FIXED.customer_name}</span>
        </span>
        <span>
          <span className="text-slate-400">Destination</span>{' '}
          <span className="font-medium text-white">per slip in table</span>
        </span>
        <span>
          <span className="text-slate-400">Vehicle type</span>{' '}
          <span className="font-medium text-white">by vehicle (TRUCK / HYWA)</span>
        </span>
        <span>
          <span className="text-slate-400">Ticket</span>{' '}
          <span className="font-medium text-white">Closed or Cancelled</span>
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
          disabled={
            !selectedRows.some((row) => entries[row.id]?.truck_number && !isCancelled(entries[row.id])) ||
            !tareHistory
          }
          title="Re-roll tare and gross for selected closed rows that have a vehicle"
        >
          {tareHistory ? 'Regenerate weights' : 'Loading tare history…'}
        </button>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={markSelectedCancelled}
          disabled={!selectedRows.length}
          title="Fill selected slips as cancelled tickets (CANCEL / 0 kg)"
        >
          Mark selected cancelled
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
              <th className="p-2">Ticket</th>
              <th className="p-2">Between</th>
              <th className="p-2">Vehicle</th>
              <th className="p-2">Destination</th>
              <th className="p-2">Operator</th>
              <th className="p-2">Gross kg</th>
              <th className="p-2">Tare kg</th>
              <th className="p-2">In (1st weigh)</th>
              <th className="p-2">Out (2nd weigh)</th>
              <th className="p-2">Net</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const entry = entries[row.id] || emptyEntry();
              const cancelled = isCancelled(entry);
              const profile = fillVehicleProfile(
                lookupFillVehicle(vehicles, entry.truck_number)?.kind,
              );
              const errs = problems[row.id] || [];
              const net = cancelled
                ? 0
                : Number(entry.gross_weight) > 0 && Number(entry.tare_weight) > 0
                  ? Number(entry.gross_weight) - Number(entry.tare_weight)
                  : null;
              const hasNotes =
                errs.length > 0 ||
                entry.timeWarnings.length > 0 ||
                Boolean(entry.weightNote || entry.weightWarning || entry.operatorNote) ||
                Boolean(entry.truck_number && !cancelled);
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
                    <td className="p-2">
                      <select
                        className="field-input text-xs py-1 min-w-[7.5rem]"
                        value={cancelled ? 'CANCELLED' : 'CLOSED'}
                        onChange={(e) => setTicketStatus(row, e.target.value)}
                        aria-label={`Ticket type for ${row.slip_number}`}
                      >
                        <option value="CLOSED">Closed</option>
                        <option value="CANCELLED">Cancelled</option>
                      </select>
                    </td>
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
                        className="field-input text-xs py-1 min-w-[10rem]"
                        value={entry.truck_number}
                        onChange={(e) => pickVehicle(row.id, e.target.value)}
                      >
                        <option value="">{cancelled ? 'CANCEL' : 'Select…'}</option>
                        {vehicleChoices(row.id, entries, vehicles).map((v) => (
                          <option key={v.value} value={v.value}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-2">
                      <select
                        className="field-input text-xs py-1 min-w-[10rem]"
                        value={entry.destination || ''}
                        onChange={(e) => update(row.id, { destination: e.target.value })}
                        disabled={cancelled || !entry.truck_number}
                        title={
                          entry.truck_number
                            ? `${profile.kind} destinations`
                            : 'Select a vehicle first'
                        }
                      >
                        <option value="">
                          {cancelled
                            ? 'CANCEL'
                            : entry.truck_number
                              ? 'Select…'
                              : 'Pick vehicle first'}
                        </option>
                        {destinationChoices(
                          destinations,
                          profile.kind,
                          entry.destination,
                        ).map((name) => (
                          <option key={name} value={name}>
                            {name}
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
                        disabled={cancelled}
                      >
                        <option value="">Select…</option>
                        {operatorChoices(entry).map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-2">
                      <input
                        type="number"
                        min={cancelled ? 0 : 1}
                        className="field-input text-xs py-1 w-24"
                        value={entry.gross_weight}
                        onChange={(e) => update(row.id, { gross_weight: e.target.value })}
                        disabled={cancelled}
                      />
                    </td>
                    <td className="p-2">
                      <input
                        type="number"
                        min={cancelled ? 0 : 1}
                        className="field-input text-xs py-1 w-24"
                        value={entry.tare_weight}
                        onChange={(e) => update(row.id, { tare_weight: e.target.value })}
                        disabled={cancelled}
                      />
                    </td>
                    <td className="p-2">
                      <input
                        type="datetime-local"
                        step={1}
                        className="field-input text-xs py-1"
                        value={entry.timestamp_in}
                        onChange={(e) => updateInTime(row, e.target.value)}
                        title={profile.inLabel}
                      />
                      {entry.truck_number && !cancelled && (
                        <div className="mt-0.5 text-[10px] text-slate-500">{profile.inLabel}</div>
                      )}
                    </td>
                    <td className="p-2">
                      <input
                        type="datetime-local"
                        step={1}
                        className="field-input text-xs py-1"
                        value={entry.timestamp_out}
                        onChange={(e) => update(row.id, { timestamp_out: e.target.value })}
                        disabled={cancelled}
                        title={
                          cancelled
                            ? 'Cancelled tickets use the same tare and gross time'
                            : profile.outLabel
                        }
                      />
                      {entry.truck_number && !cancelled && (
                        <div className="mt-0.5 text-[10px] text-slate-500">{profile.outLabel}</div>
                      )}
                    </td>
                    <td className="p-2 text-xs whitespace-nowrap">{fmtKg(net)}</td>
                  </tr>
                  {hasNotes && (
                    <tr className="border-b border-slate-800/60">
                      <td />
                      <td colSpan={11} className="px-2 pb-2 text-xs space-y-0.5">
                        {entry.truck_number && !cancelled && (
                          <p className="text-slate-500">
                            {profile.kind} · material {profile.material} · {profile.flowNote}
                          </p>
                        )}
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
                <td colSpan={11} className="p-6 text-center text-slate-500">
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
