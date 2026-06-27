import React, { useCallback, useEffect } from 'react';
import DeviceStatusPanel from '../components/device/DeviceStatusPanel.jsx';
import Badge from '../components/shared/Badge.jsx';
import useTransactionStore from '../store/transactionStore.js';
import { transactionAPI, syncAPI } from '../api/ipc.js';
import { ticketStatusLabel, ticketStatusVariant } from '../lib/ticketStatus.js';

function StatCard({ label, value, sub }) {
  return (
    <div className="card p-5">
      <p className="text-xs uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-white tabular-nums">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

function displayStatus(t) {
  return ticketStatusLabel(t);
}

function displayStatusVariant(t) {
  return ticketStatusVariant(t);
}

function formatTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

const STEPS = [
  { key: 'IDLE', label: 'IDLE' },
  { key: 'RFID', label: 'RFID Detected' },
  { key: 'WEIGH', label: 'Weighing' },
  { key: 'DONE', label: 'Complete' },
];

function stepIndex(state) {
  if (!state || state === 'IDLE') return 0;
  if (state === 'RFID_DETECTED') return 1;
  if (
    [
      'VEHICLE_IDENTIFIED',
      'AWAITING_WEIGHT',
      'WEIGHT_STABLE',
      'IMAGE_CAPTURING',
    ].includes(state)
  ) {
    return 2;
  }
  if (
    ['TRANSACTION_COMPLETE', 'PRINTING', 'SYNC_QUEUED'].includes(state) ||
    state === 'COMPLETE'
  ) {
    return 3;
  }
  return 0;
}

export default function Dashboard() {
  const workflowState = useTransactionStore((s) => s.workflowState);
  const todayStats = useTransactionStore((s) => s.todayStats);
  const recentTransactions = useTransactionStore((s) => s.recentTransactions);
  const setTodayStats = useTransactionStore((s) => s.setTodayStats);
  const setRecentTransactions = useTransactionStore((s) => s.setRecentTransactions);
  const [pendingSync, setPendingSync] = React.useState(0);

  const load = useCallback(async () => {
    try {
      const [stats, rows, queue] = await Promise.all([
        transactionAPI.getTodayStats(),
        transactionAPI.getAll(),
        syncAPI.getQueueStatus(),
      ]);
      setTodayStats(stats || { total: 0, pending: 0, completed: 0, totalWeight: 0 });
      setRecentTransactions((rows || []).slice(0, 20));
      setPendingSync((queue?.pending || 0) + (queue?.retry || 0));
    } catch (e) {
      console.error(e);
    }
  }, [setTodayStats, setRecentTransactions]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const activeStep = stepIndex(workflowState);
  const tableRows = recentTransactions.slice(0, 10);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-400">Live operations overview</p>
      </header>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Today's Transactions" value={todayStats.total ?? 0} />
        <StatCard label="Completed" value={todayStats.completed ?? 0} />
        <StatCard label="Pending Sync" value={pendingSync} />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <DeviceStatusPanel />
        </div>
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="border-b border-slate-800 px-5 py-4">
            <h2 className="text-sm font-semibold text-white">Recent transactions</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-3">Slip No</th>
                  <th className="px-5 py-3">Truck</th>
                  <th className="px-5 py-3">Net Weight</th>
                  <th className="px-5 py-3">Time</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-8 text-center text-slate-500">
                      No transactions yet
                    </td>
                  </tr>
                ) : (
                  tableRows.map((t) => (
                    <tr
                      key={t.id}
                      className="border-b border-slate-800/60 hover:bg-slate-800/30"
                    >
                      <td className="px-5 py-3 font-mono text-slate-200">
                        {t.slip_number || '—'}
                      </td>
                      <td className="px-5 py-3 text-white">{t.truck_number}</td>
                      <td className="px-5 py-3 text-slate-300">
                        {t.net_weight != null
                          ? `${Number(t.net_weight).toLocaleString('en-IN')} kg`
                          : '—'}
                      </td>
                      <td className="px-5 py-3 text-slate-400 whitespace-nowrap">
                        {formatTime(t.timestamp_in)}
                      </td>
                      <td className="px-5 py-3">
                        <Badge
                          label={displayStatus(t)}
                          variant={displayStatusVariant(t)}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="text-sm font-semibold text-white mb-4">Workflow state</h2>
        <ol className="flex flex-wrap items-center gap-2 md:gap-4">
          {STEPS.map((step, i) => {
            const active = i === activeStep;
            const done = i < activeStep;
            return (
              <li key={step.key} className="flex items-center gap-2">
                <span
                  className={[
                    'flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold border',
                    active
                      ? 'border-brand-400 bg-brand-600/30 text-brand-100 animate-pulse'
                      : done
                        ? 'border-emerald-600/50 bg-emerald-900/40 text-emerald-300'
                        : 'border-slate-700 bg-slate-800 text-slate-500',
                  ].join(' ')}
                >
                  {i + 1}
                </span>
                <span
                  className={
                    active ? 'text-brand-200 font-medium' : 'text-slate-400 text-sm'
                  }
                >
                  {step.label}
                </span>
                {i < STEPS.length - 1 && (
                  <span className="hidden md:inline text-slate-600 mx-1">→</span>
                )}
              </li>
            );
          })}
        </ol>
        <p className="mt-3 text-xs font-mono text-slate-500">Engine: {workflowState}</p>
      </section>
    </div>
  );
}
