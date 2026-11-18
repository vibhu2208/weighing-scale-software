import React, { useState } from 'react';
import { api } from '../api/client.js';
import {
  destinationSlotsFor,
  isOpenTicket,
  loadPhotoMapping,
} from '../lib/bulkVehiclePhotos.js';

const JOBS = [
  { pass: 'arrival', slot: 1, label: 'Arrival cam 1', timeField: 'timestamp_in' },
  { pass: 'arrival', slot: 2, label: 'Arrival cam 2', timeField: 'timestamp_in' },
  { pass: 'departure', slot: 1, label: 'Departure cam 1', timeField: 'timestamp_out' },
  { pass: 'departure', slot: 2, label: 'Departure cam 2', timeField: 'timestamp_out' },
];

const STOP_RE =
  /Admin Builder is processing|not in the fill vehicle list|S3 not configured|Missing .+ still|Reference image not found/i;

const PHOTO_COLS = [
  'arrival_photo_1',
  'arrival_photo_2',
  'arrival_photo_3',
  'departure_photo_1',
  'departure_photo_2',
  'departure_photo_3',
];

async function mediaFieldsForTrip(trip) {
  const urlFields = {};
  await Promise.all(
    PHOTO_COLS.map(async (col) => {
      const key = trip?.[col];
      if (!key) return;
      try {
        const signed = await api.presignMedia(key);
        urlFields[`${col}_url`] = signed.url;
        urlFields[`${col}_thumb_url`] = null;
        const thumbKey = String(key).replace(/\.jpe?g$/i, '.thumb.jpg');
        try {
          const thumb = await api.presignMedia(thumbKey);
          urlFields[`${col}_thumb_url`] = thumb.url;
        } catch {
          /* older objects may lack thumbs */
        }
      } catch {
        /* preview optional */
      }
    }),
  );
  return urlFields;
}

export default function CreateTripImagesButton({ trip, disabled, onBusy, onDone, onTripUpdate }) {
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const busy = Boolean(status);

  async function publishTrip(nextTrip) {
    if (!nextTrip?.id) return;
    const urlFields = await mediaFieldsForTrip(nextTrip);
    onTripUpdate?.({ ...nextTrip, ...urlFields, has_photos: true });
  }

  async function applyMappingCopies(result, job, mapping) {
    const sourceKey = result?.key;
    if (!sourceKey || !trip?.slip_number) return result?.trip || null;
    const destinations = destinationSlotsFor(job.pass, job.slot, mapping);
    const photoS3Keys = [{ slot: job.slot, pass: job.pass, key: sourceKey }];
    for (const dest of destinations) {
      if (dest === job.slot) continue;
      if (isOpenTicket(trip.ticket_status) && job.pass === 'departure') continue;
      const copied = await api.copyRemoteTripPhoto(
        sourceKey,
        trip.slip_number,
        dest,
        job.pass,
      );
      if (copied?.key) {
        photoS3Keys.push({ slot: dest, pass: job.pass, key: copied.key });
      }
    }
    if (photoS3Keys.length > 1) {
      const attached = await api.attachRemoteTripPhotos(trip.id, photoS3Keys);
      return attached?.trip || result?.trip || null;
    }
    return result?.trip || null;
  }

  async function run() {
    setNote('');
    onBusy?.(true);
    const notes = [];
    let changed = false;
    let toldDeparture = false;
    const mapping = loadPhotoMapping();
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
          const result = await api.generateRemoteTripPhoto(trip.id, {
            pass: job.pass,
            slot: job.slot,
          });
          // generate-photo already returns signed media URLs on trip.
          if (result?.trip) await publishTrip(result.trip);
          const nextTrip = await applyMappingCopies(result, job, mapping);
          if (nextTrip && nextTrip !== result?.trip) await publishTrip(nextTrip);
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
