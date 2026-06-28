import React, { useCallback, useEffect, useState } from 'react';
import ClosedReportManagePanel from './ClosedReportManagePanel.jsx';
import { authAPI, deviceAPI, settingsAPI, ticketAPI } from '../../api/ipc.js';
import { isClosableOpenTicket } from '../../lib/ticketStatus.js';
import {
  openTicketFirstWeighKg,
  openTicketFirstWeighLabel,
  resolveAdjustmentPass,
  resolveVehicleType,
} from '../../lib/vehicleTypes.js';

const PHOTO_SLOTS = [
  { slot: 1, label: 'Camera 1', required: true },
  { slot: 2, label: 'Camera 2', required: false },
  { slot: 3, label: 'Camera 3', required: false },
];

const EMPTY_PHOTOS = PHOTO_SLOTS.map(() => ({ imageBase64: '', imageName: '' }));

const EMPTY_FORM = {
  weightKg: '',
  timestampOut: '',
  material: '',
  customer_name: '',
  destination: '',
  operator_name: '',
  photos: EMPTY_PHOTOS,
};

function toDatetimeLocalValue(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtKg(kg) {
  if (kg == null || !Number.isFinite(Number(kg))) return '—';
  return `${Number(kg).toLocaleString('en-IN')} kg`;
}

function closeWeightLabel(vehicleType) {
  const pass = resolveAdjustmentPass({ vehicleType, isClose: true });
  return pass === 'TARE' ? 'Tare' : 'Gross';
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read image file'));
    reader.readAsDataURL(file);
  });
}

