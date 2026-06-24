import React from 'react';

export default function LiveWeightDisplay({ kg = 0, stability = 'unstable' }) {
  return (
    <div className="card p-6 flex flex-col items-center justify-center">
      <div className="text-xs uppercase tracking-widest text-slate-400">
        Live Weight
      </div>
      <div className="font-mono text-6xl font-bold text-white mt-2">
        {Number(kg).toFixed(0)}<span className="text-2xl text-slate-400 ml-2">kg</span>
      </div>
      <div className="mt-2 text-xs text-slate-400">Stability: {stability}</div>
    </div>
  );
}
