import React, { useState } from 'react';
import { deviceAPI } from '../../api/ipc.js';
import { resolveMediaSrc } from '../../lib/resolveMediaSrc.js';

export default function CameraSimButton() {
  const [thumb, setThumb] = useState(null);
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    setBusy(true);
    try {
      const result = await deviceAPI.simulateCamera();
      const path = result?.imagePath || result;
      if (path) {
        setThumb(await resolveMediaSrc(path));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="btn-ghost w-full"
      >
        {busy ? 'Capturing…' : 'Simulate camera capture'}
      </button>
      {thumb && (
        <div className="rounded-md overflow-hidden border border-slate-700 bg-slate-800">
          <img
            src={thumb}
            alt="Last capture"
            className="w-full h-20 object-cover"
          />
          <p className="text-[9px] text-slate-500 p-1 truncate" title={thumb}>
            Saved
          </p>
        </div>
      )}
    </div>
  );
}
