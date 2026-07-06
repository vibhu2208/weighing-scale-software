import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { setToken } from '../api/client.js';

const nav = [
  { to: '/reports', label: 'Reports' },
  { to: '/remote-trips', label: 'Remote Trips' },
  { to: '/settings/advance', label: 'Advance Settings' },
  { to: '/sync', label: 'Sync Status' },
];

export default function Layout() {
  const navigate = useNavigate();

  function logout() {
    setToken(null);
    navigate('/login');
  }

  return (
    <div className="min-h-full flex">
      <aside className="w-56 border-r border-slate-800 bg-slate-900/50 p-4 flex flex-col">
        <div className="mb-8">
          <h1 className="text-lg font-semibold text-brand-300">Weighbridge Admin</h1>
          <p className="text-xs text-slate-500 mt-1">Remote management</p>
        </div>
        <nav className="space-y-1 flex-1">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm ${
                  isActive
                    ? 'bg-brand-600/20 text-brand-300'
                    : 'text-slate-300 hover:bg-slate-800'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <button type="button" className="btn-ghost w-full mt-4" onClick={logout}>
          Log out
        </button>
      </aside>
      <main className="flex-1 p-6 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
