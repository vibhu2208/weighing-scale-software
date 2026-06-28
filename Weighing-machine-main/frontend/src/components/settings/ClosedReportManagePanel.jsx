import React, { useCallback, useEffect, useState } from 'react';
import { reportAPI, settingsAPI } from '../../api/ipc.js';
import { isHywa } from '../../lib/vehicleTypes.js';

const PHOTO_SLOTS = [
  { slot: 1, label: 'Camera 1' },
  { slot: 2, label: 'Camera 2' },
  { slot: 3, label: 'Camera 3' },
];

const EMPTY_PHOTOS = PHOTO_SLOTS.map(() => ({ imageBase64: '', imageName: '' }));

function toDatetimeLocalValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtKg(kg) {
  if (kg == null || !Number.isFinite(Number(kg))) return '—';
  return `${Number(kg).toLocaleString('en-IN')} kg`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read image file'));
    reader.readAsDataURL(file);
  });
}

function buildEditForm(report) {
  return {
    gross_weight: report?.gross_weight ?? '',
    tare_weight: report?.tare_weight ?? '',
    timestamp_in: toDatetimeLocalValue(report?.timestamp_in),
    timestamp_out: toDatetimeLocalValue(report?.timestamp_out),
    material: report?.material || '',
    customer_name: report?.customer_name || '',
    destination: report?.destination || '',
    operator_name: report?.operator_name || '',
    photos: EMPTY_PHOTOS.map(() => ({ imageBase64: '', imageName: '' })),
  };
}

