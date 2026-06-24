import React from 'react';

function DetailRow({ label, value }) {
  if (!value && value !== 0) return null;
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-slate-500 shrink-0">{label}</span>
      <span className="font-mono text-slate-200 text-right break-all">{value}</span>
    </div>
  );
}

export default function RFIDDisplay({ tagId, scan, vehicle }) {
  const scanData = scan || (tagId ? { tag: tagId } : null);

  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-widest text-slate-400">RFID</div>
      {scanData?.tag ? (
        <div className="mt-2 space-y-1.5">
          <DetailRow label="EPC" value={scanData.tag} />
          <DetailRow label="TID" value={scanData.tid} />
          <DetailRow
            label="RSSI"
            value={scanData.rssi != null ? String(scanData.rssi) : null}
          />
          <DetailRow
            label="Antenna"
            value={scanData.antenna != null ? `ANT${scanData.antenna}` : null}
          />
          {vehicle && (
            <div className="mt-2 pt-2 border-t border-slate-700/60 text-xs text-slate-400">
              {vehicle.number || vehicle.vehicle_number}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-1 font-mono text-lg text-slate-500">— waiting —</div>
      )}
    </div>
  );
}
