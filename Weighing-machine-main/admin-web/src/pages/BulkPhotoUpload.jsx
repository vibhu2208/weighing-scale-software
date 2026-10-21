import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import JSZip from 'jszip';
import { api } from '../api/client.js';
import Badge from '../components/Badge.jsx';
import { fmtDate, fmtKg, periodToRange, rangeForLocalDate, ymd } from '../lib/format.js';
import { FILL_VEHICLES, samePlate } from '../lib/fillLists.js';
import {
  buildPhotoAssignments,
  defaultShareConfig,
  expandSharedAssignments,
  expectedPhotoSlots,
  filledPhotoCount,
  isOpenTicket,
  parseVehiclePhotoName,
  shareConfigLabel,
  sharedSlotsFor,
  slotCode,
  tripPhotoUrl,
  vehicleLast4,
} from '../lib/bulkVehiclePhotos.js';

const IMAGE_RE = /^image\//;
const DAY_OPTIONS = [
  { v: 'today', l: 'Today' },
  { v: 'tomorrow', l: 'Tomorrow' },
  { v: 'yesterday', l: 'Yesterday' },
  { v: 'last_7_days', l: 'Last 7 days' },
];

function fileId(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function isImageFile(file) {
  return IMAGE_RE.test(file.type || '') || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(file.name);
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

function isWaiting(row) {
  return Boolean(row.release_at) && new Date(row.release_at).getTime() > Date.now();
}

function syncState(row) {
  if (isWaiting(row)) return { key: 'waiting', tone: 'info', label: 'Waiting' };
  if (row.synced_to_local) return { key: 'synced', tone: 'success', label: 'Synced' };
  return { key: 'pending', tone: 'warning', label: 'Pending' };
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    String(a).localeCompare(String(b), 'en-IN'),
  );
}

function dayLabel(day, customDate) {
  if (day === 'custom' && customDate) return customDate;
  return DAY_OPTIONS.find((o) => o.v === day)?.l?.toLowerCase() || day;
}

function zipName(day, customDate) {
  const stamp = day === 'custom' && customDate ? customDate : day;
  return `remote-reports-${stamp}`;
}

const SHARE_STORAGE_KEY = 'wb_bulk_photo_share';
const SHARE_PRESETS = [
  { label: 'Independent', slots: [] },
  { label: '1 = 2', slots: [1, 2] },
  { label: '2 = 3', slots: [2, 3] },
  { label: '1 = 3', slots: [1, 3] },
  { label: 'All three', slots: [1, 2, 3] },
];

function loadShareConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem(SHARE_STORAGE_KEY) || '');
    return {
      arrival: Array.isArray(raw?.arrival) ? raw.arrival.map(Number).filter((n) => n >= 1 && n <= 3) : [],
      departure: Array.isArray(raw?.departure)
        ? raw.departure.map(Number).filter((n) => n >= 1 && n <= 3)
        : [],
    };
  } catch {
    return defaultShareConfig();
  }
}

function saveShareConfig(config) {
  localStorage.setItem(SHARE_STORAGE_KEY, JSON.stringify(config));
}

function sameSlots(a, b) {
  const left = [...(a || [])].sort().join(',');
  const right = [...(b || [])].sort().join(',');
  return left === right;
}