export default function ClosedReportManagePanel() {
  const [slipQuery, setSlipQuery] = useState('');
  const [recentReports, setRecentReports] = useState([]);
  const [loaded, setLoaded] = useState(null);
  const [form, setForm] = useState(buildEditForm(null));
  const [materials, setMaterials] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [destinations, setDestinations] = useState([]);
  const [operators, setOperators] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const refreshRecent = useCallback(async (search = '') => {
    try {
      const list = await reportAPI.listRecentClosedReports({ search, limit: 40 });
      setRecentReports(Array.isArray(list) ? list : []);
    } catch {
      setRecentReports([]);
    }
  }, []);

  useEffect(() => {
    refreshRecent().catch(() => {});
    Promise.all([
      settingsAPI.getMaterials(),
      settingsAPI.getCustomers(),
      settingsAPI.getDestinations(),
      settingsAPI.getOperators(),
    ])
      .then(([m, c, d, o]) => {
        setMaterials(m || []);
        setCustomers(c || []);
        setDestinations(d || []);
        setOperators(o || []);
      })
      .catch(() => {});
  }, [refreshRecent]);

  async function loadReport(slipNumber) {
    const slip = String(slipNumber || slipQuery).trim();
    if (!slip) {
      setError('Enter a slip / report number');
      return;
    }
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const report = await reportAPI.getClosedReportBySlip(slip);
      setLoaded(report);
      setSlipQuery(report.slip_number || slip);
      setForm(buildEditForm(report));
    } catch (e) {
      setLoaded(null);
      setForm(buildEditForm(null));
      setError(e.message || 'Report not found');
    } finally {
      setBusy(false);
    }
  }

  function updateField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onPhotoChange(slotIndex, e) {
    const file = e.target.files?.[0];
    if (!file) {
      setForm((f) => {
        const photos = [...f.photos];
        photos[slotIndex] = { imageBase64: '', imageName: '' };
        return { ...f, photos };
      });
      return;
    }
    try {
      const imageBase64 = await readFileAsDataUrl(file);
      setForm((f) => {
        const photos = [...f.photos];
        photos[slotIndex] = { imageBase64, imageName: file.name };
        return { ...f, photos };
      });
    } catch (err) {
      setError(err.message || 'Could not read image file');
    }
  }

  async function saveReport() {
    if (!loaded?.slip_number) {
      setError('Load a report first');
      return;
    }
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const manualImages = PHOTO_SLOTS.map((slot, index) => ({
        slot: slot.slot,
        imageBase64: form.photos[index]?.imageBase64 || '',
      })).filter((item) => item.imageBase64);

      const result = await reportAPI.adminUpdateClosedReport({
        slipNumber: loaded.slip_number,
        gross_weight: form.gross_weight,
        tare_weight: form.tare_weight,
        timestamp_in: form.timestamp_in ? new Date(form.timestamp_in).toISOString() : undefined,
        timestamp_out: form.timestamp_out ? new Date(form.timestamp_out).toISOString() : undefined,
        material: form.material.trim(),
        customer_name: form.customer_name.trim(),
        destination: form.destination.trim(),
        operator_name: form.operator_name.trim(),
        manualImages: manualImages.length ? manualImages : undefined,
      });

      if (result?.ok === false) {
        throw new Error(result.error || 'Update failed');
      }

      const txn = result?.transaction || result;
      setLoaded(txn);
      setForm(buildEditForm(txn));
      setSuccess(`Report ${txn.slip_number} updated and PDF regenerated.`);
      await refreshRecent();
    } catch (e) {
      setError(e.message || 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  async function deleteReport() {
    if (!loaded?.slip_number) {
      setError('Load a report first');
      return;
    }
    const ok = window.confirm(
      `Delete report ${loaded.slip_number} (${loaded.truck_number}) permanently?\n\nThis removes the ticket record and PDF from this system.`,
    );
    if (!ok) return;

    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await reportAPI.adminDeleteClosedReport({
        slipNumber: loaded.slip_number,
      });
      if (result?.ok === false) {
        throw new Error(result.error || 'Delete failed');
      }
      setSuccess(`Report ${loaded.slip_number} deleted.`);
      setLoaded(null);
      setForm(buildEditForm(null));
      setSlipQuery('');
      await refreshRecent();
    } catch (e) {
      setError(e.message || 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  const vehicleType = loaded?.vehicle?.vehicle_type || loaded?.vehicle_type;
  const hywa = isHywa(vehicleType);

  return (
    <div className="mt-6 pt-4 border-t border-slate-700/60 space-y-3">
      <div>
        <h3 className="text-xs font-semibold text-white uppercase tracking-wide">
          Edit or delete
        </h3>
        
      </div>

      <div className="flex flex-wrap gap-2 items-end">
        <label className="block text-xs text-slate-400 flex-1 min-w-[180px]">
          Slip / report number
          <input
            type="text"
            className="field-input w-full mt-1 text-sm font-mono"
            value={slipQuery}
            onChange={(e) => setSlipQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadReport()}
            placeholder="e.g. WB0003"
            list="recent-closed-reports"
          />
          <datalist id="recent-closed-reports">
            {recentReports.map((r) => (
              <option key={r.id} value={r.slip_number}>
                {r.truck_number} · {fmtKg(r.net_weight)}
              </option>
            ))}
          </datalist>
        </label>
        <button
          type="button"
          className="btn-ghost text-xs shrink-0"
          disabled={busy}
          onClick={() => loadReport()}
        >
          Load
        </button>
      </div>

      {loaded && (
        <div className="space-y-3 rounded-lg border border-slate-700/60 bg-slate-900/40 p-3">
          <p className="text-xs text-slate-400">
            <span className="font-mono text-white">{loaded.slip_number}</span>
            {' · '}
            {loaded.truck_number}
            {vehicleType ? ` · ${vehicleType}` : ''}
            {' · net '}
            <span className="font-mono text-white">{fmtKg(loaded.net_weight)}</span>
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs text-slate-400">
              {hywa ? 'Gross weight (open) kg' : 'Gross weight (close) kg'}
              <input
                type="number"
                min="1"
                className="field-input w-full mt-1 text-sm"
                value={form.gross_weight}
                onChange={(e) => updateField('gross_weight', e.target.value)}
              />
            </label>
            <label className="block text-xs text-slate-400">
              {hywa ? 'Tare weight (close) kg' : 'Tare weight (open) kg'}
              <input
                type="number"
                min="1"
                className="field-input w-full mt-1 text-sm"
                value={form.tare_weight}
                onChange={(e) => updateField('tare_weight', e.target.value)}
              />
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs text-slate-400">
              {hywa ? 'Gross date & time (open)' : 'Tare date & time (open)'}
              <input
                type="datetime-local"
                step="1"
                className="field-input w-full mt-1 text-sm"
                value={form.timestamp_in}
                onChange={(e) => updateField('timestamp_in', e.target.value)}
              />
            </label>
            <label className="block text-xs text-slate-400">
              {hywa ? 'Tare date & time (close)' : 'Gross date & time (close)'}
              <input
                type="datetime-local"
                step="1"
                className="field-input w-full mt-1 text-sm"
                value={form.timestamp_out}
                onChange={(e) => updateField('timestamp_out', e.target.value)}
              />
            </label>
          </div>

          <EditField label="Material" list={materials} value={form.material} onChange={(v) => updateField('material', v)} />
          <EditField label="Customer" list={customers} value={form.customer_name} onChange={(v) => updateField('customer_name', v)} />
          <EditField label="Destination" list={destinations} value={form.destination} onChange={(v) => updateField('destination', v)} />
          <EditField label="Operator" list={operators} value={form.operator_name} onChange={(v) => updateField('operator_name', v)} />

          <div className="space-y-2">
            <p className="text-xs text-slate-400">Replace departure photos (optional)</p>
            {PHOTO_SLOTS.map((slot, index) => (
              <label key={slot.slot} className="block text-xs text-slate-400">
                {slot.label}
                <input
                  type="file"
                  accept="image/*"
                  className="block w-full mt-1 text-xs text-slate-300 file:mr-2 file:rounded file:border-0 file:bg-slate-700 file:px-2 file:py-1 file:text-xs file:text-white"
                  onChange={(e) => onPhotoChange(index, e)}
                />
                {form.photos[index]?.imageName && (
                  <span className="text-[10px] text-slate-500 mt-1 block">
                    {form.photos[index].imageName}
                  </span>
                )}
              </label>
            ))}
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              className="btn-primary text-sm flex-1 min-w-[140px]"
              disabled={busy}
              onClick={saveReport}
            >
              {busy ? 'Saving…' : 'Save & regenerate report'}
            </button>
            <button
              type="button"
              className="btn-ghost text-sm text-red-400 hover:text-red-300 min-w-[100px]"
              disabled={busy}
              onClick={deleteReport}
            >
              Delete report
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
      {success && <p className="text-xs text-emerald-400">{success}</p>}
    </div>
  );
}

function EditField({ label, list, value, onChange }) {
  const listId = `edit-report-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <label className="block text-xs text-slate-400">
      {label}
      <input
        type="text"
        list={list.length ? listId : undefined}
        className="field-input w-full mt-1 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {list.length > 0 && (
        <datalist id={listId}>
          {list.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      )}
    </label>
  );
}
