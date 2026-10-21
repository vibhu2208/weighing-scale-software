import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import Badge from './Badge.jsx';
import { fmtDate, fmtKg } from '../lib/format.js';

const REFRESH_MS = 30_000;

function isOpen(row) {
  return String(row.ticket_status || '').toUpperCase() === 'OPEN';
}

function isWaiting(row) {
  return Boolean(row.release_at) && new Date(row.release_at).getTime() > Date.now();
}

/** When the PC could first import the trip: creation, or the close time for trips held until then. */
function readyAt(row) {
  const created = new Date(row.created_at).getTime();
  const out = isOpen(row) ? NaN : new Date(row.timestamp_out).getTime();
  if (Number.isFinite(out) && Number.isFinite(created) && out > created) return out;
  return created;
}

function fmtDelay(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function syncState(row) {
  if (isWaiting(row)) return { tone: 'info', label: 'Waiting' };
  if (row.synced_to_local) return { tone: 'success', label: 'Synced' };
  return { tone: 'warning', label: 'Pending' };
}

/**
 * Recent remote trips with when the weighbridge PC imported each one.
 * `highlightIds` marks trips created on this page; bump `refreshKey` to reload.
 */
export default function CreatedTripsSync({ highlightIds = [], refreshKey = 0 }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const highlight = new Set(highlightIds);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { limit: '100' };
      if (pendingOnly) params.pending = 'true';
      const data = await api.getRemoteTrips(params);
      setRows(data.rows || []);
      setError('');
      setUpdatedAt(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [pendingOnly]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const sorted = [...rows].sort((a, b) => {
    const ha = highlight.has(a.id) ? 0 : 1;
    const hb = highlight.has(b.id) ? 0 : 1;
    return ha - hb;
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-medium text-slate-200">Created trips and PC sync</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Latest remote trips and when the weighbridge PC imported each one. Trips with a future
            close time show Waiting until then. Auto-refreshes every 30s
            {updatedAt ? ` · updated ${updatedAt.toLocaleTimeString('en-IN')}` : ''}.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <label className="text-xs text-slate-400 flex items-center gap-2">
            <input
              type="checkbox"
              checked={pendingOnly}
              onChange={(e) => setPendingOnly(e.target.checked)}
            />
            Not synced yet only
          </label>
          <button type="button" className="btn-ghost text-xs" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-800">
              <th className="p-3">Slip</th>
              <th className="p-3">Vehicle</th>
              <th className="p-3">Operator</th>
              <th className="p-3">Net</th>
              <th className="p-3">In / Out</th>
              <th className="p-3">Created</th>
              <th className="p-3">Sync</th>
              <th className="p-3">Synced to PC at</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const state = syncState(row);
              const delay = row.synced_at
                ? fmtDelay(new Date(row.synced_at).getTime() - readyAt(row))
                : '';
              return (
                <tr
                  key={row.id}
                  className={`border-b border-slate-800/60 align-top ${
                    highlight.has(row.id) ? 'bg-brand-900/20' : ''
                  }`}
                >
                  <td className="p-3 font-mono text-xs">
                    {row.slip_number}
                    {highlight.has(row.id) && (
                      <span className="ml-2">
                        <Badge tone="info">new</Badge>
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    {row.truck_number}
                    <div className="text-xs text-slate-500">{row.vehicle_type || ''}</div>
                  </td>
                  <td className="p-3 text-xs">{row.operator_name || '—'}</td>
                  <td className="p-3 text-xs whitespace-nowrap">{fmtKg(row.net_weight)}</td>
                  <td className="p-3 text-xs text-slate-400 whitespace-nowrap">
                    <div>{fmtDate(row.timestamp_in)}</div>
                    <div>{isOpen(row) ? 'Open ticket' : fmtDate(row.timestamp_out)}</div>
                  </td>
                  <td className="p-3 text-xs text-slate-400 whitespace-nowrap">
                    {fmtDate(row.created_at)}
                  </td>
                  <td className="p-3">
                    <Badge tone={state.tone}>{state.label}</Badge>
                    {isWaiting(row) && (
                      <div className="text-xs text-slate-500 mt-1 whitespace-nowrap">
                        until {fmtDate(row.release_at)}
                      </div>
                    )}
                  </td>
                  <td className="p-3 text-xs whitespace-nowrap">
                    {row.synced_at ? (
                      <>
                        <div className="text-slate-200">{fmtDate(row.synced_at)}</div>
                        {delay && <div className="text-slate-500">{delay} after ready</div>}
                      </>
                    ) : (
                      <span className="text-slate-500">
                        {row.synced_to_local && !isWaiting(row) ? 'time not recorded' : '—'}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && sorted.length === 0 && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-slate-500">
                  No remote trips to show.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
