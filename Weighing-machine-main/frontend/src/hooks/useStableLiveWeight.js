import { useEffect, useRef, useState } from 'react';

/**
 * Smooth live scale display: throttle updates and ignore brief zero dropouts
 * between STX/ETX frames while a load is still on the bridge.
 */
export default function useStableLiveWeight(value, options = {}) {
  const { throttleMs = 300, zeroHoldMs = 2000 } = options;
  const [displayed, setDisplayed] = useState(() => Math.round(Number(value)) || 0);
  const lastPositiveAt = useRef(0);
  const lastEmitAt = useRef(0);
  const pendingValue = useRef(null);
  const throttleTimer = useRef(null);
  const zeroTimer = useRef(null);

  useEffect(() => {
    const next = Math.round(Number(value));
    const safe = Number.isFinite(next) ? next : 0;

    const clearTimers = () => {
      if (throttleTimer.current) {
        clearTimeout(throttleTimer.current);
        throttleTimer.current = null;
      }
      if (zeroTimer.current) {
        clearTimeout(zeroTimer.current);
        zeroTimer.current = null;
      }
    };

    const commit = (kg) => {
      lastEmitAt.current = Date.now();
      pendingValue.current = null;
      setDisplayed(kg);
    };

    const scheduleCommit = (kg) => {
      pendingValue.current = kg;
      const elapsed = Date.now() - lastEmitAt.current;
      if (elapsed >= throttleMs) {
        commit(kg);
        return;
      }
      if (throttleTimer.current) clearTimeout(throttleTimer.current);
      throttleTimer.current = setTimeout(() => {
        throttleTimer.current = null;
        if (pendingValue.current != null) commit(pendingValue.current);
      }, throttleMs - elapsed);
    };

    if (safe > 0) {
      lastPositiveAt.current = Date.now();
      clearTimers();
      scheduleCommit(safe);
      return clearTimers;
    }

    // Ignore brief zero glitches while weight was recently positive.
    const sincePositive = Date.now() - lastPositiveAt.current;
    if (lastPositiveAt.current > 0 && sincePositive < zeroHoldMs) {
      if (zeroTimer.current) clearTimeout(zeroTimer.current);
      zeroTimer.current = setTimeout(() => {
        zeroTimer.current = null;
        commit(0);
      }, zeroHoldMs - sincePositive);
      return clearTimers;
    }

    clearTimers();
    scheduleCommit(0);
    return clearTimers;
  }, [value, throttleMs, zeroHoldMs]);

  return displayed;
}
