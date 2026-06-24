import React from 'react';

const VARIANTS = {
  success: 'bg-emerald-500/15 text-emerald-300 border-emerald-600/40',
  warning: 'bg-amber-500/15 text-amber-200 border-amber-600/40',
  danger: 'bg-red-500/15 text-red-300 border-red-600/40',
  info: 'bg-blue-500/15 text-blue-200 border-blue-600/40',
  default: 'bg-slate-700/50 text-slate-300 border-slate-600/50',
};

export default function Badge({ label, variant = 'default', children }) {
  const text = label ?? children;
  return (
    <span
      className={[
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide',
        VARIANTS[variant] || VARIANTS.default,
      ].join(' ')}
    >
      {text}
    </span>
  );
}
