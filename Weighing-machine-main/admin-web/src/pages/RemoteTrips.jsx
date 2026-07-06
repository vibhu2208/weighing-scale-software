import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import Badge from '../components/Badge.jsx';
import { fmtDate, fmtKg } from '../lib/format.js';

const PHOTO_SLOTS = [1, 2, 3];
const PHOTO_PASSES = [
  { pass: 'arrival', title: 'Arrival (tare) photos' },
  { pass: 'departure', title: 'Departure (gross) photos' },
];

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
    slip_number: '',
    truck_number: '',
    rfid_tag: '',
    transporter: '',
    vehicle_type: '',
    customer_name: '',
    destination: '',
    material: '',
    operator_name: '',
    tare_weight: '',
    gross_weight: '',
    timestamp_in: defaultDatetimeLocal(-60 * 60 * 1000),
    timestamp_out: defaultDatetimeLocal(),
  };
}

export default function RemoteTrips() {
  const [form, setForm] = useState(emptyForm);
  const [photos, setPhotos] = useState({});
  const [lists, setLists] = useState({
    materials: [],
    customers: [],
    destinations: [],
    operators: [],
  });
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

  function updateField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
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
        timestamp_in: new Date(form.timestamp_in).toISOString(),
        timestamp_out: new Date(form.timestamp_out).toISOString(),
      };

      const { trip } = await api.createRemoteTrip(payload);
      const photoS3Keys = [];

      for (const { pass } of PHOTO_PASSES) {
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
        </p>
      </div>

      <form onSubmit={onSubmit} className="card p-5 space-y-4">
        <h3 className="text-sm font-medium text-slate-200">New remote trip</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400">Slip number (optional)</label>
            <input
              className="field-input mt-1"
              placeholder="Auto WB#### if blank"
              value={form.slip_number}
              onChange={(e) => updateField('slip_number', e.target.value.toUpperCase())}
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
            <label className="text-xs text-slate-400">Arrival time *</label>
            <input
              type="datetime-local"
              className="field-input mt-1"
              required
              value={form.timestamp_in}
              onChange={(e) => updateField('timestamp_in', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">Close time *</label>
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
            <input
              className="field-input mt-1"
              placeholder="e.g. HYWA, TRUCK"
              value={form.vehicle_type}
              onChange={(e) => updateField('vehicle_type', e.target.value)}
            />
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
          {PHOTO_PASSES.map(({ pass, title }) => (
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
