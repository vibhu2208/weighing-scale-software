import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import Badge from '../components/Badge.jsx';
import { fmtDate } from '../lib/format.js';

export default function SyncStatus() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.getSyncStatus();
      setData(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const site = data?.site || {};
  const commands = data?.commands || {};

  function commandTone(status) {
    if (status === 'applied') return 'success';
    if (status === 'failed') return 'danger';
    if (status === 'pending') return 'warning';
    return 'default';
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Sync Status</h2>
        <button type="button" className="btn-ghost text-xs" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="card p-4">
          <p className="text-xs text-slate-400">Site</p>
          <p className="font-semibold mt-1">{site.name || site.id || '—'}</p>
          <p className="text-xs text-slate-500 mt-2">ID: {site.id || '—'}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-400">Weighbridge PC last seen</p>
          <p className="font-semibold mt-1">{fmtDate(site.last_seen_at)}</p>
          <p className="text-xs text-slate-500 mt-2">Last push: {fmtDate(site.last_push_at)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-400">Mirrored reports</p>
          <p className="font-semibold mt-1">{data?.mirrorCount ?? 0}</p>
          <p className="text-xs text-slate-500 mt-2">
            Pending {commands.pending ?? 0} · Applied {commands.applied ?? 0} · Failed{' '}
            {commands.failed ?? 0}
          </p>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <h3 className="p-4 pb-2 font-medium text-sm text-slate-300">Recent commands</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-800">
              <th className="p-3">Type</th>
              <th className="p-3">Status</th>
              <th className="p-3">Created</th>
              <th className="p-3">Applied</th>
              <th className="p-3">Error</th>
            </tr>
          </thead>
          <tbody>
            {(data?.recentCommands || []).map((cmd) => (
              <tr key={cmd.id} className="border-b border-slate-800/60">
                <td className="p-3 font-mono text-xs">{cmd.type}</td>
                <td className="p-3">
                  <Badge tone={commandTone(cmd.status)}>{cmd.status}</Badge>
                </td>
                <td className="p-3 text-xs">{fmtDate(cmd.created_at)}</td>
                <td className="p-3 text-xs">{fmtDate(cmd.applied_at)}</td>
                <td className="p-3 text-xs text-red-400">{cmd.error || '—'}</td>
              </tr>
            ))}
            {!loading && !(data?.recentCommands || []).length && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-500">
                  No commands yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
