import React, { useCallback, useEffect, useState } from 'react';
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

function photoPassesFor(vehicleType) {
  if (isHywa(vehicleType)) {
    return [
      { pass: 'arrival', title: 'Gross (1st weigh) photos' },
      { pass: 'departure', title: 'Tare (2nd weigh / close) photos' },
    ];
  }
  return [
    { pass: 'arrival', title: 'Arrival (tare) photos' },
    { pass: 'departure', title: 'Departure (gross) photos' },
  ];
}

function photoKey(pass, slot) {
  return `${pass}:${slot}`;
}

function defaultDatetimeLocal(offsetMs = 0) {
  const d = new Date(Date.now() + offsetMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function emptyForm() {
  return {
    reservation_id: '',
    slip_number: '',
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
function timesFromPlanned(plannedAt, vehicleType) {
  const planned = new Date(plannedAt);
  if (Number.isNaN(planned.getTime())) {
    return {
      timestamp_in: defaultDatetimeLocal(-HOUR_MS),
      timestamp_out: defaultDatetimeLocal(),
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
      .catch(console.error);
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
      const times = timesFromPlanned(row.planned_at, vehicleType);
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
      // Re-map planned gap times when switching HYWA ↔ standard.
      if (key === 'vehicle_type' && f.reservation_id) {
        const reservation = reservations.find((r) => r.id === f.reservation_id);
        if (reservation?.planned_at) {
          Object.assign(next, timesFromPlanned(reservation.planned_at, value));
        }
      }
      return next;
    });
  }

  function onReservationChange(id) {
    if (!id) {
      applyReservation(null);
      return;
    }
    const row = reservations.find((r) => r.id === id);
    applyReservation(row || null);
  }

  async function uploadPhoto(slip, pass, slot, file) {
    const { uploadUrl, key } = await api.getRemoteTripUploadUrl(
      slip,
      slot,
      file.type || 'image/jpeg',
      pass,
    );
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type || 'image/jpeg' },
    });
    if (!res.ok) throw new Error(`Photo upload failed (${pass} camera ${slot})`);
    return { slot, key, pass };
  }

  async function onSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const payload = {
        ...form,
        slip_number: form.slip_number.trim() || undefined,
        reservation_id: form.reservation_id || undefined,
        timestamp_in: new Date(form.timestamp_in).toISOString(),
        timestamp_out: new Date(form.timestamp_out).toISOString(),
      };

      const { trip } = await api.createRemoteTrip(payload);
      const photoS3Keys = [];

      for (const { pass } of photoPassesFor(form.vehicle_type)) {
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

      setMessage(
        `Remote trip ${trip.slip_number} created. The weighbridge PC will import it within ~30 seconds when online.`,
      );
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
          Create a closed ticket in the cloud — the weighbridge PC pulls it into local Reports
          automatically (same as inserting into RDS <code className="text-xs">remote_trips</code>).
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
              className="field-input mt-1"
              placeholder="Auto WB#### if blank"
              value={form.slip_number}
              onChange={(e) => updateField('slip_number', e.target.value.toUpperCase())}
              readOnly={!!form.reservation_id}
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">Vehicle number *</label>
            <input
              className="field-input mt-1"
              required
              value={form.truck_number}
              onChange={(e) => updateField('truck_number', e.target.value.toUpperCase())}
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">Tare weight (kg) *</label>
            <input
              type="number"
              className="field-input mt-1"
              required
              value={form.tare_weight}
              onChange={(e) => updateField('tare_weight', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">Gross weight (kg) *</label>
            <input
              type="number"
              className="field-input mt-1"
              required
              value={form.gross_weight}
              onChange={(e) => updateField('gross_weight', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">
              {isHywa(form.vehicle_type) ? 'Gross time (1st weigh) *' : 'Arrival / tare time *'}
            </label>
            <input
              type="datetime-local"
              className="field-input mt-1"
              required
              value={form.timestamp_in}
              onChange={(e) => updateField('timestamp_in', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">
              {isHywa(form.vehicle_type) ? 'Tare time (2nd weigh / close) *' : 'Close / gross time *'}
            </label>
            <input
              type="datetime-local"
              className="field-input mt-1"
              required
              value={form.timestamp_out}
              onChange={(e) => updateField('timestamp_out', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">RFID tag</label>
            <input
              className="field-input mt-1"
              value={form.rfid_tag}
              onChange={(e) => updateField('rfid_tag', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">Transporter</label>
            <input
              className="field-input mt-1"
              value={form.transporter}
              onChange={(e) => updateField('transporter', e.target.value)}
            />
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
              className="field-input mt-1"
              list={`remote-${key}-list`}
              required
              value={form[key]}
              onChange={(e) => updateField(key, e.target.value)}
            />
            <datalist id={`remote-${key}-list`}>
              {list.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </div>
        ))}

        <div className="space-y-3 border-t border-slate-800 pt-4">
          <p className="text-xs text-slate-400">Photos (optional — uploaded to S3 for PC import)</p>
          {photoPassesFor(form.vehicle_type).map(({ pass, title }) => (
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

        {message && <p className="text-sm text-emerald-400">{message}</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}

        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Creating…' : 'Create remote trip'}
        </button>
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
                <th className="p-3">Closed</th>
                <th className="p-3">Sync</th>
                <th className="p-3">MCG</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-slate-800/60">
                  <td className="p-3 font-mono text-xs">{row.slip_number}</td>
                  <td className="p-3">{row.truck_number}</td>
                  <td className="p-3">{row.customer_name}</td>
                  <td className="p-3">{fmtKg(row.net_weight)}</td>
                  <td className="p-3 text-xs">{fmtDate(row.timestamp_out)}</td>
                  <td className="p-3">
                    <Badge tone={row.synced_to_local ? 'success' : 'warning'}>
                      {row.synced_to_local ? 'Synced' : 'Pending'}
                    </Badge>
                  </td>
                  <td className="p-3 text-xs text-slate-400">{row.mcg_status || '—'}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-slate-500">
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
