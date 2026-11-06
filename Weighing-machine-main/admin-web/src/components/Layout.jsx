import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { setToken } from '../api/client.js';

const nav = [
  { to: '/reports', label: 'Reports' },
  { to: '/plan-gaps', label: 'Plan Gaps', end: true },
  { to: '/plan-gaps/fill', label: 'Fill Blocked Slips' },
  { to: '/remote-trips', label: 'Remote Trips', end: true },
  { to: '/remote-trips/import', label: 'Bulk Import' },
  { to: '/bulk-photos', label: 'Bulk Photos' },
  { to: '/settings/advance', label: 'Advance Settings' },
  { to: '/sync', label: 'Sync Status' },
];

function initials(label) {
  return String(label || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export default function Layout() {
  const navigate = useNavigate();

  function logout() {
    setToken(null);
    navigate('/login');
  }

  return (
    <div className="min-h-full flex">
      {/* Layout only reserves the collapsed rail; hover expands over the page. */}
      <div className="w-14 shrink-0" aria-hidden="true" />
      <aside
        className="group/nav fixed inset-y-0 left-0 z-30 flex w-14 flex-col border-r border-slate-800 bg-slate-950/95 p-2 shadow-xl shadow-black/40 backdrop-blur transition-[width] duration-200 ease-out hover:w-56 hover:p-4"
      >
        <div className="mb-6 min-h-[2.75rem] overflow-hidden px-1 pt-2 group-hover/nav:mb-8 group-hover/nav:px-0">
          <h1 className="text-sm font-semibold text-brand-300 group-hover/nav:text-lg">
            <span className="group-hover/nav:hidden">WB</span>
            <span className="hidden whitespace-nowrap group-hover/nav:inline">Weighbridge Admin</span>
          </h1>
          <p className="mt-1 hidden text-xs text-slate-500 group-hover/nav:block">Remote management</p>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto overflow-x-hidden">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={item.label}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition-colors group-hover/nav:px-3 ${
                  isActive
                    ? 'bg-brand-600/20 text-brand-300'
                    : 'text-slate-300 hover:bg-slate-800'
                }`
              }
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-800/80 text-[11px] font-semibold tracking-wide text-slate-200 group-hover/nav:hidden">
                {initials(item.label)}
              </span>
              <span className="hidden truncate whitespace-nowrap group-hover/nav:inline">{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <button
          type="button"
          className="btn-ghost mt-4 w-full overflow-hidden px-2 group-hover/nav:px-4"
          onClick={logout}
          title="Log out"
        >
          <span className="group-hover/nav:hidden">LO</span>
          <span className="hidden group-hover/nav:inline">Log out</span>
        </button>
      </aside>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
