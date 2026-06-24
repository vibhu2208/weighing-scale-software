import React, { useEffect, useState } from 'react';
import { settingsAPI } from '../../api/ipc.js';
import RFIDSimButton from './RFIDSimButton.jsx';
import WeightSimSlider from './WeightSimSlider.jsx';
import CameraSimButton from './CameraSimButton.jsx';
import { deviceAPI } from '../../api/ipc.js';

export default function SimulatorPanel({ embedded = false }) {
  const [collapsed, setCollapsed] = useState(false);
  const [devMode, setDevMode] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mock = await settingsAPI.get('USE_MOCK_HARDWARE');
        if (alive) {
          const mockEnabled =
            String(mock).toLowerCase() === 'true' || mock === true;
          setDevMode(mockEnabled);
        }
      } catch {
        if (alive) setDevMode(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!devMode) return null;

  const wrapClass = embedded
    ? 'w-full'
    : 'fixed bottom-4 right-4 z-50 w-72 shadow-2xl';

  const disconnect = (type) => () =>
    deviceAPI.simulateDisconnect(type).catch(console.error);
  const reconnect = (type) => () =>
    deviceAPI.simulateReconnect(type).catch(console.error);

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 shadow-2xl">
      <div className="card border-brand-700/40 overflow-hidden">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="w-full flex items-center justify-between px-3 py-2 bg-slate-900/90 border-b border-slate-800 text-xs font-semibold text-brand-200 uppercase tracking-wider"
        >
          <span>Hardware Simulator</span>
          <span>{collapsed ? '▲' : '▼'}</span>
        </button>

        {!collapsed && (
          <div className="p-3 flex flex-col gap-3 bg-slate-900/95">
            <RFIDSimButton />
            <button
              type="button"
              className="btn-ghost w-full text-[10px]"
              onClick={() => deviceAPI.simulateMultiRFID().catch(console.error)}
            >
              Simulate 3 tags (closest wins)
            </button>
            <WeightSimSlider />
            <CameraSimButton />

            <div className="grid grid-cols-2 gap-1 pt-1 border-t border-slate-800">
              <button
                type="button"
                className="btn-ghost text-[10px] py-1"
                onClick={disconnect('rfid')}
              >
                RFID off
              </button>
              <button
                type="button"
                className="btn-ghost text-[10px] py-1"
                onClick={reconnect('rfid')}
              >
                RFID on
              </button>
              <button
                type="button"
                className="btn-ghost text-[10px] py-1"
                onClick={disconnect('weighbridge')}
              >
                Scale off
              </button>
              <button
                type="button"
                className="btn-ghost text-[10px] py-1"
                onClick={reconnect('weighbridge')}
              >
                Scale on
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
