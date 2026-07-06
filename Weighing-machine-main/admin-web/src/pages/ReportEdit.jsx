import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { fmtDate, fmtKg, toDatetimeLocalValue } from '../lib/format.js';

const PHOTO_SLOTS = [1, 2, 3];

const PHOTO_PASSES = [
  {
    pass: 'arrival',
    title: 'Arrival (tare) photos',
    hint: 'Used on tare / arrival side of the report',
    columnPrefix: 'arrival_photo',
  },
  {
    pass: 'departure',
    title: 'Departure (gross) photos',
    hint: 'Used on gross / departure side of the report',
    columnPrefix: 'departure_photo',
  },
];

function photoKey(pass, slot) {
  return `${pass}:${slot}`;
}

function PhotoSlot({
  pass,
  slot,
  title,
  existingUrl,
  previewUrl,
  onFileChange,
  disabled,
}) {
  return (
    <div>
      <label className="text-xs text-slate-500">{title}</label>
      <input
        type="file"
        accept="image/*"
        className="field-input mt-1 text-xs"
        disabled={disabled}
        onChange={(e) => onFileChange(pass, slot, e.target.files?.[0] || null)}
      />
      <div className="mt-2 h-24 rounded border border-slate-700 bg-slate-900/50 overflow-hidden flex items-center justify-center">
        {previewUrl ? (
          <img src={previewUrl} alt={title} className="h-full w-full object-cover" />
        ) : existingUrl ? (
          <img src={existingUrl} alt={title} className="h-full w-full object-cover" />
        ) : (
          <span className="text-[10px] text-slate-500 px-2 text-center">No photo</span>
        )}
      </div>
    </div>
  );
}

