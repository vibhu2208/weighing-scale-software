import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import Badge from '../components/Badge.jsx';
import { fmtDate, fmtKg, toDatetimeLocalValue } from '../lib/format.js';

const PHOTO_SLOTS = [1, 2, 3];
const HOUR_MS = 60 * 60 * 1000;

function isHywa(vehicleType) {
  return String(vehicleType || '')
    .trim()
    .toLowerCase() === 'hywa';
}

function isOpenTicket(status) {
  return String(status || '').toUpperCase() === 'OPEN';
}

function photoPassesFor(vehicleType, ticketStatus) {
  const arrival = isHywa(vehicleType)
    ? { pass: 'arrival', title: 'Gross (1st weigh) photos' }
    : { pass: 'arrival', title: 'Arrival (tare) photos' };
  if (isOpenTicket(ticketStatus)) return [arrival];
  if (isHywa(vehicleType)) {
    return [arrival, { pass: 'departure', title: 'Tare (2nd weigh / close) photos' }];
  }
  return [arrival, { pass: 'departure', title: 'Departure (gross) photos' }];
}

function photoKey(pass, slot) {
  return `${pass}:${slot}`;
}

function defaultDatetimeLocal(offsetMs = 0) {
  const d = new Date(Date.now() + offsetMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function splitDatetimeLocal(value) {
  const raw = String(value || '');
  const [datePart = '', timePart = ''] = raw.split('T');
  let time = timePart;
  if (/^\d{2}:\d{2}$/.test(time)) time = `${time}:00`;
  else if (time.length > 8) time = time.slice(0, 8);
  return { date: datePart, time };
}

function joinDatetimeLocal(date, time) {
  if (!date) return '';
  return `${date}T${String(time || '').trim()}`;
}

function isCompleteDatetimeLocal(value) {
  return /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(String(value || ''));
}

const ALLOWED_VEHICLE_TYPES = ['HYWA', 'TRUCK', 'TANKER', 'CONTAINER'];
const PLATE_RE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{3,4}$/;
const SLIP_RE = /^WB[0-9]+$/;
const MAX_WEIGHT_KG = 200000;

function compactToken(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

function listLabel(name) {
  return (
    {
      materials: 'material',
      customers: 'customer',
      destinations: 'destination',
      operators: 'operator',
    }[name] || name
  );
}

function matchingListNames(value, lists) {
  const norm = String(value || '').trim().toLowerCase();
  if (!norm) return [];
  return Object.entries(lists || {})
    .filter(([, items]) =>
      (items || []).some((item) => String(item).trim().toLowerCase() === norm),
    )
    .map(([name]) => name);
}

function looksLikeWeightText(value) {
  const text = String(value || '')
    .trim()
    .replace(/,/g, '');
  if (!/^\d+(\.\d+)?(\s*kg)?$/i.test(text)) return false;
  const n = Number(text.replace(/\s*kg/i, ''));
  return Number.isFinite(n) && n > 0 && n <= MAX_WEIGHT_KG;
}

function readWeightKg(value, fieldName, errors, key) {
  if (value === null || value === undefined || String(value).trim() === '') {
    errors[key] = `${fieldName} is required`;
    return;
  }
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_WEIGHT_KG) {
    errors[key] = `${fieldName} must be a weight from 1 to ${MAX_WEIGHT_KG} kg`;
  }
}

function readMaster(raw, fieldName, listName, lists, errors, key) {
  const text = String(raw || '').trim();
  if (!text) {
    errors[key] = `${fieldName} is required`;
    return;
  }
  if (
    looksLikeWeightText(text) ||
    SLIP_RE.test(compactToken(text)) ||
    PLATE_RE.test(compactToken(text))
  ) {
    errors[key] = `${fieldName} must be a ${listLabel(listName)}, not a weight, slip, or vehicle number`;
    return;
  }
  const items = (lists && lists[listName]) || [];
  const hits = matchingListNames(text, lists);
  const foreign = hits.filter((name) => name !== listName);
  if (items.length && !hits.includes(listName)) {
    const extra = foreign.length
      ? ` That value is a saved ${foreign.map(listLabel).join(' / ')}.`
      : ' Choose one from the saved list.';
    errors[key] = `${fieldName} must match a saved ${listLabel(listName)}.${extra}`;
    return;
  }
  if (!items.length && foreign.length) {
    errors[key] = `${fieldName} is a saved ${foreign.map(listLabel).join(' / ')}, not a ${listLabel(listName)}`;
  }
}

/** Values that will actually be stored. Open tickets keep only the first weigh. */
function submittedBody(form) {
  const open = isOpenTicket(form.ticket_status);
  const hywa = isHywa(form.vehicle_type);
  return {
    ...form,
    tare_weight: open && hywa ? '' : form.tare_weight,
    gross_weight: open && !hywa ? '' : form.gross_weight,
    timestamp_out: open ? '' : form.timestamp_out,
  };
}

/**
 * Same rules as admin-api remoteTripService.validateRemoteTripFields.
 * Each field must carry a plate, a kg weight, a weigh time, or its own saved list.
 */
function validateRemoteTripFields(body = {}, lists = {}) {
  const errors = {};
  const openStatus = String(body.ticket_status || 'CLOSED').trim().toUpperCase();
  if (openStatus !== 'OPEN' && openStatus !== 'CLOSED') {
    errors.ticket_status = 'Ticket must be Open or Closed';
  }
  const open = openStatus === 'OPEN';
  const vehicleType = String(body.vehicle_type || '').trim().toUpperCase();
  if (!ALLOWED_VEHICLE_TYPES.includes(vehicleType)) {
    errors.vehicle_type = 'Vehicle type must be HYWA, TRUCK, TANKER, or CONTAINER';
  }
  const hywa = vehicleType === 'HYWA';

  const slip = compactToken(body.slip_number);
  if (slip && !SLIP_RE.test(slip)) {
    errors.slip_number = 'Slip number must look like WB1234';
  }

  const plate = compactToken(body.truck_number);
  if (!plate) {
    errors.truck_number = 'Vehicle number is required';
  } else if (!PLATE_RE.test(plate)) {
    errors.truck_number = 'Vehicle number must be a registration (e.g. HR38AH6118)';
  } else if (
    matchingListNames(plate, lists).length ||
    matchingListNames(body.truck_number, lists).length
  ) {
    errors.truck_number = 'Vehicle number matches a material, customer, destination, or operator';
  }

  if (open && hywa) {
    readWeightKg(body.gross_weight, 'Gross weight', errors, 'gross_weight');
  } else if (open) {
    readWeightKg(body.tare_weight, 'Tare weight', errors, 'tare_weight');
  } else {
    readWeightKg(body.gross_weight, 'Gross weight', errors, 'gross_weight');
    readWeightKg(body.tare_weight, 'Tare weight', errors, 'tare_weight');
    const gross = Math.round(Number(body.gross_weight));
    const tare = Math.round(Number(body.tare_weight));
    if (
      !errors.gross_weight &&
      !errors.tare_weight &&
      Number.isFinite(gross) &&
      Number.isFinite(tare) &&
      gross <= tare
    ) {
      errors.gross_weight = 'Gross weight must be greater than tare weight';
    }
  }

  const inLabel = hywa ? 'Gross time' : 'Arrival time';
  if (!isCompleteDatetimeLocal(body.timestamp_in)) {
    errors.timestamp_in = `${inLabel} must be a date and 24-hour time (HH:mm:ss)`;
  }
  if (!open) {
    const outLabel = hywa ? 'Tare time' : 'Close time';
    if (!isCompleteDatetimeLocal(body.timestamp_out)) {
      errors.timestamp_out = `${outLabel} must be a date and 24-hour time (HH:mm:ss)`;
    } else if (
      !errors.timestamp_in &&
      new Date(body.timestamp_out).getTime() < new Date(body.timestamp_in).getTime()
    ) {
      errors.timestamp_out = `${outLabel} must be after ${inLabel.toLowerCase()}`;
    }
  }

  const rfid = String(body.rfid_tag || '').trim();
  if (rfid) {
    if (!/^[A-Za-z0-9:_-]{4,64}$/.test(rfid)) {
      errors.rfid_tag = 'RFID tag must be the tag id (letters, numbers, _ or -)';
    } else if (looksLikeWeightText(rfid)) {
      errors.rfid_tag = 'RFID tag looks like a weight';
    } else if (matchingListNames(rfid, lists).length) {
      errors.rfid_tag = 'RFID tag matches a material, customer, destination, or operator';
    } else if (PLATE_RE.test(compactToken(rfid)) && compactToken(rfid) !== plate) {
      errors.rfid_tag = 'RFID tag looks like a vehicle number';
    }
  }

  const transporter = String(body.transporter || '').trim();
  if (transporter) {
    if (looksLikeWeightText(transporter) || SLIP_RE.test(compactToken(transporter))) {
      errors.transporter = 'Transporter must be a name, not a weight or slip number';
    } else if (PLATE_RE.test(compactToken(transporter))) {
      errors.transporter = 'Transporter looks like a vehicle number';
    } else if (transporter.length < 2) {
      errors.transporter = 'Transporter must be a name';
    }
  }

  readMaster(body.material, 'Material', 'materials', lists, errors, 'material');
  readMaster(body.customer_name, 'Customer', 'customers', lists, errors, 'customer_name');
  readMaster(body.destination, 'Destination', 'destinations', lists, errors, 'destination');
  readMaster(body.operator_name, 'Operator', 'operators', lists, errors, 'operator_name');
  return errors;
}

function fieldRole(key, form, lists, listsReady) {
  const hywa = isHywa(form.vehicle_type);
  const open = isOpenTicket(form.ticket_status);
  if (key === 'truck_number') return 'vehicle registration';
  if (key === 'vehicle_type') return 'HYWA, truck, tanker, or container';
  if (key === 'slip_number') return 'WB slip, or blank to assign one';
  if (key === 'ticket_status') return 'open or closed ticket';
  if (key === 'rfid_tag') return 'tag id, or blank';
  if (key === 'transporter') return 'transporter name, or blank';
  if (key === 'gross_weight') {
    if (open && !hywa) return 'not stored — this open ticket keeps tare only';
    return hywa ? 'loaded weight in kg (1st weigh)' : 'loaded weight in kg (2nd weigh)';
  }
  if (key === 'tare_weight') {
    if (open && hywa) return 'not stored — this open ticket keeps gross only';
    return hywa ? 'empty weight in kg (2nd weigh)' : 'empty weight in kg (1st weigh)';
  }
  if (key === 'timestamp_in') return hywa ? 'gross time (1st weigh)' : 'arrival / tare time';
  if (key === 'timestamp_out') {
    if (open) return 'not stored — open tickets have no close time';
    return hywa ? 'tare time (2nd weigh)' : 'close / gross time';
  }
  const listName = {
    material: 'materials',
    customer_name: 'customers',
    destination: 'destinations',
    operator_name: 'operators',
  }[key];
  const noun = listLabel(listName);
  if (listsReady && !(lists[listName] || []).length) return `${noun} name`;
  return `saved ${noun}`;
}

const CHECK_FIELDS = [
  ['ticket_status', 'Ticket'],
  ['slip_number', 'Slip'],
  ['truck_number', 'Vehicle number'],
  ['vehicle_type', 'Vehicle type'],
  ['gross_weight', 'Gross weight'],
  ['tare_weight', 'Tare weight'],
  ['timestamp_in', 'First weigh time'],
  ['timestamp_out', 'Second weigh time'],
  ['material', 'Material'],
  ['customer_name', 'Customer'],
  ['destination', 'Destination'],
  ['operator_name', 'Operator'],
  ['rfid_tag', 'RFID'],
  ['transporter', 'Transporter'],
];

function displayFieldValue(key, body) {
  const value = body[key];
  if (key === 'ticket_status') return isOpenTicket(value) ? 'Open' : 'Closed';
  if (value === null || value === undefined || String(value).trim() === '') return '—';
  return String(value);
}

function FieldHint({ message }) {
  if (!message) return null;
  return <p className="mt-1 text-xs text-red-400">{message}</p>;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseHms(time) {
  const m = String(time || '').match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return { h: 0, m: 0, s: 0 };
  return {
    h: Math.min(23, Math.max(0, Number(m[1]) || 0)),
    m: Math.min(59, Math.max(0, Number(m[2]) || 0)),
    s: Math.min(59, Math.max(0, Number(m[3]) || 0)),
  };
}

function formatHms(h, m, s) {
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function ClockColumn({ label, value, max, onChange }) {
  const items = Array.from({ length: max + 1 }, (_, i) => i);
  const listRef = React.useRef(null);

  React.useEffect(() => {
    const el = listRef.current?.querySelector(`[data-val="${value}"]`);
    if (el) el.scrollIntoView({ block: 'center' });
  }, [value]);

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div
        ref={listRef}
        className="h-40 w-14 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950/80 snap-y snap-mandatory"
      >
        {items.map((n) => {
          const active = n === value;
          return (
            <button
              key={n}
              type="button"
              data-val={n}
              className={`flex h-8 w-full snap-center items-center justify-center font-mono text-sm ${
                active
                  ? 'bg-sky-600/30 text-sky-200 font-semibold'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
              onClick={() => onChange(n)}
            >
              {pad2(n)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TimeClockPicker({ value, onChange, required }) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef(null);
  const { h, m, s } = parseHms(value);
  const display = value && /^\d{2}:\d{2}:\d{2}$/.test(value) ? value : formatHms(h, m, s);

  React.useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function setPart(next) {
    onChange(formatHms(next.h ?? h, next.m ?? m, next.s ?? s));
  }

  return (
    <div ref={rootRef} className="relative min-w-[9rem] flex-1">
      <button
        type="button"
        className="field-input flex w-full items-center justify-between gap-2 text-left font-mono"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span>{display || 'HH:mm:ss'}</span>
        <svg
          className="h-4 w-4 shrink-0 text-slate-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {/* Hidden required input so form validation still works */}
      <input type="hidden" required={required} value={display} readOnly />
      {open && (
        <div className="absolute left-0 top-full z-40 mt-2 w-[17.5rem] rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-xl">
          <div className="mb-2 text-center font-mono text-lg text-slate-100 tabular-nums">
            {display}
            <span className="ml-2 text-xs text-slate-500">24h</span>
          </div>
          <div className="flex justify-center gap-2">
            <ClockColumn label="Hour" value={h} max={23} onChange={(v) => setPart({ h: v })} />
            <ClockColumn label="Min" value={m} max={59} onChange={(v) => setPart({ m: v })} />
            <ClockColumn label="Sec" value={s} max={59} onChange={(v) => setPart({ s: v })} />
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="btn-ghost flex-1 text-xs"
              onClick={() => {
                const now = new Date();
                onChange(formatHms(now.getHours(), now.getMinutes(), now.getSeconds()));
              }}
            >
              Now
            </button>
            <button
              type="button"
              className="btn-primary flex-1 text-xs"
              onClick={() => setOpen(false)}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Datetime24Field({ id, value, onChange, required }) {
  const { date, time } = splitDatetimeLocal(value);
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      <input
        id={id}
        type="date"
        className="field-input min-w-[10.5rem] flex-1"
        required={required}
        value={date}
        onChange={(e) => onChange(joinDatetimeLocal(e.target.value, time || '00:00:00'))}
      />
      <TimeClockPicker
        required={required}
        value={time}
        onChange={(nextTime) => onChange(joinDatetimeLocal(date, nextTime))}
      />
    </div>
  );
}

function emptyForm() {
  return {
    reservation_id: '',
    slip_number: '',
    replace_existing: false,
    ticket_status: 'CLOSED',
    truck_number: '',
    rfid_tag: '',
    transporter: '',
    // Remote gap fills are almost always HYWA (gross first).
    vehicle_type: 'HYWA',
    customer_name: '',
    destination: '',
    material: '',
    operator_name: '',
    tare_weight: '',
    gross_weight: '',
    timestamp_in: defaultDatetimeLocal(-HOUR_MS),
    timestamp_out: defaultDatetimeLocal(),
  };
}

/** Map planned gap time onto weigh timestamps for the vehicle type. */
function timesFromPlanned(plannedAt, vehicleType, ticketStatus) {
  const planned = new Date(plannedAt);
  const open = isOpenTicket(ticketStatus);
  if (Number.isNaN(planned.getTime())) {
    return {
      timestamp_in: defaultDatetimeLocal(open ? 0 : -HOUR_MS),
      timestamp_out: defaultDatetimeLocal(open ? HOUR_MS : 0),
    };
  }
  if (open) {
    // First weigh is the planned time (gross for HYWA, tare for standard).
    return {
      timestamp_in: toDatetimeLocalValue(planned.toISOString()),
      timestamp_out: toDatetimeLocalValue(new Date(planned.getTime() + HOUR_MS).toISOString()),
    };
  }
  if (isHywa(vehicleType)) {
    // HYWA: planned time = gross (1st weigh) → timestamp_in
    // Close/tare is ~1 hour later → timestamp_out
    return {
      timestamp_in: toDatetimeLocalValue(planned.toISOString()),
      timestamp_out: toDatetimeLocalValue(new Date(planned.getTime() + HOUR_MS).toISOString()),
    };
  }
  // Standard: planned time = gross (close) → timestamp_out
  return {
    timestamp_in: toDatetimeLocalValue(new Date(planned.getTime() - HOUR_MS).toISOString()),
    timestamp_out: toDatetimeLocalValue(planned.toISOString()),
  };
}

export default function RemoteTrips() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [form, setForm] = useState(emptyForm);
  const [photos, setPhotos] = useState({});
  const [lists, setLists] = useState({
    materials: [],
    customers: [],
    destinations: [],
    operators: [],
  });
  const [reservations, setReservations] = useState([]);
  const [pendingGaps, setPendingGaps] = useState(0);
  const [rows, setRows] = useState([]);
  const [showPendingOnly, setShowPendingOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pdfBusy, setPdfBusy] = useState('');
  const [createdTrip, setCreatedTrip] = useState(null);
  const [listsReady, setListsReady] = useState(false);

  const loadTrips = useCallback(async () => {
    setLoading(true);
    try {
      const params = { limit: '50' };
      if (showPendingOnly) params.pending = 'true';
      const data = await api.getRemoteTrips(params);
      setRows(data.rows || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [showPendingOnly]);

  const loadReservations = useCallback(async () => {
    try {
      const [heldRes, activeRes] = await Promise.all([
        api.getSlipReservations({ status: 'held', limit: '100' }),
        api.getSlipReservations({ status: 'active', limit: '100' }),
      ]);
      setReservations(heldRes.rows || []);
      const pending = (activeRes.rows || []).filter(
        (r) => r.status === 'scheduled' || r.status === 'missed',
      ).length;
      setPendingGaps(pending);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    Promise.all([
      api.getList('materials'),
      api.getList('customers'),
      api.getList('destinations'),
      api.getList('operators'),
    ])
      .then(([materials, customers, destinations, operators]) => {
        setLists({
          materials: materials.items || [],
          customers: customers.items || [],
          destinations: destinations.items || [],
          operators: operators.items || [],
        });
      })
      .catch((err) => {
        console.error(err);
        setError('Could not load saved materials, customers, destinations, and operators');
      })
      .finally(() => setListsReady(true));
  }, []);

  useEffect(() => {
    loadTrips();
  }, [loadTrips]);

  useEffect(() => {
    loadReservations();
  }, [loadReservations]);

  function applyReservation(row) {
    if (!row) {
      setForm((f) => ({
        ...f,
        reservation_id: '',
        slip_number: '',
      }));
      return;
    }
    setForm((f) => {
      const vehicleType = f.vehicle_type || 'HYWA';
      const times = timesFromPlanned(row.planned_at, vehicleType, f.ticket_status);
      return {
        ...f,
        reservation_id: row.id,
        slip_number: row.slip_number || '',
        vehicle_type: vehicleType,
        ...times,
      };
    });
  }

  useEffect(() => {
    const reservationId = searchParams.get('reservation');
    if (!reservationId || !reservations.length) return;
    const row = reservations.find((r) => r.id === reservationId);
    if (!row) return;
    applyReservation(row);
    setSearchParams({}, { replace: true });
  }, [searchParams, reservations, setSearchParams]);

  function updateField(key, value) {
    setForm((f) => {
      const next = { ...f, [key]: value };
      // Re-map planned gap times when switching HYWA ↔ standard or open ↔ closed.
      if ((key === 'vehicle_type' || key === 'ticket_status') && f.reservation_id) {
        const reservation = reservations.find((r) => r.id === f.reservation_id);
        if (reservation?.planned_at) {
          Object.assign(
            next,
            timesFromPlanned(reservation.planned_at, next.vehicle_type, next.ticket_status),
          );
        }
      }
      return next;
    });
  }

  const fieldErrors = useMemo(() => {
    if (!listsReady) return {};
    return validateRemoteTripFields(submittedBody(form), lists);
  }, [form, lists, listsReady]);
  const fieldCheckFailed = !listsReady || Object.keys(fieldErrors).length > 0;
  const entry = submittedBody(form);

  function onReservationChange(id) {
    if (!id) {
      applyReservation(null);
      return;
    }
    const row = reservations.find((r) => r.id === id);
    applyReservation(row || null);
  }

  async function uploadPhoto(slip, pass, slot, file) {
    const uploaded = await api.uploadRemoteTripPhoto(slip, slot, file, pass);
    return { slot, key: uploaded.key, pass };
  }

  async function onSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const open = isOpenTicket(form.ticket_status);
      if (!listsReady) {
        throw new Error('Saved lists are still loading');
      }
      const problems = Object.values(validateRemoteTripFields(submittedBody(form), lists));
      if (problems.length) {
        throw new Error(problems.join(' '));
      }

      const chosenSlip = form.slip_number.trim().toUpperCase() || undefined;
      const photoS3Keys = [];
      const photoPasses = photoPassesFor(form.vehicle_type, form.ticket_status);

      // When slip is known up front, upload photos BEFORE create so the PC
      // import (triggered on INSERT) already has S3 keys.
      if (chosenSlip) {
        for (const { pass } of photoPasses) {
          for (const slot of PHOTO_SLOTS) {
            const file = photos[photoKey(pass, slot)];
            if (!file) continue;
            // eslint-disable-next-line no-await-in-loop
            const uploaded = await uploadPhoto(chosenSlip, pass, slot, file);
            photoS3Keys.push(uploaded);
          }
        }
      }

      const payload = {
        ...form,
        ticket_status: open ? 'OPEN' : 'CLOSED',
        slip_number: chosenSlip,
        reservation_id: form.reservation_id || undefined,
        replace_existing: Boolean(form.replace_existing),
        photoS3Keys: chosenSlip ? photoS3Keys : undefined,
        timestamp_in: new Date(form.timestamp_in).toISOString(),
        timestamp_out: open ? null : new Date(form.timestamp_out).toISOString(),
        tare_weight: open && isHywa(form.vehicle_type) ? null : form.tare_weight,
        gross_weight: open && !isHywa(form.vehicle_type) ? null : form.gross_weight,
      };

      const { trip } = await api.createRemoteTrip(payload);

      // Auto-assigned slip: upload+attach after create (re-queues PC if it synced early).
      if (!chosenSlip) {
        for (const { pass } of photoPasses) {
          for (const slot of PHOTO_SLOTS) {
            const file = photos[photoKey(pass, slot)];
            if (!file) continue;
            // eslint-disable-next-line no-await-in-loop
            const uploaded = await uploadPhoto(trip.slip_number, pass, slot, file);
            photoS3Keys.push(uploaded);
          }
        }
        if (photoS3Keys.length) {
          await api.attachRemoteTripPhotos(trip.id, photoS3Keys);
        }
      }

      const kind = open ? 'Open ticket' : 'Remote trip';
      const followUp = open
        ? 'The weighbridge PC will import it as an open ticket so the second weigh can close it on site.'
        : 'The weighbridge PC will import it within ~30 seconds when online.';
      if (photoS3Keys.length) {
        setMessage(
          `${kind} ${trip.slip_number} created with ${photoS3Keys.length} photo(s). ${followUp}`,
        );
      } else {
        setMessage(`${kind} ${trip.slip_number} created (no photos attached). ${followUp}`);
      }
      setCreatedTrip(trip);
      setForm(emptyForm());
      setPhotos({});
      loadTrips();
      loadReservations();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h2 className="text-xl font-semibold">Remote trip entry</h2>
        <p className="text-sm text-slate-400 mt-1">
          Create a closed trip or an open ticket in the cloud. Closed trips with a future close
          time wait until that time; past close times and open tickets sync on the next pull.
          Remote trips are for <span className="text-slate-200 font-medium">DCC only</span> (not MKG
          or other companies).{' '}
          <Link to="/plan-gaps" className="text-brand-300 hover:underline">
            Plan slip gaps
          </Link>{' '}
          to schedule times; slips block automatically 5 minutes before each planned time.
        </p>
      </div>

      <form onSubmit={onSubmit} className="card p-5 space-y-4">
        <h3 className="text-sm font-medium text-slate-200">New remote trip</h3>

        <div>
          <label className="text-xs text-slate-400">Ticket</label>
          <div className="mt-1 flex flex-wrap gap-2">
            <button
              type="button"
              className={isOpenTicket(form.ticket_status) ? 'btn-ghost' : 'btn-primary'}
              onClick={() => updateField('ticket_status', 'CLOSED')}
            >
              Closed ticket
            </button>
            <button
              type="button"
              className={isOpenTicket(form.ticket_status) ? 'btn-primary' : 'btn-ghost'}
              onClick={() => updateField('ticket_status', 'OPEN')}
            >
              Open ticket
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {isOpenTicket(form.ticket_status)
              ? 'First weigh only. The weighbridge imports it as an open ticket and closes it on the second weigh.'
              : 'Both weighs. The weighbridge imports a finished ticket.'}
          </p>
        </div>

        <div className="rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm">
          <span className="text-slate-400">Company</span>
          <span className="ml-2 font-medium text-white">DCC</span>
          <span className="ml-2 text-xs text-slate-500">(fixed — remote push is DCC only)</span>
        </div>

        <div>
          <label className="text-xs text-slate-400">Use planned gap (recommended)</label>
          <select
            className="field-input mt-1"
            value={form.reservation_id}
            onChange={(e) => onReservationChange(e.target.value)}
          >
            <option value="">None — allocate new slip at end of series</option>
            {reservations.map((r) => (
              <option key={r.id} value={r.id}>
                {r.slip_number} · planned {fmtDate(r.planned_at)}
                {r.note ? ` · ${r.note}` : ''}
              </option>
            ))}
          </select>
          {reservations.length === 0 && (
            <p className="text-xs text-slate-500 mt-1">
              No blocked gaps ready to fill.{' '}
              {pendingGaps > 0 ? (
                <>
                  {pendingGaps} gap(s) are still scheduled or missed — wait for auto-block (5 min
                  before planned time) or use{' '}
                  <Link to="/plan-gaps" className="text-brand-300 hover:underline">
                    Block now
                  </Link>{' '}
                  on Plan Gaps.
                </>
              ) : (
                <>
                  <Link to="/plan-gaps" className="text-brand-300 hover:underline">
                    Schedule gaps
                  </Link>{' '}
                  first if you need times to match the sequence.
                </>
              )}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400">Slip number (optional)</label>
            <input
              className={`field-input mt-1 ${fieldErrors.slip_number ? 'border-red-500' : ''}`}
              placeholder="Auto WB#### if blank"
              value={form.slip_number}
              onChange={(e) =>
                updateField('slip_number', e.target.value.toUpperCase().replace(/[\s-]/g, ''))
              }
              readOnly={!!form.reservation_id}
            />
            <FieldHint message={fieldErrors.slip_number} />
            {!!form.slip_number.trim() && !form.reservation_id && (
              <label className="mt-2 flex items-start gap-2 text-xs text-slate-400">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={Boolean(form.replace_existing)}
                  onChange={(e) => updateField('replace_existing', e.target.checked)}
                />
                <span>
                  Replace existing slip if already in remote trips (deletes the old cloud row for
                  this slip)
                </span>
              </label>
            )}
          </div>
          <div>
            <label className="text-xs text-slate-400">Vehicle number *</label>
            <input
              className={`field-input mt-1 ${fieldErrors.truck_number ? 'border-red-500' : ''}`}
              required
              placeholder="e.g. HR38AH6118"
              value={form.truck_number}
              onChange={(e) =>
                updateField('truck_number', e.target.value.toUpperCase().replace(/[\s-]/g, ''))
              }
            />
            <FieldHint message={fieldErrors.truck_number} />
          </div>
          {(!isOpenTicket(form.ticket_status) || !isHywa(form.vehicle_type)) && (
            <div>
              <label className="text-xs text-slate-400">
                {isOpenTicket(form.ticket_status) ? 'Tare weight (1st weigh, kg) *' : 'Tare weight (kg) *'}
              </label>
              <input
                type="number"
                className={`field-input mt-1 ${fieldErrors.tare_weight ? 'border-red-500' : ''}`}
                required
                value={form.tare_weight}
                onChange={(e) => updateField('tare_weight', e.target.value)}
              />
              <FieldHint message={fieldErrors.tare_weight} />
            </div>
          )}
          {(!isOpenTicket(form.ticket_status) || isHywa(form.vehicle_type)) && (
            <div>
              <label className="text-xs text-slate-400">
                {isOpenTicket(form.ticket_status) ? 'Gross weight (1st weigh, kg) *' : 'Gross weight (kg) *'}
              </label>
              <input
                type="number"
                className={`field-input mt-1 ${fieldErrors.gross_weight ? 'border-red-500' : ''}`}
                required
                value={form.gross_weight}
                onChange={(e) => updateField('gross_weight', e.target.value)}
              />
              <FieldHint message={fieldErrors.gross_weight} />
            </div>
          )}
          <div>
            <label className="text-xs text-slate-400">
              {isHywa(form.vehicle_type) ? 'Gross time (1st weigh) *' : 'Arrival / tare time *'}
              <span className="text-slate-500"> — 24h with seconds</span>
            </label>
            <Datetime24Field
              required
              value={form.timestamp_in}
              onChange={(v) => updateField('timestamp_in', v)}
            />
            <FieldHint message={fieldErrors.timestamp_in} />
          </div>
          {!isOpenTicket(form.ticket_status) && (
            <div>
              <label className="text-xs text-slate-400">
                {isHywa(form.vehicle_type) ? 'Tare time (2nd weigh / close) *' : 'Close / gross time *'}
                <span className="text-slate-500"> — 24h with seconds</span>
              </label>
              <Datetime24Field
                required
                value={form.timestamp_out}
                onChange={(v) => updateField('timestamp_out', v)}
              />
              <FieldHint message={fieldErrors.timestamp_out} />
            </div>
          )}
          <div>
            <label className="text-xs text-slate-400">RFID tag</label>
            <input
              className={`field-input mt-1 ${fieldErrors.rfid_tag ? 'border-red-500' : ''}`}
              value={form.rfid_tag}
              onChange={(e) => updateField('rfid_tag', e.target.value)}
            />
            <FieldHint message={fieldErrors.rfid_tag} />
          </div>
          <div>
            <label className="text-xs text-slate-400">Transporter</label>
            <input
              className={`field-input mt-1 ${fieldErrors.transporter ? 'border-red-500' : ''}`}
              value={form.transporter}
              onChange={(e) => updateField('transporter', e.target.value)}
            />
            <FieldHint message={fieldErrors.transporter} />
          </div>
          <div>
            <label className="text-xs text-slate-400">Vehicle type</label>
            <select
              className="field-input mt-1"
              value={form.vehicle_type}
              onChange={(e) => updateField('vehicle_type', e.target.value)}
            >
              <option value="HYWA">HYWA (gross first)</option>
              <option value="TRUCK">TRUCK (tare first)</option>
              <option value="TANKER">TANKER</option>
              <option value="CONTAINER">CONTAINER</option>
            </select>
          </div>
        </div>

        {[
          { key: 'material', label: 'Material *', list: lists.materials },
          { key: 'customer_name', label: 'Customer *', list: lists.customers },
          { key: 'destination', label: 'Destination *', list: lists.destinations },
          { key: 'operator_name', label: 'Operator *', list: lists.operators },
        ].map(({ key, label, list }) => (
          <div key={key}>
            <label className="text-xs text-slate-400">{label}</label>
            <input
              className={`field-input mt-1 ${fieldErrors[key] ? 'border-red-500' : ''}`}
              list={`remote-${key}-list`}
              required
              value={form[key]}
              onChange={(e) => updateField(key, e.target.value)}
            />
            <FieldHint message={fieldErrors[key]} />
            <datalist id={`remote-${key}-list`}>
              {list.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </div>
        ))}

        <div className="space-y-3 border-t border-slate-800 pt-4">
          <p className="text-xs text-slate-400">Photos (optional — uploaded to S3 for PC import)</p>
          {photoPassesFor(form.vehicle_type, form.ticket_status).map(({ pass, title }) => (
            <div key={pass}>
              <p className="text-xs font-medium text-slate-500 mb-2">{title}</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {PHOTO_SLOTS.map((slot) => (
                  <div key={photoKey(pass, slot)}>
                    <label className="text-xs text-slate-500">Camera {slot}</label>
                    <input
                      type="file"
                      accept="image/*"
                      className="field-input mt-1 text-xs"
                      disabled={saving}
                      onChange={(e) =>
                        setPhotos((p) => ({
                          ...p,
                          [photoKey(pass, slot)]: e.target.files?.[0] || null,
                        }))
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-md border border-slate-700 bg-slate-900/40 p-3 space-y-2">
          <div>
            <p className="text-xs font-medium text-slate-200">Field check</p>
            <p className="text-xs text-slate-500 mt-0.5">
              Each value has to be the kind of data that field stores. Create stays off until every
              row matches.
            </p>
          </div>
          {!listsReady && (
            <p className="text-xs text-slate-400">Loading saved materials, customers, destinations, and operators…</p>
          )}
          <ul className="space-y-1">
            {CHECK_FIELDS.map(([key, label]) => {
              const problem = fieldErrors[key];
              const pending = !listsReady;
              const ok = !pending && !problem;
              const tone = pending ? 'text-slate-400' : ok ? 'text-emerald-400' : 'text-red-400';
              const mark = pending ? '…' : ok ? 'Match' : 'Fix';
              return (
                <li
                  key={key}
                  className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-[3.25rem_8.5rem_minmax(0,1fr)_minmax(0,1.3fr)] sm:items-baseline sm:gap-3"
                >
                  <span className={tone}>{mark}</span>
                  <span className="text-slate-300">{label}</span>
                  <span className="truncate font-mono text-slate-200">{displayFieldValue(key, entry)}</span>
                  <span className={problem ? 'text-red-300' : 'text-slate-500'}>
                    {problem || fieldRole(key, form, lists, listsReady)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        {message && <p className="text-sm text-emerald-400">{message}</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex flex-wrap gap-2 pt-1">
          <button type="submit" className="btn-primary" disabled={saving || fieldCheckFailed}>
            {saving
              ? 'Creating…'
              : isOpenTicket(form.ticket_status)
                ? 'Create open ticket'
                : 'Create remote trip'}
          </button>
          {createdTrip?.id && (
            <button
              type="button"
              className="btn-ghost text-xs"
              disabled={pdfBusy === createdTrip.id}
              onClick={async () => {
                setPdfBusy(createdTrip.id);
                setError('');
                try {
                  await api.downloadRemoteTripPdf(createdTrip.id, createdTrip.slip_number);
                } catch (err) {
                  setError(err.message);
                } finally {
                  setPdfBusy('');
                }
              }}
            >
              {pdfBusy === createdTrip.id
                ? 'Building PDF…'
                : `Download PDF (${createdTrip.slip_number})`}
            </button>
          )}
        </div>
      </form>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="text-sm font-medium text-slate-200">Recent remote trips</h3>
          <div className="flex gap-2 items-center">
            <label className="text-xs text-slate-400 flex items-center gap-2">
              <input
                type="checkbox"
                checked={showPendingOnly}
                onChange={(e) => setShowPendingOnly(e.target.checked)}
              />
              Pending sync only
            </label>
            <button type="button" className="btn-ghost text-xs" onClick={loadTrips}>
              Refresh
            </button>
          </div>
        </div>

        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800">
                <th className="p-3">Slip</th>
                <th className="p-3">Vehicle</th>
                <th className="p-3">Customer</th>
                <th className="p-3">Net</th>
                <th className="p-3">Status</th>
                <th className="p-3">Sync</th>
                <th className="p-3">MCG</th>
                <th className="p-3">PDF</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-slate-800/60">
                  <td className="p-3 font-mono text-xs">{row.slip_number}</td>
                  <td className="p-3">{row.truck_number}</td>
                  <td className="p-3">{row.customer_name}</td>
                  <td className="p-3">{fmtKg(row.net_weight)}</td>
                  <td className="p-3">
                    <Badge tone={isOpenTicket(row.ticket_status) ? 'warning' : 'success'}>
                      {isOpenTicket(row.ticket_status) ? 'Open' : 'Closed'}
                    </Badge>
                    <div className="text-xs text-slate-500 mt-1">
                      {fmtDate(isOpenTicket(row.ticket_status) ? row.timestamp_in : row.timestamp_out)}
                    </div>
                  </td>
                  <td className="p-3">
                    <Badge
                      tone={
                        row.release_at && new Date(row.release_at).getTime() > Date.now()
                          ? 'info'
                          : row.synced_to_local
                            ? 'success'
                            : 'warning'
                      }
                    >
                      {row.release_at && new Date(row.release_at).getTime() > Date.now()
                        ? 'Waiting'
                        : row.synced_to_local
                          ? 'Synced'
                          : 'Pending'}
                    </Badge>
                  </td>
                  <td className="p-3 text-xs text-slate-400">{row.mcg_status || '—'}</td>
                  <td className="p-3">
                    <button
                      type="button"
                      className="text-emerald-400 hover:underline text-xs disabled:opacity-50"
                      disabled={pdfBusy === row.id}
                      onClick={async () => {
                        setPdfBusy(row.id);
                        setError('');
                        try {
                          await api.downloadRemoteTripPdf(row.id, row.slip_number);
                        } catch (err) {
                          setError(err.message);
                        } finally {
                          setPdfBusy('');
                        }
                      }}
                    >
                      {pdfBusy === row.id ? 'PDF…' : 'PDF'}
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-slate-500">
                    No remote trips yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
