import React, { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import Topbar from './Topbar.jsx';
import { subscribe } from '../../api/ipc.js';

export default function Layout() {
  const [diskFull, setDiskFull] = useState(false);
  const [backupNotice, setBackupNotice] = useState(null);

  useEffect(() => {
    const unsubs = [
      subscribe('backup:diskFull', () => setDiskFull(true)),
      subscribe('backup:complete', (p) => {
        setBackupNotice(`Backup saved (${formatBytes(p?.size)})`);
        setTimeout(() => setBackupNotice(null), 5000);
      }),
      subscribe('backup:failed', () => {
        setBackupNotice('Backup failed — see logs');
        setTimeout(() => setBackupNotice(null), 8000);
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  return (
    <div className="flex h-full w-full bg-slate-950 text-slate-100">
      <Sidebar />
      <div className="ml-[220px] flex min-w-0 flex-1 flex-col">
        {diskFull && (
          <div className="shrink-0 bg-red-700 text-white text-center text-sm font-medium py-2 px-4">
            Disk space low — please free space. Backups and exports may fail until resolved.
          </div>
        )}
        {backupNotice && !diskFull && (
          <div className="shrink-0 bg-emerald-900/80 text-emerald-200 text-center text-xs py-1.5 px-4 border-b border-emerald-800">
            {backupNotice}
          </div>
        )}
        <Topbar />
        <main className="min-h-0 flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function formatBytes(n) {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