export default function ReportEdit() {
  const { slip } = useParams();
  const navigate = useNavigate();
  const [report, setReport] = useState(null);
  const [form, setForm] = useState({});
  const [photos, setPhotos] = useState({});
  const [previews, setPreviews] = useState({});
  const [lists, setLists] = useState({
    materials: [],
    customers: [],
    destinations: [],
    operators: [],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [reportRes, materials, customers, destinations, operators] = await Promise.all([
          api.getReport(slip),
          api.getList('materials'),
          api.getList('customers'),
          api.getList('destinations'),
          api.getList('operators'),
        ]);
        const r = reportRes.report;
        setReport(r);
        setForm({
          gross_weight: r.gross_weight ?? '',
          tare_weight: r.tare_weight ?? '',
          timestamp_in: toDatetimeLocalValue(r.timestamp_in),
          timestamp_out: toDatetimeLocalValue(r.timestamp_out),
          material: r.material || '',
          customer_name: r.customer_name || '',
          destination: r.destination || '',
          operator_name: r.operator_name || '',
        });
        setLists({
          materials: materials.items || [],
          customers: customers.items || [],
          destinations: destinations.items || [],
          operators: operators.items || [],
        });
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [slip]);

  function updateField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function onPhotoFileChange(pass, slot, file) {
    const key = photoKey(pass, slot);
    setPhotos((prev) => {
      const next = { ...prev };
      if (file) next[key] = file;
      else delete next[key];
      return next;
    });
    setPreviews((prev) => {
      const next = { ...prev };
      if (next[key]) URL.revokeObjectURL(next[key]);
      if (file) next[key] = URL.createObjectURL(file);
      else delete next[key];
      return next;
    });
  }

  async function uploadPhoto(pass, slot, file) {
    if (!file) return null;
    const { uploadUrl, key } = await api.getUploadUrl(
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

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const photoS3Keys = [];
      for (const { pass } of PHOTO_PASSES) {
        for (const slot of PHOTO_SLOTS) {
          const file = photos[photoKey(pass, slot)];
          if (file) {
            const uploaded = await uploadPhoto(pass, slot, file);
            if (uploaded) photoS3Keys.push(uploaded);
          }
        }
      }

      const payload = {
        ...form,
        timestamp_in: form.timestamp_in ? new Date(form.timestamp_in).toISOString() : undefined,
        timestamp_out: form.timestamp_out ? new Date(form.timestamp_out).toISOString() : undefined,
        photoS3Keys,
      };

      const result = await api.editReport(slip, payload);
      setMessage(
        `Edit queued for weighbridge PC (command ${result.command?.id?.slice(0, 8)}…). Status: ${result.command?.status}. PDF will regenerate on the PC after sync.`,
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!window.confirm(`Delete report ${slip}? This removes the ticket on the weighbridge PC.`)) {
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await api.deleteReport(slip);
      setMessage(`Delete queued (command ${result.command?.id?.slice(0, 8)}…)`);
      setTimeout(() => navigate('/reports'), 1500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-slate-400">Loading report…</p>;
  if (error && !report) {
    return (
      <div>
        <p className="text-red-400">{error}</p>
        <Link to="/reports" className="text-brand-400 text-sm mt-2 inline-block">
          Back to reports
        </Link>
      </div>
    );
  }

  const pendingPhotoCount = Object.keys(photos).length;

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/reports" className="text-xs text-brand-400 hover:underline">
            ← Reports
          </Link>
          <h2 className="text-xl font-semibold mt-1">Edit report {slip}</h2>
          <p className="text-sm text-slate-400">
            {report?.truck_number} · Net {fmtKg(report?.net_weight)} · Closed{' '}
            {fmtDate(report?.timestamp_out)}
          </p>
        </div>
        {report?.report_url && (
          <a href={report.report_url} target="_blank" rel="noreferrer" className="btn-ghost text-xs">
            Download PDF
          </a>
        )}
      </div>

      <form onSubmit={onSave} className="card p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400">Gross weight (kg)</label>
            <input
              type="number"
              className="field-input mt-1"
              value={form.gross_weight}
              onChange={(e) => updateField('gross_weight', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">Tare weight (kg)</label>
            <input
              type="number"
              className="field-input mt-1"
              value={form.tare_weight}
              onChange={(e) => updateField('tare_weight', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">Arrival time</label>
            <input
              type="datetime-local"
              className="field-input mt-1"
              value={form.timestamp_in}
              onChange={(e) => updateField('timestamp_in', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">Close time</label>
            <input
              type="datetime-local"
              className="field-input mt-1"
              value={form.timestamp_out}
              onChange={(e) => updateField('timestamp_out', e.target.value)}
            />
          </div>
        </div>

        {[
          { key: 'material', label: 'Material', list: lists.materials },
          { key: 'customer_name', label: 'Customer', list: lists.customers },
          { key: 'destination', label: 'Destination', list: lists.destinations },
          { key: 'operator_name', label: 'Operator', list: lists.operators },
        ].map(({ key, label, list }) => (
          <div key={key}>
            <label className="text-xs text-slate-400">{label}</label>
            <input
              className="field-input mt-1"
              list={`${key}-list`}
              value={form[key]}
              onChange={(e) => updateField(key, e.target.value)}
            />
            <datalist id={`${key}-list`}>
              {list.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </div>
        ))}

        <div className="space-y-4 border-t border-slate-800 pt-4">
          <div>
            <p className="text-sm font-medium text-slate-200">Report photos</p>
            <p className="text-xs text-slate-400 mt-1">
              Add or replace missing photos — same as Closed Report Manage on the weighbridge PC.
              {pendingPhotoCount > 0 && (
                <span className="text-brand-300"> {pendingPhotoCount} new photo(s) selected.</span>
              )}
            </p>
          </div>

          {PHOTO_PASSES.map(({ pass, title, hint, columnPrefix }) => (
            <div key={pass} className="space-y-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{title}</p>
                <p className="text-[10px] text-slate-500">{hint}</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {PHOTO_SLOTS.map((slot) => (
                  <PhotoSlot
                    key={photoKey(pass, slot)}
                    pass={pass}
                    slot={slot}
                    title={`Camera ${slot}`}
                    existingUrl={report?.[`${columnPrefix}_${slot}_url`]}
                    previewUrl={previews[photoKey(pass, slot)]}
                    onFileChange={onPhotoFileChange}
                    disabled={saving}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {message && <p className="text-sm text-emerald-400">{message}</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex gap-2 pt-2">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save & regenerate on weighbridge'}
          </button>
          <button type="button" className="btn-danger" disabled={saving} onClick={onDelete}>
            Delete report
          </button>
        </div>
      </form>
    </div>
  );
}