export default function BulkPhotoUpload() {
  const [day, setDay] = useState('today');
  const [customDate, setCustomDate] = useState(ymd());
  const [vehicle, setVehicle] = useState('all');
  const [operator, setOperator] = useState('all');
  const [ticketStatus, setTicketStatus] = useState('all');
  const [syncFilter, setSyncFilter] = useState('all');
  const [photoFilter, setPhotoFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [results, setResults] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipOpen, setZipOpen] = useState(false);
  const [zipVehicles, setZipVehicles] = useState([]);
  const [lightbox, setLightbox] = useState(null);
  const [shareConfig, setShareConfig] = useState(loadShareConfig);
  const [configOpen, setConfigOpen] = useState(false);
  const [draftShare, setDraftShare] = useState(defaultShareConfig);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const range = day === 'custom' ? rangeForLocalDate(customDate) : periodToRange(day);
      const data = await api.getRemoteTrips({ ...range, limit: '500' });
      const fromMs = Date.parse(range.from);
      const toMs = Date.parse(range.to);
      const list = (data.rows || []).filter((row) => {
        const t = new Date(row.timestamp_in || row.created_at).getTime();
        return Number.isFinite(t) && t >= fromMs && t <= toMs;
      });
      setRows(list);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [day, customDate]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    return () => {
      files.forEach((f) => {
        if (f.preview) URL.revokeObjectURL(f.preview);
      });
    };
    // Only revoke on unmount; addFiles/clearFiles revoke replaced URLs themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const vehicles = useMemo(() => {
    const fromTrips = uniqueSorted(rows.map((r) => r.truck_number));
    const extra = fromTrips.filter((plate) => !FILL_VEHICLES.some((v) => samePlate(v, plate)));
    return [...FILL_VEHICLES, ...extra];
  }, [rows]);
  const operators = useMemo(
    () => uniqueSorted(rows.map((r) => r.operator_name)),
    [rows],
  );

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (vehicle !== 'all' && row.truck_number !== vehicle) return false;
      if (operator !== 'all' && row.operator_name !== operator) return false;
      if (ticketStatus !== 'all' && String(row.ticket_status || '').toUpperCase() !== ticketStatus) {
        return false;
      }
      const sync = syncState(row).key;
      if (syncFilter !== 'all' && sync !== syncFilter) return false;
      const slots = expectedPhotoSlots(row);
      const filled = filledPhotoCount(row);
      if (photoFilter === 'missing' && filled >= slots.length) return false;
      if (photoFilter === 'complete' && filled < slots.length) return false;
      if (q) {
        const hay = `${row.slip_number} ${row.truck_number} ${vehicleLast4(row.truck_number)} ${
          row.operator_name || ''
        }`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, vehicle, operator, ticketStatus, syncFilter, photoFilter, search]);

  const assignments = useMemo(
    () => buildPhotoAssignments(files, rows, overrides),
    [files, rows, overrides],
  );
  const expandedAssignments = useMemo(
    () => expandSharedAssignments(assignments, shareConfig),
    [assignments, shareConfig],
  );
  const fileById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const ready = expandedAssignments.filter((a) => a.ready);
  const problemCount = assignments.filter((a) => !a.ready).length;
  const tripIds = [...new Set(ready.map((a) => a.trip.id))];
  const incomingByTrip = useMemo(() => {
    const map = new Map();
    for (const a of ready) {
      const key = `${a.trip.id}:${a.parsed.pass}:${a.parsed.slot}`;
      map.set(key, a);
    }
    return map;
  }, [ready]);

  function pickDay(value) {
    setDay(value);
    setVehicle('all');
    setOperator('all');
    if (value === 'today') setCustomDate(ymd());
    if (value === 'tomorrow') {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      setCustomDate(ymd(d));
    }
    if (value === 'yesterday') {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      setCustomDate(ymd(d));
    }
  }

  function pickCustomDate(value) {
    setCustomDate(value);
    setDay('custom');
    setVehicle('all');
    setOperator('all');
  }

  function addFiles(list) {
    const incoming = Array.from(list || []).filter(isImageFile);
    if (!incoming.length) return;
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.id));
      const next = [...prev];
      for (const file of incoming) {
        const id = fileId(file);
        if (seen.has(id)) continue;
        seen.add(id);
        next.push({
          id,
          name: file.name,
          file,
          preview: URL.createObjectURL(file),
        });
      }
      return next;
    });
    setResults(null);
    setMessage('');
  }

  function removeFile(id) {
    setFiles((prev) => {
      const hit = prev.find((f) => f.id === id);
      if (hit?.preview) URL.revokeObjectURL(hit.preview);
      return prev.filter((f) => f.id !== id);
    });
    setOverrides((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setResults(null);
  }

  function clearFiles() {
    setFiles((prev) => {
      prev.forEach((f) => {
        if (f.preview) URL.revokeObjectURL(f.preview);
      });
      return [];
    });
    setOverrides({});
    setResults(null);
    setMessage('');
    setProgress(null);
  }

  function setTripOverride(fileIdValue, tripId) {
    setOverrides((prev) => ({ ...prev, [fileIdValue]: tripId }));
    setResults(null);
  }

  function openShareConfig() {
    setDraftShare({
      arrival: [...(shareConfig.arrival || [])],
      departure: [...(shareConfig.departure || [])],
    });
    setConfigOpen(true);
  }

  function toggleDraftSlot(pass, slot) {
    setDraftShare((prev) => {
      const current = new Set(prev[pass] || []);
      if (current.has(slot)) current.delete(slot);
      else current.add(slot);
      return { ...prev, [pass]: [...current].sort((a, b) => a - b) };
    });
  }

  function applyShareConfig() {
    const next = {
      arrival: (draftShare.arrival || []).filter((n) => n >= 1 && n <= 3),
      departure: (draftShare.departure || []).filter((n) => n >= 1 && n <= 3),
    };
    setShareConfig(next);
    saveShareConfig(next);
    setConfigOpen(false);
  }

  async function uploadAll() {
    if (!ready.length || busy) return;
    if (
      !window.confirm(
        `Upload ${ready.length} photo(s) onto ${tripIds.length} remote trip(s)? Existing camera slots will be replaced.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    setResults(null);
    setProgress({ done: 0, total: ready.length, name: '' });

    const uploaded = [];
    try {
      await mapPool(ready, 3, async (item) => {
        const entry = fileById.get(item.fileId);
        setProgress((p) => ({
          done: p?.done || 0,
          total: ready.length,
          name: item.name,
        }));
        try {
          const uploadedPhoto = await api.uploadRemoteTripPhoto(
            item.trip.slip_number,
            item.parsed.slot,
            entry.file,
            item.parsed.pass,
          );
          uploaded.push({
            ...item,
            key: uploadedPhoto.key,
            status: 'uploaded',
          });
        } catch (err) {
          uploaded.push({
            ...item,
            status: 'failed',
            error: err.message,
          });
        }
        setProgress((p) => ({
          done: (p?.done || 0) + 1,
          total: ready.length,
          name: item.name,
        }));
      });

      const byTrip = new Map();
      for (const item of uploaded) {
        if (item.status !== 'uploaded' || !item.key) continue;
        if (!byTrip.has(item.trip.id)) byTrip.set(item.trip.id, []);
        byTrip.get(item.trip.id).push({
          slot: item.parsed.slot,
          pass: item.parsed.pass,
          key: item.key,
        });
      }

      for (const [tripId, photoS3Keys] of byTrip.entries()) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await api.attachRemoteTripPhotos(tripId, photoS3Keys);
          for (const item of uploaded) {
            if (item.trip.id === tripId && item.status === 'uploaded') item.status = 'attached';
          }
        } catch (err) {
          for (const item of uploaded) {
            if (item.trip.id === tripId && item.status === 'uploaded') {
              item.status = 'attach-failed';
              item.error = `Uploaded to S3 but not attached: ${err.message}`;
            }
          }
        }
      }

      const attached = uploaded.filter((r) => r.status === 'attached').length;
      const failed = uploaded.filter((r) => r.status !== 'attached').length;
      setResults(uploaded);
      setMessage(
        failed
          ? `Attached ${attached} photo(s); ${failed} failed. The weighbridge PC re-pulls attached photos on the next sync.`
          : `Attached ${attached} photo(s) to ${byTrip.size} trip(s). The weighbridge PC re-pulls them on the next sync.`,
      );
      if (attached) {
        const attachedIds = new Set(
          uploaded.filter((r) => r.status === 'attached').map((r) => r.fileId),
        );
        setFiles((prev) => {
          const keep = [];
          for (const f of prev) {
            if (attachedIds.has(f.id)) {
              if (f.preview) URL.revokeObjectURL(f.preview);
            } else {
              keep.push(f);
            }
          }
          return keep;
        });
        await load();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const zipVehicleOptions = useMemo(() => {
    const extras = uniqueSorted(filteredRows.map((r) => r.truck_number)).filter(
      (plate) => !FILL_VEHICLES.some((v) => samePlate(v, plate)),
    );
    return [...FILL_VEHICLES, ...extras].map((plate) => ({
      plate,
      count: filteredRows.filter((row) => samePlate(row.truck_number, plate)).length,
    }));
  }, [filteredRows]);

  const zipTrips = useMemo(
    () => filteredRows.filter((row) => zipVehicles.some((plate) => samePlate(row.truck_number, plate))),
    [filteredRows, zipVehicles],
  );

  function openZipModal() {
    if (!filteredRows.length || zipBusy) return;
    setZipVehicles(
      zipVehicleOptions.filter((opt) => opt.count > 0).map((opt) => opt.plate),
    );
    setZipOpen(true);
    setError('');
    setMessage('');
  }

  function toggleZipVehicle(plate, checked) {
    setZipVehicles((prev) => {
      if (checked) return prev.includes(plate) ? prev : [...prev, plate];
      return prev.filter((v) => v !== plate);
    });
  }

  async function downloadReportsZip() {
    if (!zipTrips.length || zipBusy) return;
    setZipBusy(true);
    setError('');
    setMessage('');
    setProgress({ done: 0, total: zipTrips.length, name: 'reports zip' });
    try {
      const zip = new JSZip();
      const folderName = zipName(day, customDate);
      const folder = zip.folder(folderName);
      const failed = [];
      await mapPool(zipTrips, 1, async (row) => {
        setProgress((p) => ({
          done: p?.done || 0,
          total: zipTrips.length,
          name: row.slip_number,
        }));
        try {
          const blob = await api.fetchRemoteTripPdfBlob(row.id, { print: 'gross' });
          folder.file(`${row.slip_number}_report.pdf`, blob);
        } catch (err) {
          failed.push(`${row.slip_number}: ${err.message}`);
        }
        setProgress((p) => ({
          done: (p?.done || 0) + 1,
          total: zipTrips.length,
          name: row.slip_number,
        }));
      });
      const ok = zipTrips.length - failed.length;
      if (!ok) {
        throw new Error(failed.join('; ') || 'No reports could be downloaded');
      }
      const packed = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });
      api.saveBlob(packed, `${folderName}.zip`);
      setZipOpen(false);
      setMessage(
        failed.length
          ? `Downloaded ${ok} report(s) in ${folderName}.zip with print date = gross time. ${failed.length} failed: ${failed.join('; ')}`
          : `Downloaded ${ok} report(s) in ${folderName}.zip. Print date on each slip is the gross weigh time.`,
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setZipBusy(false);
      setProgress(null);
    }
  }

  return (
    <div className="space-y-6 max-w-[90rem]">
      <div>
        <h2 className="text-xl font-semibold">Bulk vehicle photos</h2>
        <p className="text-sm text-slate-400 mt-1">
          Drop all vehicle images in one go. Files are matched by filename: last 4 digits of the
          vehicle, a hyphen, then <span className="font-mono text-slate-300">ac1–ac3</span> (arrival)
          or <span className="font-mono text-slate-300">dc1–dc3</span> (departure). Example:{' '}
          <span className="font-mono text-slate-300">8715-ac1.jpg</span>.{' '}
          <Link to="/plan-gaps/fill" className="text-brand-300 hover:underline">
            Fill blocked slips
          </Link>
          {' · '}
          <Link to="/remote-trips" className="text-brand-300 hover:underline">
            Remote trips
          </Link>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {DAY_OPTIONS.map((opt) => (
          <button
            key={opt.v}
            type="button"
            className={day === opt.v ? 'btn-primary' : 'btn-ghost'}
            onClick={() => pickDay(opt.v)}
          >
            {opt.l}
          </button>
        ))}
        <input
          type="date"
          className="field-input w-auto text-xs py-1"
          value={customDate}
          onChange={(e) => pickCustomDate(e.target.value)}
        />
        <button type="button" className="btn-ghost text-xs" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button
          type="button"
          className="btn-ghost text-xs"
          disabled={!filteredRows.length || zipBusy || busy}
          onClick={openZipModal}
        >
          {zipBusy
            ? 'Zipping reports…'
            : `Download ${filteredRows.length} report${filteredRows.length === 1 ? '' : 's'} zip`}
        </button>
        <span className="text-xs text-slate-500">
          {filteredRows.length} of {rows.length} trip{rows.length === 1 ? '' : 's'} ·{' '}
          {dayLabel(day, customDate)}
        </span>
      </div>

      <div className="card p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
        <select
          className="field-input text-sm"
          value={vehicle}
          onChange={(e) => setVehicle(e.target.value)}
        >
          <option value="all">All vehicles</option>
          {vehicles.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select
          className="field-input text-sm"
          value={operator}
          onChange={(e) => setOperator(e.target.value)}
        >
          <option value="all">All operators</option>
          {operators.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <select
          className="field-input text-sm"
          value={ticketStatus}
          onChange={(e) => setTicketStatus(e.target.value)}
        >
          <option value="all">All tickets</option>
          <option value="CLOSED">Closed</option>
          <option value="OPEN">Open</option>
        </select>
        <select
          className="field-input text-sm"
          value={syncFilter}
          onChange={(e) => setSyncFilter(e.target.value)}
        >
          <option value="all">All sync</option>
          <option value="synced">Synced</option>
          <option value="pending">Pending</option>
          <option value="waiting">Waiting</option>
        </select>
        <select
          className="field-input text-sm"
          value={photoFilter}
          onChange={(e) => setPhotoFilter(e.target.value)}
        >
          <option value="all">All photos</option>
          <option value="missing">Missing photos</option>
          <option value="complete">All cameras filled</option>
        </select>
        <input
          className="field-input text-sm"
          placeholder="Search slip, vehicle, last 4…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-800">
              <th className="p-3">Slip</th>
              <th className="p-3">Vehicle</th>
              <th className="p-3">Operator</th>
              <th className="p-3">In / Out</th>
              <th className="p-3">Sync</th>
              <th className="p-3">Photos</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => {
              const slots = expectedPhotoSlots(row);
              const filled = filledPhotoCount(row);
              const sync = syncState(row);
              return (
                <tr key={row.id} className="border-b border-slate-800/60 align-top">
                  <td className="p-3 font-mono text-xs whitespace-nowrap">
                    {row.slip_number}
                    <div className="text-slate-500 mt-1">
                      {isOpenTicket(row.ticket_status) ? 'Open' : 'Closed'}
                    </div>
                  </td>
                  <td className="p-3">
                    {row.truck_number}
                    <div className="text-xs text-slate-500">
                      {vehicleLast4(row.truck_number) || '—'} · {row.vehicle_type || ''}
                    </div>
                    <div className="text-xs text-slate-500">{fmtKg(row.net_weight)}</div>
                  </td>
                  <td className="p-3 text-xs">{row.operator_name || '—'}</td>
                  <td className="p-3 text-xs text-slate-400 whitespace-nowrap">
                    <div>{fmtDate(row.timestamp_in)}</div>
                    <div>
                      {isOpenTicket(row.ticket_status) ? 'Open ticket' : fmtDate(row.timestamp_out)}
                    </div>
                  </td>
                  <td className="p-3">
                    <Badge tone={sync.tone}>{sync.label}</Badge>
                    {isWaiting(row) && (
                      <div className="text-[11px] text-slate-500 mt-1 whitespace-nowrap">
                        until {fmtDate(row.release_at)}
                      </div>
                    )}
                    {row.synced_at && !isWaiting(row) && (
                      <div className="text-[11px] text-slate-500 mt-1 whitespace-nowrap">
                        {fmtDate(row.synced_at)}
                      </div>
                    )}
                  </td>
                  <td className="p-3">
                    <div className="text-[11px] text-slate-500 mb-1">
                      {filled}/{slots.length} cameras
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {slots.map((slot) => {
                        const incoming = incomingByTrip.get(`${row.id}:${slot.pass}:${slot.slot}`);
                        const local = incoming && fileById.get(incoming.fileId);
                        const url = local?.preview || tripPhotoUrl(row, slot.pass, slot.slot);
                        return (
                          <button
                            key={slot.code}
                            type="button"
                            className="text-left"
                            disabled={!url}
                            onClick={() => url && setLightbox({ url, label: `${row.slip_number} ${slot.code.toUpperCase()}` })}
                          >
                            <div className="text-[10px] text-slate-500 mb-0.5 flex items-center gap-1">
                              {slot.code.toUpperCase()}
                              {incoming ? (
                                <span className="text-brand-300">
                                  {incoming.copiedFrom ? 'copy' : 'new'}
                                </span>
                              ) : null}
                            </div>
                            {url ? (
                              <img
                                src={url}
                                alt=""
                                className="h-16 w-[4.5rem] rounded object-cover bg-slate-800 border border-slate-700"
                              />
                            ) : (
                              <div className="h-16 w-[4.5rem] rounded bg-slate-800/80 border border-dashed border-slate-700" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!loading && filteredRows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-slate-500">
                  No remote trips for {dayLabel(day, customDate)}
                  {rows.length ? ' with these filters' : ''}.{' '}
                  <Link to="/plan-gaps/fill" className="text-brand-300 hover:underline">
                    Fill blocked slips
                  </Link>
                  {rows.length ? ' or clear filters.' : ' first.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div
        className={`card p-5 space-y-3 ${dragOver ? 'border-brand-500 bg-brand-900/20' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <label className="btn-primary cursor-pointer">
            Choose images
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          <label className="btn-ghost cursor-pointer">
            Choose folder
            <input
              type="file"
              accept="image/*"
              multiple
              webkitdirectory=""
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={busy}
            onClick={openShareConfig}
          >
            Configuration
          </button>
          {files.length > 0 && (
            <button
              type="button"
              className="btn-ghost text-xs text-red-300 hover:text-red-200"
              onClick={clearFiles}
              disabled={busy}
            >
              Clear all
            </button>
          )}
          <span className="text-xs text-slate-500">
            Drop images here · names like 8715-ac1.jpg / 4968-dc2.jpg
            {' · '}
            {shareConfigLabel(shareConfig)}
          </span>
        </div>
        {!files.length && (
          <p className="text-xs text-slate-500">
            ac = arrival cameras 1–3, dc = departure cameras 1–3. The last 4 digits must match the
            vehicle on a trip in the list above.
          </p>
        )}
      </div>

      {files.length > 0 && (
        <div className="card overflow-x-auto">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-3">
            <p className="text-xs text-slate-400">
              {files.length} selected image{files.length === 1 ? '' : 's'}
              {ready.length !== assignments.filter((a) => a.ready).length
                ? ` · ${ready.length} slot(s) after camera share`
                : ''}
            </p>
            <button
              type="button"
              className="btn-ghost text-xs text-red-300 hover:text-red-200"
              onClick={clearFiles}
              disabled={busy}
            >
              Clear all
            </button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800">
                <th className="p-3">Image</th>
                <th className="p-3">File</th>
                <th className="p-3">Slot</th>
                <th className="p-3">Ticket</th>
                <th className="p-3">Status</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {assignments.map((item) => {
                const entry = fileById.get(item.fileId);
                const parsed = item.parsed || parseVehiclePhotoName(item.name);
                const options = item.matches.length ? item.matches : rows;
                const alsoCodes = parsed
                  ? sharedSlotsFor(parsed.pass, parsed.slot, shareConfig)
                      .filter((slot) => slot !== parsed.slot)
                      .map((slot) => slotCode(parsed.pass, slot).toUpperCase())
                  : [];
                return (
                  <tr key={item.fileId} className="border-b border-slate-800/60 align-top">
                    <td className="p-3">
                      {entry?.preview ? (
                        <img
                          src={entry.preview}
                          alt=""
                          className="h-14 w-20 rounded object-cover bg-slate-800"
                        />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="p-3 font-mono text-xs break-all">{item.name}</td>
                    <td className="p-3 text-xs whitespace-nowrap">
                      {parsed ? (
                        <>
                          <span className="font-mono">{parsed.code.toUpperCase()}</span>
                          <div className="text-slate-500">
                            {parsed.pass} cam {parsed.slot}
                          </div>
                          {item.ready && alsoCodes.length > 0 && (
                            <div className="text-brand-300">also {alsoCodes.join(', ')}</div>
                          )}
                        </>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="p-3">
                      <select
                        className="field-input text-xs py-1 min-w-[11rem]"
                        value={item.trip?.id || ''}
                        disabled={busy || !options.length}
                        onChange={(e) => setTripOverride(item.fileId, e.target.value)}
                      >
                        <option value="">Select trip…</option>
                        {options.map((trip) => (
                          <option key={trip.id} value={trip.id}>
                            {trip.slip_number} · {trip.truck_number}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-3 text-xs space-y-1">
                      {item.ready && (
                        <Badge tone={item.replace ? 'warning' : 'success'}>
                          {item.replace ? 'Replace' : 'Ready'}
                        </Badge>
                      )}
                      {!item.ready && <Badge tone="danger">Fix</Badge>}
                      {item.warning && <p className="text-amber-300">{item.warning}</p>}
                      {item.error && <p className="text-red-300">{item.error}</p>}
                    </td>
                    <td className="p-3">
                      <button
                        type="button"
                        className="text-xs text-slate-400 hover:text-slate-200"
                        disabled={busy}
                        onClick={() => removeFile(item.fileId)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {message && <p className="text-sm text-emerald-400">{message}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {progress && (
        <p className="text-sm text-slate-400">
          {zipBusy ? 'Reports' : 'Uploading'} {progress.done}/{progress.total}
          {progress.name ? ` · ${progress.name}` : ''}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={!ready.length || busy || zipBusy}
          onClick={uploadAll}
        >
          {busy
            ? 'Uploading…'
            : `Upload ${ready.length} photo(s) to ${tripIds.length} trip(s)`}
        </button>
        {problemCount > 0 && (
          <span className="text-xs text-red-300">
            {problemCount} file{problemCount === 1 ? '' : 's'} need a valid name or ticket.
          </span>
        )}
      </div>

      {results && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800">
                <th className="p-3">File</th>
                <th className="p-3">Slip</th>
                <th className="p-3">Slot</th>
                <th className="p-3">Result</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr
                  key={`${r.fileId}:${r.parsed?.pass || ''}:${r.parsed?.slot || ''}`}
                  className="border-b border-slate-800/60"
                >
                  <td className="p-3 font-mono text-xs">{r.name}</td>
                  <td className="p-3 font-mono text-xs">{r.trip?.slip_number}</td>
                  <td className="p-3 text-xs">
                    {r.parsed?.code?.toUpperCase()}
                    {r.copiedFrom ? (
                      <span className="text-slate-500"> · copy of {r.copiedFrom.toUpperCase()}</span>
                    ) : null}
                  </td>
                  <td className="p-3 text-xs">
                    {r.status === 'attached' ? (
                      <span className="text-emerald-400">Attached</span>
                    ) : (
                      <span className="text-red-300">{r.error || r.status}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {zipOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="card max-w-lg w-full p-5 space-y-4 max-h-[90vh] overflow-auto">
            <div>
              <h3 className="text-base font-semibold">Download reports zip</h3>
              <p className="text-xs text-slate-400 mt-1">
                Choose vehicles from the Fill Blocked Slips list. Each slip&apos;s Print Date will be
                the gross weigh time, not the time you download.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() =>
                  setZipVehicles(zipVehicleOptions.filter((opt) => opt.count > 0).map((opt) => opt.plate))
                }
              >
                Select trips on this page
              </button>
              <button type="button" className="btn-ghost text-xs" onClick={() => setZipVehicles([])}>
                Clear
              </button>
            </div>
            <div className="space-y-1 max-h-72 overflow-auto rounded-lg border border-slate-800 p-2">
              {zipVehicleOptions.map((opt, i) => {
                const checked = zipVehicles.some((v) => samePlate(v, opt.plate));
                return (
                  <label
                    key={opt.plate}
                    className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
                      opt.count ? 'hover:bg-slate-800/80' : 'opacity-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!opt.count || zipBusy}
                      onChange={(e) => toggleZipVehicle(opt.plate, e.target.checked)}
                    />
                    <span className="font-mono text-xs">
                      {i + 1}. {opt.plate}
                    </span>
                    <span className="ml-auto text-xs text-slate-500">
                      {opt.count} trip{opt.count === 1 ? '' : 's'}
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-slate-400">
              {zipTrips.length} report{zipTrips.length === 1 ? '' : 's'} · print date = gross time
            </p>
            {progress && zipBusy && (
              <p className="text-sm text-slate-400">
                Reports {progress.done}/{progress.total}
                {progress.name ? ` · ${progress.name}` : ''}
              </p>
            )}
            {error && zipOpen && <p className="text-sm text-red-400">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="btn-ghost"
                disabled={zipBusy}
                onClick={() => setZipOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!zipTrips.length || zipBusy}
                onClick={downloadReportsZip}
              >
                {zipBusy
                  ? 'Zipping…'
                  : `Download ${zipTrips.length} report${zipTrips.length === 1 ? '' : 's'} zip`}
              </button>
            </div>
          </div>
        </div>
      )}

      {configOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="card max-w-lg w-full p-5 space-y-4 max-h-[90vh] overflow-auto">
            <div>
              <h3 className="text-base font-semibold">Camera share</h3>
              <p className="text-xs text-slate-400 mt-1">
                Tick two or three cameras in a group so one uploaded photo fills the others. Arrival
                and departure are configured separately. An explicit file for a slot still wins.
              </p>
            </div>
            {[
              { pass: 'arrival', title: 'Arrival (AC)', prefix: 'AC' },
              { pass: 'departure', title: 'Departure (DC)', prefix: 'DC' },
            ].map((group) => (
              <div key={group.pass} className="space-y-2">
                <p className="text-sm font-medium">{group.title}</p>
                <div className="flex flex-wrap gap-2">
                  {[1, 2, 3].map((slot) => {
                    const checked = (draftShare[group.pass] || []).includes(slot);
                    return (
                      <label
                        key={slot}
                        className={`inline-flex items-center gap-2 rounded border px-3 py-2 text-sm cursor-pointer ${
                          checked
                            ? 'border-brand-500 bg-brand-900/30 text-brand-100'
                            : 'border-slate-700 text-slate-300'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleDraftSlot(group.pass, slot)}
                        />
                        {group.prefix}
                        {slot}
                      </label>
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-2">
                  {SHARE_PRESETS.map((preset) => (
                    <button
                      key={`${group.pass}-${preset.label}`}
                      type="button"
                      className={`text-xs px-2 py-1 rounded border ${
                        sameSlots(draftShare[group.pass], preset.slots)
                          ? 'border-brand-500 text-brand-200'
                          : 'border-slate-700 text-slate-400 hover:text-slate-200'
                      }`}
                      onClick={() =>
                        setDraftShare((prev) => ({ ...prev, [group.pass]: [...preset.slots] }))
                      }
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <p className="text-xs text-slate-400">
              Example: AC1=AC2 means uploading 8715-ac1.jpg also fills AC2. Same for DC.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setConfigOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={applyShareConfig}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {lightbox && (
        <button
          type="button"
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox.url}
            alt={lightbox.label}
            className="max-h-[90vh] max-w-[90vw] rounded object-contain"
          />
        </button>
      )}
    </div>
  );
}
