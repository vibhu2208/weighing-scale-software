import React, { useEffect, useState } from 'react';

const MAP = {
  connected: { color: 'bg-emerald-400', pulse: true, label: 'Connected' },
  waiting: { color: 'bg-amber-400', pulse: false, label: 'Waiting' },
  error: { color: 'bg-red-500', pulse: false, label: 'Error' },
  disconnected: { color: 'bg-slate-500', pulse: false, label: 'Offline' },
};

export default function StatusDot({ status = 'disconnected', showLabel = true }) {
  const cfg = MAP[status] || MAP.disconnected;
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 500);
    return () => clearTimeout(t);
  }, [status]);

  return (
    <span className="inline-flex items-center gap-2 text-xs text-slate-300">
      <span
        className={[
          'h-2 w-2 rounded-full transition-transform',
          cfg.color,
          cfg.pulse ? 'animate-pulse' : '',
          flash ? 'scale-150 ring-2 ring-white/20' : '',
        ].join(' ')}
      />
      {showLabel && <span>{cfg.label}</span>}
    </span>
  );
}
