import { useEffect, useRef, useState } from 'react';

/** Throttle external high-frequency updates for React render (default 250ms). */
export default function useThrottledValue(value, intervalMs = 250) {
  const [throttled, setThrottled] = useState(value);
  const lastEmit = useRef(0);
  const timer = useRef(null);

  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastEmit.current;

    if (elapsed >= intervalMs) {
      lastEmit.current = now;
      setThrottled(value);
      return undefined;
    }

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lastEmit.current = Date.now();
      setThrottled(value);
    }, intervalMs - elapsed);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, intervalMs]);

  return throttled;
}
