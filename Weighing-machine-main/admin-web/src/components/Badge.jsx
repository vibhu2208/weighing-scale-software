export default function Badge({ children, tone = 'default' }) {
  const tones = {
    default: 'bg-slate-800 text-slate-200',
    success: 'bg-emerald-900/60 text-emerald-300',
    warning: 'bg-amber-900/60 text-amber-300',
    danger: 'bg-red-900/60 text-red-300',
    info: 'bg-brand-900/60 text-brand-300',
  };
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone] || tones.default}`}
    >
      {children}
    </span>
  );
}
