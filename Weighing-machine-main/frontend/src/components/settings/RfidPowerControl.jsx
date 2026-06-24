import React, { useCallback, useEffect, useRef, useState } from 'react';
import { deviceAPI } from '../../api/ipc.js';

const FALLBACK_MIN = 5;
const FALLBACK_MAX = 30;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export default function RfidPowerControl({ mockMode, savedPower, onSaved }) {
  const [minPower, setMinPower] = useState(FALLBACK_MIN);
  const [maxPower, setMaxPower] = useState(FALLBACK_MAX);
  const [power, setPower] = useState(Number(savedPower) || 20);
  const [connected, setConnected] = useState(false);
  const [statusNote, setStatusNote] = useState('');
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef(null);

  const loadPowerInfo = useCallback(async () => {
    try {
      const info = await deviceAPI.getRfidPower();
      const min = Number(info?.minPower) || FALLBACK_MIN;
      const max = Number(info?.maxPower) || FALLBACK_MAX;
      const current =
        Number(info?.currentPower) ||
        Number(info?.savedPower) ||
        Number(savedPower) ||
        20;

      setMinPower(min);
      setMaxPower(max);
      setPower(clamp(current, min, max));
      setConnected(!!info?.connected);

      if (mockMode) {
        setStatusNote('Simulator mode — power is saved but not sent to hardware.');
      } else if (!info?.connected) {
        setStatusNote('Reader offline — value is saved and will apply on next connect.');
      } else if (info?.mock) {
        setStatusNote('Simulator mode — power is saved but not sent to hardware.');
      } else {
        setStatusNote('Higher power = longer read range.');
      }
    } catch (err) {
      setStatusNote(err?.message || 'Could not load RFID power info.');
    }
  }, [mockMode, savedPower]);

  useEffect(() => {
    loadPowerInfo();
  }, [loadPowerInfo]);

  useEffect(() => {
    const next = Number(savedPower);
    if (Number.isFinite(next) && next > 0) {
      setPower((prev) => clamp(next, minPower, maxPower));
    }
  }, [savedPower, minPower, maxPower]);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const applyPower = useCallback(
    (nextRaw) => {
      const next = clamp(nextRaw, minPower, maxPower);
      setPower(next);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        setBusy(true);
        try {
          const result = await deviceAPI.setRfidPower(next);
          if (onSaved) onSaved(String(next));
          if (result?.applied) {
            setConnected(true);
            setStatusNote('Higher power = longer read range.');
          } else if (mockMode || result?.mock) {
            setStatusNote('Simulator mode — power is saved but not sent to hardware.');
          } else if (!result?.ok) {
            setStatusNote(
              result?.error ||
                'Saved for next connect — reader is offline or power could not be applied.',
            );
          } else {
            setStatusNote('Reader offline — value is saved and will apply on next connect.');
          }
        } catch (err) {
          setStatusNote(err?.message || 'Failed to set RFID power.');
        } finally {
          setBusy(false);
        }
      }, 400);
    },
    [minPower, maxPower, mockMode, onSaved],
  );

  const stepDown = () => applyPower(power - 1);
  const stepUp = () => applyPower(power + 1);

  return (
    <div className="block text-sm mb-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-slate-400">RFID read power (dB)</span>
        <span className="font-mono text-slate-200 text-xs">{power} dB</span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className="btn-ghost shrink-0 w-9 h-9 text-lg leading-none"
          onClick={stepDown}
          disabled={busy || power <= minPower}
          aria-label="Decrease RFID power"
        >
          −
        </button>
        <input
          type="range"
          className="flex-1 accent-brand-500"
          min={minPower}
          max={maxPower}
          step={1}
          value={power}
          onChange={(e) => applyPower(Number(e.target.value))}
          disabled={busy}
        />
        <button
          type="button"
          className="btn-ghost shrink-0 w-9 h-9 text-lg leading-none"
          onClick={stepUp}
          disabled={busy || power >= maxPower}
          aria-label="Increase RFID power"
        >
          +
        </button>
      </div>
      <p className="text-[11px] text-slate-500 mt-1.5">{statusNote}</p>
      <p className="text-[10px] text-slate-600 mt-0.5 font-mono">
        Range: {minPower}–{maxPower} dB
        {connected ? ' · reader connected' : ' · reader offline'}
      </p>
    </div>
  );
}
