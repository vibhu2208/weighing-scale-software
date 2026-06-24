import React from 'react';
import { NavLink } from 'react-router-dom';
import useDeviceStore from '../../store/deviceStore.js';
import StatusDot from '../shared/StatusDot.jsx';

const links = [
  { to: '/', label: 'Dashboard', icon: '⌂' },
  { to: '/weigh', label: 'Weigh', icon: '⚖' },
  { to: '/cameras', label: 'Live Cameras', icon: '▣' },
  { to: '/vehicles', label: 'Vehicles', icon: '⛟' },
  { to: '/reports', label: 'Reports', icon: '▤' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

const navClass = ({ isActive }) =>
  [
    'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition',
    isActive
      ? 'bg-brand-600/25 text-brand-100 border border-brand-600/40'
      : 'text-slate-400 hover:bg-slate-800/80 hover:text-white border border-transparent',
  ].join(' ');

function dotStatus(device) {
  if (!device) return 'disconnected';
  if (device.connected) return 'connected';
  if (device.reconnecting) return 'waiting';
  return 'disconnected';
}

export default function Sidebar() {
  const { rfid, weighbridge, camera } = useDeviceStore();

  return (
    <aside className="fixed left-0 top-0 z-30 flex h-full w-[220px] flex-col border-r border-slate-800 bg-slate-950/95 backdrop-blur">
      <div className="px-4 py-5 border-b border-slate-800">
        <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">
          Weighbridge
        </div>
        <div className="text-lg font-semibold text-white">Manager</div>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {links.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.to === '/'} className={navClass}>
            <span className="text-base w-5 text-center opacity-80">{l.icon}</span>
            <span>{l.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-slate-800 p-4 space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">
          Devices
        </div>
        <div className="flex items-center justify-between text-xs">
          <span>RFID</span>
          <StatusDot status={dotStatus(rfid)} showLabel={false} />
        </div>
        <div className="flex items-center justify-between text-xs">
          <span>Scale</span>
          <StatusDot status={dotStatus(weighbridge)} showLabel={false} />
        </div>
        <div className="flex items-center justify-between text-xs">
          <span>Camera</span>
          <StatusDot status={dotStatus(camera)} showLabel={false} />
        </div>
      </div>
    </aside>
  );
}

