import React from 'react';

export default function ImagePreview({ src }) {
  return (
    <div className="card p-3">
      <div className="text-xs uppercase tracking-widest text-slate-400 px-1 pb-2">
        Capture
      </div>
      <div className="aspect-video w-full rounded-md bg-slate-800 overflow-hidden flex items-center justify-center text-slate-500 text-sm">
        {src ? (
          <img
            src={src}
            alt="Captured vehicle"
            className="h-full w-full object-cover"
          />
        ) : (
          'No capture yet'
        )}
      </div>
    </div>
  );
}