export default function ManualHywaClosePanel() {
  const [openTickets, setOpenTickets] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [materials, setMaterials] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [destinations, setDestinations] = useState([]);
  const [operators, setOperators] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [hywaUnlocked, setHywaUnlocked] = useState(false);
  const [hywaPin, setHywaPin] = useState('');
  const [hywaPinError, setHywaPinError] = useState('');

  const refreshTickets = useCallback(async () => {
    const list = await ticketAPI.listOpen();
    const closable = (list || []).filter(isClosableOpenTicket);
    setOpenTickets(closable);
    return closable;
  }, []);

  useEffect(() => {
    refreshTickets().catch(() => setOpenTickets([]));
    authAPI
      .getManualHywaCloseSession()
      .then((session) => setHywaUnlocked(!!session?.active))
      .catch(() => setHywaUnlocked(false));
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
  }, [refreshTickets]);

  const selectedTicket = openTickets.find((t) => t.id === selectedId) || null;

  function selectTicket(ticket) {
    setSelectedId(ticket.id);
    setError('');
    setSuccess('');
    setForm({
      weightKg: '',
      timestampOut: toDatetimeLocalValue(),
      material: ticket.material || '',
      customer_name: ticket.customer_name || '',
      destination: ticket.destination || '',
      operator_name: ticket.operator_name || '',
      photos: EMPTY_PHOTOS.map(() => ({ imageBase64: '', imageName: '' })),
    });
  }

  function updateField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function unlockManualHywa() {
    setHywaPinError('');
    try {
      const result = await authAPI.verifyManualHywaPin(hywaPin);
      if (!result?.ok) {
        setHywaPinError(result?.error || 'Invalid passcode');
        return;
      }
      setHywaUnlocked(true);
      setHywaPin('');
    } catch (e) {
      setHywaPinError(e.message || 'Unlock failed');
    }
  }

  async function lockManualHywa() {
    try {
      await authAPI.lockManualHywaClose();
    } catch (_e) {
      /* ignore */
    }
    setHywaUnlocked(false);
    setHywaPin('');
    setHywaPinError('');
    setSelectedId('');
    setForm(EMPTY_FORM);
    setError('');
    setSuccess('');
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
      setError('');
    } catch (err) {
      setError(err.message || 'Could not read image file');
    }
  }

  async function submitClose() {
    setError('');
    setSuccess('');
    if (!selectedId) {
      setError('Select an open ticket');
      return;
    }
    const vehicleType = resolveVehicleType(selectedTicket?.vehicle, selectedTicket);
    const closeLabel = closeWeightLabel(vehicleType).toLowerCase();
    const weightKg = Number(form.weightKg);
    if (!Number.isFinite(weightKg) || weightKg <= 0) {
      setError(`Enter a valid ${closeLabel} weight (kg)`);
      return;
    }
    if (!form.photos[0]?.imageBase64) {
      setError('Camera 1 photo is required');
      return;
    }
    if (!form.material.trim()) {
      setError('Material is required');
      return;
    }
    if (!form.customer_name.trim()) {
      setError('Customer is required');
      return;
    }
    if (!form.destination.trim()) {
      setError('Destination is required');
      return;
    }
    if (!form.operator_name.trim()) {
      setError('Operator is required');
      return;
    }

    const manualImages = PHOTO_SLOTS.map((slot, index) => ({
      slot: slot.slot,
      imageBase64: form.photos[index]?.imageBase64 || '',
    })).filter((item) => item.imageBase64);

    setBusy(true);
    try {
      const payload = {
        manualHywaClose: true,
        openTicketId: selectedId,
        weightKg,
        timestampOut: form.timestampOut ? new Date(form.timestampOut).toISOString() : undefined,
        manualImages,
        material: form.material.trim(),
        customer_name: form.customer_name.trim(),
        destination: form.destination.trim(),
        operator_name: form.operator_name.trim(),
      };

      let result;
      if (typeof deviceAPI.saveTripCapture === 'function') {
        result = await deviceAPI.saveTripCapture(payload);
        if (result?.ok === false) {
          throw new Error(result.error || 'Close failed');
        }
      } else if (typeof ticketAPI.manualCloseHywa === 'function') {
        result = await ticketAPI.manualCloseHywa(payload);
      } else {
        throw new Error(
          'App needs a full restart — close the Electron window completely, then run npm run dev again.',
        );
      }

      const slip = result?.transaction?.slip_number || result?.tripNumber || 'ticket';
      const net = result?.transaction?.net_weight;
      setSuccess(
        `Closed ${slip}${net != null ? ` — net ${Number(net).toLocaleString('en-IN')} kg` : ''}. Report generated like a normal close.`,
      );
      setSelectedId('');
      setForm(EMPTY_FORM);
      await refreshTickets();
    } catch (e) {
      setError(e.message || 'Close failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 pt-4 border-t border-slate-700/60 space-y-3">
      <div>
        <h3 className="text-xs font-semibold text-white uppercase tracking-wide">
          Manual close
        </h3>
       
      </div>

      {!hywaUnlocked ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 max-w-xs">
            <input
              type="password"
              className="field-input flex-1 text-sm"
              value={hywaPin}
              onChange={(e) => setHywaPin(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && unlockManualHywa()}
              aria-label="Manual HYWA close passcode"
              autoComplete="off"
              spellCheck={false}
              placeholder="Passcode"
            />
            <button type="button" className="btn-ghost text-xs shrink-0" onClick={unlockManualHywa}>
              Unlock
            </button>
          </div>
          {hywaPinError && <p className="text-xs text-red-400">{hywaPinError}</p>}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-emerald-400/90">Unlocked — manual close active</p>
            <button type="button" className="btn-ghost text-xs" onClick={lockManualHywa}>
              Lock section
            </button>
          </div>

      {openTickets.length === 0 ? (
        <p className="text-xs text-slate-500">No open tickets ready to close.</p>
      ) : (
        <label className="block text-xs text-slate-400">
          Open ticket
          <select
            className="field-input w-full mt-1 text-sm"
            value={selectedId}
            onChange={(e) => {
              const id = e.target.value;
              if (!id) {
                setSelectedId('');
                setForm(EMPTY_FORM);
                return;
              }
              const ticket = openTickets.find((t) => t.id === id);
              if (ticket) selectTicket(ticket);
            }}
          >
            <option value="">Select ticket…</option>
            {openTickets.map((t) => {
              const vType = resolveVehicleType(t.vehicle, t);
              const firstLabel = openTicketFirstWeighLabel(vType).toLowerCase();
              const firstKg = openTicketFirstWeighKg(t, vType);
              const typeLabel = vType ? String(vType) : 'vehicle';
              return (
                <option key={t.id} value={t.id}>
                  {t.slip_number} · {t.truck_number} · {typeLabel} · {firstLabel} {fmtKg(firstKg)}
                </option>
              );
            })}
          </select>
        </label>
      )}

      {selectedTicket && (() => {
        const vehicleType = resolveVehicleType(selectedTicket.vehicle, selectedTicket);
        const firstLabel = openTicketFirstWeighLabel(vehicleType);
        const closeLabel = closeWeightLabel(vehicleType);
        const firstKg = openTicketFirstWeighKg(selectedTicket, vehicleType);
        return (
        <div className="space-y-3 rounded-lg border border-slate-700/60 bg-slate-900/40 p-3">
          <p className="text-xs text-slate-400">
            {firstLabel} (open): <span className="text-white font-mono">{fmtKg(firstKg)}</span>
            {vehicleType && (
              <span className="text-slate-500"> · {vehicleType}</span>
            )}
          </p>

          <label className="block text-xs text-slate-400">
            {closeLabel} weight (kg) *
            <input
              type="number"
              min="1"
              step="1"
              className="field-input w-full mt-1 text-sm"
              value={form.weightKg}
              onChange={(e) => updateField('weightKg', e.target.value)}
              placeholder={closeLabel === 'Tare' ? 'Empty truck weight' : 'Loaded truck weight'}
            />
          </label>

          <label className="block text-xs text-slate-400">
            Close date &amp; time *
            <input
              type="datetime-local"
              className="field-input w-full mt-1 text-sm"
              value={form.timestampOut}
              onChange={(e) => updateField('timestampOut', e.target.value)}
            />
          </label>

          <ManualField label="Material *" list={materials} value={form.material} onChange={(v) => updateField('material', v)} />
          <ManualField label="Customer *" list={customers} value={form.customer_name} onChange={(v) => updateField('customer_name', v)} />
          <ManualField label="Destination *" list={destinations} value={form.destination} onChange={(v) => updateField('destination', v)} />
          <ManualField label="Operator *" list={operators} value={form.operator_name} onChange={(v) => updateField('operator_name', v)} />

          <div className="space-y-2">
            <p className="text-xs text-slate-400">Departure photos</p>
            {PHOTO_SLOTS.map((slot, index) => (
              <label key={slot.slot} className="block text-xs text-slate-400">
                {slot.label}
                {slot.required ? ' *' : ' (optional)'}
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

          <button
            type="button"
            className="btn-primary text-sm w-full"
            disabled={busy}
            onClick={submitClose}
          >
            {busy ? 'Closing…' : 'Close ticket & generate report'}
          </button>
        </div>
        );
      })()}

      {error && <p className="text-xs text-red-400">{error}</p>}
      {success && <p className="text-xs text-emerald-400">{success}</p>}

      <ClosedReportManagePanel />
        </>
      )}
    </div>
  );
}

function ManualField({ label, list, value, onChange }) {
  const listId = `manual-hywa-${label.replace(/\W+/g, '-').toLowerCase()}`;
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
