import { useCallback, useEffect, useState } from 'react';
import { deviceAPI, subscribe } from '../api/ipc.js';

const EMPTY = {
  rfid: { connected: false, lastSeen: null },
  weighbridge: { connected: false, currentWeight: 0, isStable: false, lastSeen: null },
  camera: { connected: false, lastSeen: null },
  cloud: { connected: false, pendingCount: 0, lastSync: null },
};

function dotStatus(device) {
  if (!device) return 'disconnected';
  if (device.connected) return 'connected';
  if (device.error || device.critical) return 'error';
  if (device.reconnecting) return 'waiting';
  return 'disconnected';
}

export function deviceToDotMap(status) {
  return {
    rfid: dotStatus(status?.rfid),
    weighbridge: dotStatus(status?.weighbridge),
    camera: dotStatus(status?.camera),
    cloud: status?.cloud?.connected ? 'connected' : 'disconnected',
  };
}

export default function useDeviceStatus(pollMs = 2000) {
  const [status, setStatus] = useState(EMPTY);
  const [dots, setDots] = useState(deviceToDotMap(EMPTY));

  const applyStatus = useCallback((next) => {
    if (!next || typeof next !== 'object') return;
    setStatus(next);
    setDots(deviceToDotMap(next));
  }, []);

  useEffect(() => {
    let alive = true;

    const pull = async () => {
      try {
        const next = await deviceAPI.getStatus();
        if (alive) applyStatus(next);
      } catch (_e) {
        /* ignore */
      }
    };

    pull();
    const id = setInterval(pull, pollMs);

    const unsubStatus = subscribe('device:statusUpdate', (payload) => {
      if (alive) applyStatus(payload);
    });

    return () => {
      alive = false;
      clearInterval(id);
      unsubStatus();
    };
  }, [pollMs, applyStatus]);

  return { status, dots, applyStatus };
}
