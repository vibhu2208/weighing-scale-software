import React, { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './components/layout/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import WeighmentScreen from './pages/WeighmentScreen.jsx';
import VehicleManagement from './pages/VehicleManagement.jsx';
import Reports from './pages/Reports.jsx';
import Settings from './pages/Settings.jsx';
import LiveCameras from './pages/LiveCameras.jsx';
import { isIpcReady, subscribe, deviceAPI } from './api/ipc.js';
import {
  WORKFLOW_CHANNELS,
  DEVICE_CHANNELS,
  queueIpcEvent,
  flushIpcBuffer,
} from './lib/ipcEvents.js';
import useDeviceStore from './store/deviceStore.js';

function IpcMissingBanner() {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950 p-6">
      <div className="max-w-md rounded-xl border border-red-700/50 bg-red-950/40 px-8 py-10 text-center">
        <p className="text-lg font-semibold text-red-200">
          IPC not loaded. Please restart the app.
        </p>
        <p className="mt-2 text-sm text-red-300/80">
          window.electronAPI is undefined — the preload bridge did not load.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [bridgeOk, setBridgeOk] = useState(null);

  useEffect(() => {
    const ok = isIpcReady();
    setBridgeOk(ok);
    if (!ok) return undefined;

    const unsubs = [];

    [...WORKFLOW_CHANNELS, ...DEVICE_CHANNELS].forEach((channel) => {
      unsubs.push(
        subscribe(channel, (payload) => queueIpcEvent(channel, payload)),
      );
    });

    flushIpcBuffer();

    deviceAPI
      .getStatus()
      .then((status) => {
        if (status) useDeviceStore.getState().updateDeviceStatus(status);
      })
      .catch(() => {});

    deviceAPI
      .getRfidDisplayState()
      .then((state) => {
        if (!state?.tag) return;
        if (!state.locked && !state.scanning) return;
        const dev = useDeviceStore.getState();
        dev.setRfidScanning(!!state.scanning);
        dev.setLastRfidScan({
          tag: state.tag,
          tid: state.tid ?? null,
          rssi: state.rssi ?? null,
          antenna: state.antenna ?? null,
          readerName: state.readerName ?? null,
          timestamp: state.timestamp ?? new Date().toISOString(),
          locked: !!state.locked,
        });
      })
      .catch(() => {});

    return () => unsubs.forEach((u) => u());
  }, []);

  if (bridgeOk === false) {
    return <IpcMissingBanner />;
  }

  if (bridgeOk === null) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-950 text-slate-400 text-sm">
        Loading…
      </div>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/weigh" element={<WeighmentScreen />} />
        <Route path="/cameras" element={<LiveCameras />} />
        <Route path="/vehicles" element={<VehicleManagement />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
