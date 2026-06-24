import React, { useEffect, useState } from 'react';
import { deviceAPI, subscribe } from '../../api/ipc.js';

export default function RFIDSimButton() {
  const [lastTag, setLastTag] = useState(null);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    return subscribe('device:rfidTag', (payload) => {
      if (payload?.tag) setLastTag(payload.tag);
    });
  }, []);

  const onClick = async () => {
    setBusy(true);
    try {
      await deviceAPI.simulateRFID();
      setFlash(true);
      setTimeout(() => setFlash(false), 400);
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={[
          'btn-ghost w-full transition-colors',
          flash ? 'bg-emerald-500/30 border-emerald-500/50' : '',
        ].join(' ')}
      >
        {busy ? 'Scanning…' : 'Simulate RFID scan'}
      </button>
      {lastTag && (
        <p className="text-[10px] font-mono text-emerald-300/90 truncate" title={lastTag}>
          Last: {lastTag}
        </p>
      )}
    </div>
  );
}
