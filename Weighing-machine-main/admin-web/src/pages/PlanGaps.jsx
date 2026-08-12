import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import Badge from '../components/Badge.jsx';
import { fmtDate } from '../lib/format.js';

const FIRE_EARLY_MS = 5 * 60 * 1000;

function pad(n) {
  return String(n).padStart(2, '0');
}

function toDatetimeLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultSlotTimes(count) {
  const base = new Date();
  base.setDate(base.getDate() + 1);
  base.setHours(9, 0, 0, 0);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(base.getTime() + i * 60 * 60 * 1000);
    return toDatetimeLocal(d);
  });
}

function fireAtIso(plannedAt) {
  if (!plannedAt) return null;
  const d = new Date(plannedAt);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() - FIRE_EARLY_MS).toISOString();
}

function statusTone(status) {
  if (status === 'held') return 'warning';
  if (status === 'used') return 'success';
  if (status === 'scheduled') return 'info';
  if (status === 'missed') return 'danger';
  if (status === 'released') return 'default';
  return 'default';
}

function statusLabel(status) {
  if (status === 'held') return 'blocked';
  if (status === 'used') return 'filled';
  return status;
}

export default function PlanGaps() {
  const [tripCount, setTripCount] = useState(3);
  const [times, setTimes] = useState(() => defaultSlotTimes(3));
  const [note, setNote] = useState('');
  const [hint, setHint] = useState(null);
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({
    scheduled: 0,
    held: 0,
    used: 0,
    released: 0,
    missed: 0,
  });
  const [filter, setFilter] = useState('active');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { limit: '150', status: filter };
      const [listRes, hintRes] = await Promise.all([
        api.getSlipReservations(params),
        api.getSlipReservationHint(),
      ]);
      setRows(listRes.rows || []);
      if (listRes.summary) setSummary(listRes.summary);
      setHint(hintRes.hint || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => {
      load();
    }, 30_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    setTimes((prev) => {
      const n = Math.max(1, Math.min(Number(tripCount) || 1, 50));
      if (prev.length === n) return prev;
      if (prev.length < n) {
        const extra = defaultSlotTimes(n - prev.length).map((t, i) => {
          if (!prev.length) return t;
          const last = new Date(prev[prev.length - 1]);
          if (Number.isNaN(last.getTime())) return t;
          const d = new Date(last.getTime() + (i + 1) * 60 * 60 * 1000);
          return toDatetimeLocal(d);
        });
        return [...prev, ...extra];
      }
      return prev.slice(0, n);
    });
  }, [tripCount]);

  function updateTime(index, value) {
    setTimes((prev) => prev.map((t, i) => (i === index ? value : t)));
  }

  async function onPlan(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const payload = {
        times: times.map((t) => new Date(t).toISOString()),
        note: note.trim() || undefined,
      };
      const res = await api.planSlipReservations(payload);
      setMessage(
        `Scheduled ${res.count} gap(s). Each slip will be blocked automatically 5 minutes before its planned time from the live counter.`,
      );
      setNote('');
      setTripCount(3);
      setTimes(defaultSlotTimes(3));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onFire(id) {
    setError('');
    try {
      const res = await api.fireSlipReservation(id);
      setMessage(`Blocked ${res.row?.slip_number || 'slip'} now.`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function onRelease(id) {
    if (
      !window.confirm(
        'Release this gap? If already blocked, the slip number will stay unused (a hole).',
      )
    ) {
      return;
    }
    setError('');
    try {
      await api.releaseSlipReservation(id);
      setMessage('Reservation released.');
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h2 className="text-xl font-semibold">Plan slip gaps</h2>
        <p className="text-sm text-slate-400 mt-1">
          Schedule remote trip times ahead. The system blocks the <strong className="text-slate-300 font-medium">next live slip</strong>{' '}
          <strong className="text-slate-300 font-medium">5 minutes before</strong> each planned time — not when you schedule.
          Fill blocked slips later from Remote Trips.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          { key: 'scheduled', label: 'Scheduled' },
          { key: 'held', label: 'Blocked (unfilled)' },
          { key: 'used', label: 'Filled' },
          { key: 'missed', label: 'Missed' },
          { key: 'released', label: 'Released' },
        ].map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className="rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-left text-xs"
            onClick={() => setFilter(key)}
          >
            <span className="text-slate-400">{label}</span>
            <span className="ml-2 font-mono text-slate-200">{summary[key] ?? 0}</span>
          </button>
        ))}
      </div>

      <form onSubmit={onPlan} className="card p-5 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h3 className="text-sm font-medium text-slate-200">Schedule gaps for later</h3>
          {hint && (
            <p className="text-xs text-slate-500 font-mono">
              Live next slip (now): <span className="text-slate-300">{hint.next_slip}</span>
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400">Number of remote trips *</label>
            <input
              type="number"
              min={1}
              max={50}
              className="field-input mt-1"
              value={tripCount}
              onChange={(e) => setTripCount(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">Batch note (optional)</label>
            <input
              className="field-input mt-1"
              placeholder="e.g. DCC evening backlog"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs text-slate-400">
            Planned weigh time for each trip (slip assigned at planned time − 5 minutes)
          </p>
          {times.map((time, index) => {
            const fireLocal = (() => {
              const d = new Date(time);
              if (Number.isNaN(d.getTime())) return '—';
              return fmtDate(new Date(d.getTime() - FIRE_EARLY_MS).toISOString());
            })();
            return (
              <div
                key={`slot-${index}`}
                className="grid grid-cols-1 md:grid-cols-[7rem_1fr_1fr] gap-2 items-center"
              >
                <span className="text-xs text-slate-500">Trip {index + 1}</span>
                <input
                  type="datetime-local"
                  className="field-input"
                  required
                  value={time}
                  onChange={(e) => updateTime(index, e.target.value)}
                />
                <span className="text-xs text-slate-500">
                  Auto-block at <span className="text-slate-300">{fireLocal}</span>
                </span>
              </div>
            );
          })}
        </div>

        {message && <p className="text-sm text-emerald-400">{message}</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving
              ? 'Scheduling…'
              : `Schedule ${times.length} gap${times.length === 1 ? '' : 's'}`}
          </button>
          <Link to="/remote-trips" className="btn-ghost">
            Go to Remote Trips
          </Link>
        </div>
      </form>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="text-sm font-medium text-slate-200">Reservations</h3>
          <div className="flex gap-2 items-center">
            <select
              className="field-input text-xs py-1"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="active">Active (scheduled + blocked + missed)</option>
              <option value="scheduled">Scheduled</option>
              <option value="held">Blocked (unfilled)</option>
              <option value="used">Filled</option>
              <option value="missed">Missed</option>
              <option value="released">Released</option>
              <option value="all">All</option>
            </select>
            <button type="button" className="btn-ghost text-xs" onClick={load} disabled={loading}>
              Refresh
            </button>
          </div>
        </div>

        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800">
                <th className="p-3">Planned</th>
                <th className="p-3">Fire at (−5m)</th>
                <th className="p-3">Slip</th>
                <th className="p-3">Status</th>
                <th className="p-3">Blocked at</th>
                <th className="p-3">Note</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-slate-800/60 align-top">
                  <td className="p-3 text-xs">{fmtDate(row.planned_at)}</td>
                  <td className="p-3 text-xs text-slate-400">{fmtDate(fireAtIso(row.planned_at))}</td>
                  <td className="p-3 font-mono text-xs">{row.slip_number || '—'}</td>
                  <td className="p-3">
                    <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
                    {row.fire_error && (
                      <p className="text-[11px] text-red-300/90 mt-1 max-w-[14rem]">{row.fire_error}</p>
                    )}
                  </td>
                  <td className="p-3 text-xs text-slate-500">{fmtDate(row.blocked_at)}</td>
                  <td className="p-3 text-xs text-slate-400">{row.note || '—'}</td>
                  <td className="p-3 text-right">
                    <div className="flex gap-2 justify-end flex-wrap">
                      {(row.status === 'scheduled' || row.status === 'missed') && (
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() => onFire(row.id)}
                        >
                          Block now
                        </button>
                      )}
                      {row.status === 'held' && (
                        <Link
                          className="btn-ghost text-xs"
                          to={`/remote-trips?reservation=${encodeURIComponent(row.id)}`}
                        >
                          Fill
                        </Link>
                      )}
                      {(row.status === 'scheduled' ||
                        row.status === 'held' ||
                        row.status === 'missed') && (
                        <button
                          type="button"
                          className="btn-ghost text-xs text-red-300"
                          onClick={() => onRelease(row.id)}
                        >
                          Release
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-slate-500">
                    No reservations in this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-500">
          Auto-refreshes every 30s. If status is <span className="text-slate-300">missed</span>, the API
          may have been offline during the fire window — use <span className="text-slate-300">Block now</span>{' '}
          to recover. Unused blocked slips stay as holes if never filled.
        </p>
      </div>
    </div>
  );
}
