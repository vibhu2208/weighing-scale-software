import React, { useEffect, useRef, useState } from 'react';
import { deviceAPI } from '../../api/ipc.js';
import useLiveWeight from '../../hooks/useLiveWeight.js';

export default function WeightSimSlider() {
  const [kg, setKg] = useState(0);
  const debounceRef = useRef(null);
  const { kg: liveKg, stability } = useLiveWeight();

  const displayKg = liveKg > 0 || kg === 0 ? liveKg : kg;
  const isStable = stability === 'stable' || stability === 'zero';

  const pushWeight = (value) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        await deviceAPI.simulateWeight(value);
      } catch (err) {
        console.error(err);
      }
    }, 300);
  };

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const onChange = (e) => {
    const next = Number(e.target.value);
    setKg(next);
    pushWeight(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between items-center text-xs text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          Weight
          <span
            className={[
              'h-2 w-2 rounded-full',
              isStable ? 'bg-emerald-400' : 'bg-red-500 animate-pulse',
            ].join(' ')}
            title={isStable ? 'Stable' : 'Unstable'}
          />
        </span>
        <span className="font-mono text-slate-200">
          {Number(displayKg).toLocaleString('en-IN')} kg
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={60000}
        step={100}
        value={kg}
        onChange={onChange}
        className="w-full accent-brand-500"
      />
    </div>
  );
}
