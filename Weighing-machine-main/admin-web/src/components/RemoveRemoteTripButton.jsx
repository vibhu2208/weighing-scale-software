import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

const CONFIRM_MS = 5000;

/**
 * Inline two-step confirm: Remove → Confirm remove? → DELETE.
 */
export default function RemoveRemoteTripButton({ tripId, disabled = false, onDone, onError }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  function resetArm() {
    clearTimeout(timerRef.current);
    setArmed(false);
  }

  async function handleClick() {
    if (busy || disabled) return;
    if (!armed) {
      setArmed(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setArmed(false), CONFIRM_MS);
      return;
    }

    resetArm();
    setBusy(true);
    try {
      await api.deleteRemoteTrip(tripId);
      onDone?.();
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`mt-1 block text-xs disabled:opacity-50 ${
        armed ? 'text-red-300 font-medium hover:underline' : 'text-red-400/80 hover:underline'
      }`}
      disabled={busy || disabled}
      onClick={handleClick}
    >
      {busy ? 'Removing…' : armed ? 'Confirm remove?' : 'Remove'}
    </button>
  );
}
