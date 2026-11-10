import React, { useState } from 'react';
import { api } from '../api/client.js';

const JOBS = [
  { pass: 'arrival', slot: 1, label: 'Arrival cam 1', timeField: 'timestamp_in' },
  { pass: 'arrival', slot: 2, label: 'Arrival cam 2', timeField: 'timestamp_in' },
  { pass: 'departure', slot: 1, label: 'Departure cam 1', timeField: 'timestamp_out' },
  { pass: 'departure', slot: 2, label: 'Departure cam 2', timeField: 'timestamp_out' },
];

const STOP_RE = /GEMINI_API_KEY|not in the fill vehicle list|S3 not configured|free tier|Enable billing/i;

export default function CreateTripImagesButton({ trip, disabled, onBusy, onDone }) {
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const busy = Boolean(status);

  async function run() {
    setNote('');
    onBusy?.(true);
    const notes = [];
    let changed = false;
    let toldDeparture = false;
    try {
      for (const job of JOBS) {
        if (!trip?.[job.timeField]) {
          if (job.timeField === 'timestamp_out' && !toldDeparture) {
            notes.push('Departure is waiting for an out time');
            toldDeparture = true;
          }
          if (job.timeField === 'timestamp_in') {
            notes.push(`${job.label}: this trip has no in time`);
          }
          continue;
        }
        setStatus(`${job.label}…`);
        try {
          await api.generateRemoteTripPhoto(trip.id, { pass: job.pass, slot: job.slot });
          changed = true;
        } catch (err) {
          const message = err.message || 'Could not create image';
          notes.push(STOP_RE.test(message) ? message : `${job.label}: ${message}`);
          if (STOP_RE.test(message)) break;
        }
      }
    } finally {
      setStatus('');
      onBusy?.(false);
    }
    setNote(notes.join(' · '));
    if (changed) onDone?.();
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        className="text-brand-300 hover:underline text-xs disabled:opacity-50 whitespace-nowrap"
        disabled={disabled || busy || !trip?.id}
        onClick={run}
      >
        {busy ? status : 'Create images'}
      </button>
      {note && <div className="text-[10px] text-amber-300 max-w-[16rem]">{note}</div>}
    </div>
  );
}
