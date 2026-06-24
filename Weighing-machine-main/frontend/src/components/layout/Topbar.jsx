import React, { useEffect, useState } from 'react';
import useDeviceStore from '../../store/deviceStore.js';
import { syncAPI } from '../../api/ipc.js';
import StatusDot from '../shared/StatusDot.jsx';

export default function Topbar() {
  const cloud = useDeviceStore((s) => s.cloud);
  const [now, setNow] = useState(() => new Date());
  const [syncLabel, setSyncLabel] = useState('Sync');

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const q = await syncAPI.getQueueStatus();
        if (!alive) return;
        const pending = (q?.pending || 0) + (q?.retry || 0);
        setSyncLabel(pending > 0 ? `${pending} pending` : 'Synced');
      } catch {
        if (alive) setSyncLabel('Sync offline');
      }
    };
    pull();
    const id = setInterval(pull, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [cloud.pendingCount]);

  const clock = now.toLocaleString('en-IN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <header className="sticky top-0 z-20 h-14 shrink-0 border-b border-slate-800 bg-slate-950/90 backdrop-blur flex items-center px-5 gap-4">
      <h1 className="text-sm font-semibold text-white tracking-wide">
        Weighbridge Management System
      </h1>
      <div className="ml-auto flex items-center gap-4 text-xs text-slate-400">
        <span className="font-mono tabular-nums">{clock}</span>
        <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1">
          <StatusDot
            status={cloud.connected ? 'connected' : 'waiting'}
            showLabel={false}
          />
          <span className="text-slate-300">{syncLabel}</span>
        </span>
      </div>
    </header>
  );
}
