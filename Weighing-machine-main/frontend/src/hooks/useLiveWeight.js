import { useEffect, useState } from 'react';
import { subscribe } from '../api/ipc.js';

export default function useLiveWeight() {
  const [kg, setKg] = useState(0);
  const [stability, setStability] = useState('unstable');

  useEffect(() => {
    const unsubWeight = subscribe('device:weightUpdate', (payload) => {
      if (!payload) return;
      setKg(payload.weight ?? 0);
      setStability(payload.isStable ? 'stable' : 'unstable');
    });

    const unsubStable = subscribe('device:stableWeight', (payload) => {
      if (!payload) return;
      setKg(payload.weight ?? 0);
      setStability('stable');
    });

    const unsubZero = subscribe('device:weightZero', () => {
      setKg(0);
      setStability('zero');
    });

    return () => {
      unsubWeight();
      unsubStable();
      unsubZero();
    };
  }, []);

  return { kg, stability };
}
