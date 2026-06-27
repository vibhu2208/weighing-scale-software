'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'frontend', 'src', 'pages');

function write(name, content) {
  fs.writeFileSync(path.join(root, name), content, 'utf8');
  console.log('wrote', name);
}

write(
  'WeighmentScreen.jsx',
  `import React, { useEffect, useMemo, useState } from 'react';
import useDeviceStore from '../store/deviceStore.js';
import useTransactionStore from '../store/transactionStore.js';
import useThrottledValue from '../hooks/useThrottledValue.js';
import ConfirmModal from '../components/shared/ConfirmModal.jsx';
import Badge from '../components/shared/Badge.jsx';
import {
  reportAPI,
  vehicleAPI,
  workflowAPI,
} from '../api/ipc.js';

function toFileUrl(imagePath) {
  if (!imagePath) return null;
  if (imagePath.startsWith('file://')) return imagePath;
  return \`file:///\${imagePath.replace(/\\\\\\\\/g, '/')}\`;
}

const TIMELINE_STEPS = [
  'RFID Scanned',
  'Vehicle Identified',
  'Weight Captured',
  'Image Captured',
  'Slip Printed',
  'Synced',
];

export default function WeighmentScreen() {
  const rawWeight = useDeviceStore((s) => s.displayWeight);
  const isStable = useDeviceStore((s) => s.displayStable);
  const rfid = useDeviceStore((s) => s.rfid);
  const workflowState = useTransactionStore((s) => s.workflowState);
  const activeTransaction = useTransactionStore((s) => s.activeTransaction);
  const timeline = useTransactionStore((s) => s.timeline);
  const lastEvent = useTransactionStore((s) => s.lastEvent);

  const kg = useThrottledValue(rawWeight, 250);
  const [vehicle, setVehicle] = useState(null);
  const [manualTruck, setManualTruck] = useState('');
  const [abortOpen, setAbortOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [printing, setPrinting] = useState(false);

  const unknownTag =
    lastEvent?.channel === 'workflow:unknownRFID' ? lastEvent.tag : null;
  const inProgress = workflowState !== 'IDLE' && workflowState !== 'ERROR';

  useEffect(() => {
    if (!rfid.lastTag) return;
    vehicleAPI
      .findByRFID(rfid.lastTag)
      .then((v) => setVehicle(v))
      .catch(() => setVehicle(null));
  }, [rfid.lastTag]);

  useEffect(() => {
    if (activeTransaction?.truck_number) {
      vehicleAPI
        .findByNumber(activeTransaction.truck_number)
        .then((v) => setVehicle(v))
        .catch(() => {});
    }
  }, [activeTransaction?.truck_number]);

  const imageSrc = useMemo(
    () => toFileUrl(activeTransaction?.image_path),
    [activeTransaction?.image_path],
  );

  const completedSteps = new Set(timeline.map((t) => t.step));
  const netWeight = useMemo(() => {
    const g = activeTransaction?.gross_weight;
    const t = activeTransaction?.tare_weight;
    if (g == null) return null;
    if (t == null) return g;
    return g - t;
  }, [activeTransaction]);

  const canPrint =
    activeTransaction &&
    ['captured', 'printed', 'synced'].includes(activeTransaction.status);

  const weightColor =
    kg <= 0 ? 'text-slate-500' : isStable ? 'text-emerald-400' : 'text-amber-400';

  async function handleManualSubmit() {
    const truck = manualTruck.trim().toUpperCase();
    if (!truck) return;
    try {
      const existing = await vehicleAPI.findByNumber(truck);
      if (!existing) {
        setCreateOpen(true);
        return;
      }
      await workflowAPI.acceptManualEntry(truck);
      setManualTruck('');
    } catch (err) {
      alert(err.message);
    }
  }

  async function confirmCreateVehicle() {
    const truck = manualTruck.trim().toUpperCase();
    try {
      await vehicleAPI.create({
        vehicle_number: truck,
        rfid_tag: unknownTag || rfid.lastTag || null,
        owner_name: 'Unknown',
        vehicle_type: 'truck',
      });
      await workflowAPI.acceptManualEntry(truck);
      setCreateOpen(false);
      setManualTruck('');
    } catch (err) {
      alert(err.message);
    }
  }

  async function handlePrint() {
    if (!activeTransaction?.id) return;
    setPrinting(true);
    try {
      await reportAPI.printSlip(activeTransaction.id);
    } catch (err) {
      alert(err.message);
    } finally {
      setPrinting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 pb-8">
      <header>
        <h1 className="text-2xl font-semibold text-white">Weighment</h1>
        <p className="mt-1 text-sm text-slate-400">Operator console</p>
      </header>

      <motion.div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-4">
          <div className="card p-8 flex flex-col items-center">
            <p className="text-xs uppercase tracking-widest text-slate-400">Live weight</p>
            <p className={\`mt-2 font-mono font-bold leading-none \${weightColor}\`} style={{ fontSize: 72 }}>
              {Number(kg).toLocaleString('en-IN')}
              <span className="text-2xl ml-2 text-slate-500">kg</span>
            </p>
            <Badge
              label={isStable && kg > 0 ? 'STABLE' : 'UNSTABLE'}
              variant={isStable && kg > 0 ? 'success' : 'warning'}
            />
          </div>

          <div className="card p-4">
            <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-3">RFID</h2>
            {unknownTag ? (
              <div className="rounded-lg border border-red-700/50 bg-red-950/30 p-3">
                <p className="text-sm text-red-200">Unknown RFID tag</p>
                <p className="font-mono text-xs text-red-300 mt-1">{unknownTag}</p>
                <div className="mt-3 flex gap-2">
                  <input
                    type="text"
                    value={manualTruck}
                    onChange={(e) => setManualTruck(e.target.value.toUpperCase())}
                    placeholder="Enter truck number"
                    className="field-input flex-1"
                  />
                  <button type="button" className="btn-primary" onClick={handleManualSubmit}>
                    Continue
                  </button>
                </div>
              </div>
            ) : rfid.lastTag && vehicle ? (
              <motion.div className="rounded-lg bg-slate-800/60 p-3 text-sm space-y-1">
                <p className="font-mono text-brand-200">{rfid.lastTag}</p>
                <p className="text-white font-medium">{vehicle.vehicle_number}</p>
                <p className="text-slate-400">Owner: {vehicle.owner_name || '—'}</p>
                <p className="text-slate-400">Transporter: {vehicle.transporter || '—'}</p>
              </div>
            ) : (
              <p className="text-slate-500 text-sm">Waiting for RFID…</p>
            )}
          </div>

          <div className="card p-4">
            <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-3">Progress</h2>
            <ul className="space-y-2">
              {TIMELINE_STEPS.map((step) => {
                const hit = timeline.find((t) => t.step === step);
                return (
                  <li key={step} className="flex justify-between text-sm">
                    <span className={hit ? 'text-emerald-300' : 'text-slate-500'}>{step}</span>
                    <span className="text-xs font-mono text-slate-500">
                      {hit ? new Date(hit.at).toLocaleTimeString('en-IN') : '—'}
                    </span>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              className="btn-primary mt-4 w-full disabled:opacity-40"
              disabled={!canPrint || printing}
              onClick={handlePrint}
            >
              {printing ? 'Printing…' : 'Print slip'}
            </button>
          </motion.div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="card p-3">
            <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-2">Capture</h2>
            <div className="aspect-video rounded-lg bg-slate-800 flex items-center justify-center overflow-hidden">
              {imageSrc ? (
                <img src={imageSrc} alt="Vehicle" className="h-full w-full object-cover" />
              ) : inProgress ? (
                <span className="text-slate-500 text-sm">Live feed placeholder</span>
              ) : (
                <span className="text-slate-500 text-sm flex flex-col items-center gap-1">
                  <span className="text-2xl">📷</span> No image
                </span>
              )}
            </div>
          </div>

          <div className="card p-4 text-sm space-y-2">
            <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-2">Transaction</h2>
            <Row label="ID" value={activeTransaction?.id || '—'} mono />
            <Row label="Slip" value={activeTransaction?.slip_number || '—'} mono />
            <Row label="Truck" value={activeTransaction?.truck_number || '—'} />
            <Row label="Time in" value={activeTransaction?.timestamp_in || '—'} />
            <Row label="Gross" value={fmtKg(activeTransaction?.gross_weight)} />
            <Row label="Tare" value={fmtKg(activeTransaction?.tare_weight)} />
            <Row label="Net" value={fmtKg(netWeight)} bold />
          </div>

          {inProgress && (
            <button type="button" className="btn-danger w-full" onClick={() => setAbortOpen(true)}>
              Abort transaction
            </button>
          )}

        </div>
      </div>

      <ConfirmModal
        open={abortOpen}
        title="Abort transaction?"
        message="This will cancel the current weighment and reset the workflow."
        confirmLabel="Abort"
        dangerous
        onCancel={() => setAbortOpen(false)}
        onConfirm={async () => {
          await workflowAPI.abort();
          setAbortOpen(false);
        }}
      />

      <ConfirmModal
        open={createOpen}
        title="Create vehicle profile?"
        message={\`No vehicle record for "\${manualTruck}". Create a minimal vehicle profile?\`}
        confirmLabel="Create & continue"
        onCancel={() => setCreateOpen(false)}
        onConfirm={confirmCreateVehicle}
      />
    </div>
  );
}

function Row({ label, value, mono, bold }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className={\`\${mono ? 'font-mono text-xs' : ''} \${bold ? 'text-white font-semibold' : 'text-slate-200'}\`}>
        {value}
      </span>
    </div>
  );
}

function fmtKg(v) {
  if (v == null || Number.isNaN(v)) return '—';
  return \`\${Number(v).toLocaleString('en-IN')} kg\`;
}
`,
);

