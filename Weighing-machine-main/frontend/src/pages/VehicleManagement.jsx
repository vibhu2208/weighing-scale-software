import React, { useCallback, useEffect, useRef, useState } from 'react';
import { deviceAPI, subscribe, vehicleAPI } from '../api/ipc.js';
import Badge from '../components/shared/Badge.jsx';
import { useToast } from '../components/shared/Toast.jsx';
import useDeviceStore from '../store/deviceStore.js';
import { VEHICLE_TYPES } from '../lib/vehicleTypes.js';

const TYPES = VEHICLE_TYPES;
const EMPTY = {
  vehicle_number: '',
  rfid_tag: '',
  owner_name: '',
  transporter: '',
  vehicle_type: 'truck',
  max_capacity: '',
};

export default function VehicleManagement() {
  const toast = useToast();
  const [vehicles, setVehicles] = useState([]);
  const [query, setQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [scanningRfid, setScanningRfid] = useState(false);
  const rfidConnected = useDeviceStore((s) => s.rfid.connected);
  const scanAppliedRef = useRef(false);

  const applyScannedTag = useCallback((tag) => {
    const normalized = String(tag || '').trim().toUpperCase();
    if (!normalized || scanAppliedRef.current) return;
    scanAppliedRef.current = true;
    setForm((f) => ({ ...f, rfid_tag: normalized }));
    setScanningRfid(false);
    deviceAPI.stopRfidScan().catch(() => {});
  }, []);

  const load = useCallback(async () => {
    const rows = showInactive
      ? await vehicleAPI.getAll({ includeInactive: true })
      : query.trim()
        ? await vehicleAPI.search(query.trim())
        : await vehicleAPI.getAll();
    setVehicles(Array.isArray(rows) ? rows : []);
  }, [query, showInactive]);

  useEffect(() => {
    const t = setTimeout(() => load().catch(console.error), 300);
    return () => clearTimeout(t);
  }, [load]);

  function closeDrawer() {
    setScanningRfid(false);
    scanAppliedRef.current = false;
    deviceAPI.stopRfidScan().catch(() => {});
    setDrawerOpen(false);
  }

  function openAdd() {
    setEditing(null);
    setForm(EMPTY);
    setErrors({});
    scanAppliedRef.current = false;
    setDrawerOpen(true);
  }

  function openEdit(v) {
    setEditing(v);
    setForm({
      vehicle_number: v.vehicle_number || '',
      rfid_tag: v.rfid_tag || '',
      owner_name: v.owner_name || '',
      transporter: v.transporter || '',
      vehicle_type: v.vehicle_type || 'truck',
      max_capacity: v.max_capacity ?? '',
    });
    setErrors({});
    scanAppliedRef.current = false;
    setDrawerOpen(true);
  }

  useEffect(() => {
    if (!scanningRfid || !drawerOpen) return undefined;

    const onTag = (payload) => {
      if (payload?.tag) applyScannedTag(payload.tag);
    };

    const unsubs = [
      subscribe('device:rfidLive', onTag),
      subscribe('device:rfidTag', onTag),
    ];

    return () => unsubs.forEach((u) => u());
  }, [scanningRfid, drawerOpen, applyScannedTag]);

  async function handleScanRfid() {
    if (scanningRfid) {
      setScanningRfid(false);
      scanAppliedRef.current = false;
      await deviceAPI.stopRfidScan().catch(() => {});
      return;
    }
    if (!rfidConnected) {
      toast.show('RFID reader is not connected');
      return;
    }
    scanAppliedRef.current = false;
    try {
      useDeviceStore.getState().clearRfidScan();
      await deviceAPI.startRfidScan();
      setScanningRfid(true);
    } catch (err) {
      toast.show(err.message || 'Failed to start RFID scan');
    }
  }

  function validate() {
    const e = {};
    if (!form.vehicle_number.trim()) e.vehicle_number = 'Required';
    if (!form.owner_name.trim()) e.owner_name = 'Required';
    if (!form.vehicle_type) e.vehicle_type = 'Required';
    if (form.max_capacity !== '' && Number(form.max_capacity) <= 0) {
      e.max_capacity = 'Must be positive';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(ev) {
    ev.preventDefault();
    if (!validate()) return;
    setSaving(true);
    setErrors({});
    try {
      const payload = {
        ...form,
        vehicle_number: form.vehicle_number.trim().toUpperCase(),
        max_capacity: form.max_capacity === '' ? null : Number(form.max_capacity),
      };
      if (editing) {
        await vehicleAPI.update(editing.id, payload);
        toast.show('Vehicle updated');
      } else {
        await vehicleAPI.create(payload);
        toast.show('Vehicle added');
      }
      closeDrawer();
      await load();
    } catch (err) {
      const msg = err.message || 'Save failed';
      if (msg.includes('rfid_tag')) {
        const match = msg.match(/vehicle ([A-Z0-9]+)/i);
        setErrors({
          rfid_tag: match
            ? `This RFID tag is already assigned to ${match[1]}`
            : 'RFID already in use',
        });
      } else {
        setErrors({ form: msg });
      }
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(v) {
    if (v.status === 'active') {
      await vehicleAPI.delete(v.id);
      toast.show('Vehicle deactivated');
    } else {
      await vehicleAPI.update(v.id, { status: 'active' });
      toast.show('Vehicle reactivated');
    }
    await load();
  }

  return (
    <div className="flex flex-col gap-4 relative">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Vehicles</h1>
          <p className="mt-1 text-sm text-slate-400">{vehicles.length} records</p>
        </div>
        <button type="button" className="btn-primary" onClick={openAdd}>
          Add vehicle
        </button>
      </header>

      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="search"
          placeholder="Search number or owner…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="field-input max-w-md flex-1"
        />
        <label className="flex items-center gap-2 text-sm text-slate-400">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
      </div>

      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-5 py-3">Vehicle Number</th>
                <th className="px-5 py-3">RFID Tag</th>
                <th className="px-5 py-3">Owner</th>
                <th className="px-5 py-3">Transporter</th>
                <th className="px-5 py-3">Type</th>
                <th className="px-5 py-3">Capacity</th>
                <th className="px-5 py-3">Ticket Status</th>
                <th className="px-5 py-3">Trip</th>
                <th className="px-5 py-3">Active</th>
                <th className="px-5 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => (
                <tr
                  key={v.id}
                  className={`border-b border-slate-800/60 hover:bg-slate-800/30 ${v.status === 'inactive' ? 'opacity-50' : ''}`}
                >
                  <td className="px-5 py-3 font-medium text-white">{v.vehicle_number}</td>
                  <td className="px-5 py-3 font-mono text-xs text-slate-400">{v.rfid_tag || '—'}</td>
                  <td className="px-5 py-3">{v.owner_name}</td>
                  <td className="px-5 py-3">{v.transporter || '—'}</td>
                  <td className="px-5 py-3 capitalize">{v.vehicle_type}</td>
                  <td className="px-5 py-3">{v.max_capacity ? `${v.max_capacity} kg` : '—'}</td>
                  <td className="px-5 py-3">
                    <Badge
                      label={v.ticket_status === 'open' ? 'Open' : 'Closed'}
                      variant={v.ticket_status === 'open' ? 'warning' : 'success'}
                    />
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-slate-300">
                    {v.trip || '—'}
                  </td>
                  <td className="px-5 py-3">
                    <Badge
                      label={v.status}
                      variant={v.status === 'active' ? 'success' : 'default'}
                    />
                  </td>
                  <td className="px-5 py-3 space-x-2">
                    <button type="button" className="text-brand-300 hover:text-brand-200" onClick={() => openEdit(v)} title="Edit">✎</button>
                    <button type="button" className="text-slate-400 hover:text-white text-xs" onClick={() => toggleActive(v)}>
                      {v.status === 'active' ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {drawerOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50" onClick={() => !saving && closeDrawer()} />
          <aside className="fixed right-0 top-0 z-50 h-full w-full max-w-md border-l border-slate-800 bg-slate-900 shadow-2xl flex flex-col">
            <div className="border-b border-slate-800 px-5 py-4 flex justify-between items-center">
              <h2 className="font-semibold text-white">{editing ? 'Edit vehicle' : 'Add vehicle'}</h2>
              <button type="button" className="text-slate-400" disabled={saving} onClick={closeDrawer}>✕</button>
            </div>
            <form onSubmit={handleSubmit} className="flex-1 overflow-auto p-5 space-y-4">
              {errors.form && <p className="text-sm text-red-300">{errors.form}</p>}
              <Field label="Vehicle number *" error={errors.vehicle_number}>
                <input className="field-input" disabled={saving} value={form.vehicle_number} onChange={(e) => setForm({ ...form, vehicle_number: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="RFID tag" error={errors.rfid_tag}>
                <input
                  className="field-input font-mono text-sm"
                  disabled={saving || scanningRfid}
                  value={form.rfid_tag}
                  onChange={(e) =>
                    setForm({ ...form, rfid_tag: e.target.value.trim().toUpperCase() })
                  }
                  placeholder="Scan or enter EPC"
                />
                <button
                  type="button"
                  className={`mt-2 w-full ${scanningRfid ? 'btn-danger' : 'btn-primary'}`}
                  disabled={saving || (!scanningRfid && !rfidConnected)}
                  onClick={handleScanRfid}
                >
                  {scanningRfid ? 'Stop scanning' : 'Scan RFID'}
                </button>
                {scanningRfid && (
                  <p className="mt-2 text-xs text-amber-300">
                    Hold tag near reader — EPC will fill automatically
                  </p>
                )}
              </Field>
              <Field label="Owner name *" error={errors.owner_name}>
                <input className="field-input" disabled={saving} value={form.owner_name} onChange={(e) => setForm({ ...form, owner_name: e.target.value })} />
              </Field>
              <Field label="Transporter">
                <input className="field-input" disabled={saving} value={form.transporter} onChange={(e) => setForm({ ...form, transporter: e.target.value })} />
              </Field>
              <Field label="Vehicle type *">
                <select className="field-input" disabled={saving} value={form.vehicle_type} onChange={(e) => setForm({ ...form, vehicle_type: e.target.value })}>
                  {TYPES.map((t) => (
                    <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                  ))}
                </select>
              </Field>
              <Field label="Max capacity (kg)" error={errors.max_capacity}>
                <input type="number" className="field-input" disabled={saving} value={form.max_capacity} onChange={(e) => setForm({ ...form, max_capacity: e.target.value })} />
              </Field>
              <button type="submit" className="btn-primary w-full" disabled={saving}>
                {saving ? 'Saving…' : 'Save vehicle'}
              </button>
            </form>
          </aside>
        </>
      )}
    </div>
  );
}

function Field({ label, error, children }) {
  return (
    <label className="block text-sm">
      <span className="text-slate-400">{label}</span>
      <div className="mt-1">{children}</div>
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
    </label>
  );
}
