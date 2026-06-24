import React from 'react';
import useDeviceStore from '../../store/deviceStore.js';
import StatusDot from '../shared/StatusDot.jsx';

const ROWS = [
  { key: 'rfid', label: 'RFID Reader' },
  { key: 'weighbridge', label: 'Weighbridge' },
  { key: 'externalDisplay', label: 'LED Display' },
  { key: 'camera', label: 'Camera' },
  { key: 'cloud', label: 'Cloud Sync' },
];

function dotFor(key, devices) {
  const d = devices[key];
  if (!d) return 'disconnected';
  if (key === 'cloud') return d.connected ? 'connected' : 'waiting';
  if (key === 'externalDisplay') {
    if (d.enabled === false) return 'disconnected';
    return d.connected ? 'connected' : 'waiting';
  }
  if (d.connected) return 'connected';
  if (d.reconnecting) return 'waiting';
  return 'disconnected';
}

function readerDot(reader) {
  if (reader?.connected) return 'connected';
  if (reader?.reconnecting) return 'waiting';
  return 'disconnected';
}

function formatLastSeen(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '—';
  }
}

function readerLabel(reader) {
  if (reader?.ip) return reader.ip;
  if (reader?.readerId) return reader.readerId;
  return 'Reader';
}

function RfidReaderRows({ readers }) {
  if (!Array.isArray(readers) || readers.length <= 1) return null;

  return (
    <ul className="mt-2 ml-2 space-y-2 border-l border-slate-700/60 pl-3">
      {readers.map((reader) => (
        <li
          key={reader.ip || reader.readerId}
          className="flex items-center justify-between gap-2 text-[11px]"
        >
          <div className="min-w-0">
            <span className="font-mono text-slate-400 truncate block">
              {readerLabel(reader)}
            </span>
            {!reader.connected && reader.lastError && (
              <span
                className="block text-amber-500/90 truncate max-w-[140px]"
                title={reader.lastError}
              >
                {reader.lastError}
              </span>
            )}
          </div>
          <StatusDot status={readerDot(reader)} />
        </li>
      ))}
    </ul>
  );
}

export default function DeviceStatusPanel() {
  const devices = useDeviceStore();

  return (
    <div className="card p-4 h-full">
      <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-3">
        Device Status
      </h2>
      <ul className="space-y-3 text-sm">
        {ROWS.map(({ key, label }) => {
          const dev = devices[key] || {};
          return (
            <li key={key} className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-slate-200">
                  {label}
                  {dev.mode && String(dev.mode).startsWith('Mock') && (
                    <span className="ml-1 text-[10px] text-amber-400/90">(simulator)</span>
                  )}
                  {key === 'rfid' && dev.readerCount > 1 && (
                    <span className="ml-1 text-[10px] text-slate-500">
                      ({dev.connectedReaders ?? 0}/{dev.readerCount} online)
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                  {key === 'weighbridge' && dev.connected && (
                    <span>
                      {Number(dev.currentWeight || 0).toLocaleString('en-IN')} kg
                      {dev.isStable ? ' · stable' : ' · unstable'}
                    </span>
                  )}
                  {key === 'externalDisplay' && (
                    <span>
                      {dev.enabled === false ? 'disabled' : dev.connected ? 'linked' : 'offline'}
                      {dev.port ? ` · ${dev.port}` : ''}
                      {dev.lastRequestedWeight != null && dev.lastRequestedWeight > 0
                        ? ` · send ${Number(dev.lastRequestedWeight).toLocaleString('en-IN')}`
                        : ''}
                      {dev.lastSentWeight != null && dev.lastSentWeight > 0
                        ? ` · ack ${Number(dev.lastSentWeight).toLocaleString('en-IN')} kg`
                        : ''}
                      {dev.lastWriteError
                        ? ` · ERR ${dev.lastWriteError}`
                        : ''}
                    </span>
                  )}
                  {key === 'rfid' && dev.lastScan && (
                    <span className="block max-w-[160px]">
                      <span className="truncate block font-mono">{dev.lastScan.tag}</span>
                      {dev.lastScan.tid && (
                        <span className="truncate block text-slate-600">
                          TID {dev.lastScan.tid}
                        </span>
                      )}
                      {(dev.lastScan.rssi != null || dev.lastScan.antenna != null) && (
                        <span className="block text-slate-600">
                          {dev.lastScan.rssi != null ? `RSSI ${dev.lastScan.rssi}` : ''}
                          {dev.lastScan.rssi != null && dev.lastScan.antenna != null ? ' · ' : ''}
                          {dev.lastScan.antenna != null ? `ANT${dev.lastScan.antenna}` : ''}
                        </span>
                      )}
                    </span>
                  )}
                  {key === 'rfid' && !dev.lastScan && dev.lastTag && (
                    <span className="truncate max-w-[140px] inline-block font-mono">
                      {dev.lastTag}
                    </span>
                  )}
                  {key === 'rfid' && !dev.connected && dev.lastError && (
                    <span className="block max-w-[160px] text-amber-500/90 truncate" title={dev.lastError}>
                      {dev.lastError}
                    </span>
                  )}
                  {key === 'cloud' && (
                    <span>pending: {dev.pendingCount ?? 0}</span>
                  )}
                </div>
                {key === 'rfid' && <RfidReaderRows readers={dev.readers} />}
              </div>
              <div className="text-right shrink-0">
                <StatusDot status={dotFor(key, devices)} />
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {formatLastSeen(dev.lastSeen || dev.lastSync)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