write(
  'VehicleManagement.jsx',
  `import React, { useCallback, useEffect, useState } from 'react';
import { vehicleAPI } from '../api/ipc.js';
import Badge from '../components/shared/Badge.jsx';
import { useToast } from '../components/shared/Toast.jsx';

const TYPES = ['truck', 'tanker', 'container'];
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

  function openAdd() {
    setEditing(null);
    setForm(EMPTY);
    setErrors({});
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
    setDrawerOpen(true);
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
      setDrawerOpen(false);
      await load();
    } catch (err) {
      const msg = err.message || 'Save failed';
      if (msg.includes('rfid_tag')) {
        const match = msg.match(/vehicle ([A-Z0-9]+)/i);
        setErrors({
          rfid_tag: match
            ? \`This RFID tag is already assigned to \${match[1]}\`
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
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => (
                <tr
                  key={v.id}
                  className={\`border-b border-slate-800/60 hover:bg-slate-800/30 \${v.status === 'inactive' ? 'opacity-50' : ''}\`}
                >
                  <td className="px-5 py-3 font-medium text-white">{v.vehicle_number}</td>
                  <td className="px-5 py-3 font-mono text-xs text-slate-400">{v.rfid_tag || '—'}</td>
                  <td className="px-5 py-3">{v.owner_name}</td>
                  <td className="px-5 py-3">{v.transporter || '—'}</td>
                  <td className="px-5 py-3 capitalize">{v.vehicle_type}</td>
                  <td className="px-5 py-3">{v.max_capacity ? \`\${v.max_capacity} kg\` : '—'}</td>
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
          <div className="fixed inset-0 z-40 bg-black/50" onClick={() => !saving && setDrawerOpen(false)} />
          <aside className="fixed right-0 top-0 z-50 h-full w-full max-w-md border-l border-slate-800 bg-slate-900 shadow-2xl flex flex-col">
            <motion.div className="border-b border-slate-800 px-5 py-4 flex justify-between items-center">
              <h2 className="font-semibold text-white">{editing ? 'Edit vehicle' : 'Add vehicle'}</h2>
              <button type="button" className="text-slate-400" disabled={saving} onClick={() => setDrawerOpen(false)}>✕</button>
            </div>
            <form onSubmit={handleSubmit} className="flex-1 overflow-auto p-5 space-y-4">
              {errors.form && <p className="text-sm text-red-300">{errors.form}</p>}
              <Field label="Vehicle number *" error={errors.vehicle_number}>
                <input className="field-input" disabled={saving} value={form.vehicle_number} onChange={(e) => setForm({ ...form, vehicle_number: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="RFID tag" error={errors.rfid_tag}>
                <input className="field-input" disabled={saving} value={form.rfid_tag} onChange={(e) => setForm({ ...form, rfid_tag: e.target.value })} />
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
`,
);

// fix motion.div in generated pages
for (const f of fs.readdirSync(root)) {
  if (!f.endsWith('.jsx')) continue;
  const p = path.join(root, f);
  const c = fs.readFileSync(p, 'utf8');
  const n = c.split('motion.div').join('div');
  if (n !== c) fs.writeFileSync(p, n);
}
console.log('done');
