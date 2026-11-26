import React, { useState } from 'react';
import { api } from '../api/client.js';
import {
  isOpenTicket,
  loadPhotoMapping,
  resolveMappedPhotoSlots,
  slotCode,
} from '../lib/bulkVehiclePhotos.js';

const JOBS = [
  { pass: 'arrival', slot: 1, label: 'Arrival cam 1', timeField: 'timestamp_in' },
  { pass: 'arrival', slot: 2, label: 'Arrival cam 2', timeField: 'timestamp_in' },
  { pass: 'departure', slot: 1, label: 'Departure cam 1', timeField: 'timestamp_out' },
  { pass: 'departure', slot: 2, label: 'Departure cam 2', timeField: 'timestamp_out' },
];

const STOP_RE =
  /Admin Builder is processing|not in the fill vehicle list|S3 not configured|Missing .+ still|Reference image not found/i;

/** Abort the whole Create-images-for-all run — retrying other trips will not help. */
export const FATAL_CREATE_RE = /Admin Builder is processing|S3 not configured/i;

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

async function publishTrip(trip, onTripUpdate) {
  if (!trip?.id) return;
  const urlFields = await mediaFieldsForTrip(trip);
  onTripUpdate?.({ ...trip, ...urlFields, has_photos: true });
}

/**
 * Place generated cam stills into mapped destination slots only.
 * Example default: AC1 → AC1+AC2, AC2 → AC3 (AC2 slot keeps the AC1 copy).
 */
async function attachMappedPhotos(trip, pass, sourceKeysBySlot, mapping) {
  if (!trip?.id || !trip?.slip_number) {
    throw new Error('Trip is missing an id or slip number');
  }
  if (isOpenTicket(trip.ticket_status) && pass === 'departure') {
    return { trip: null, skipped: true };
  }

  const resolved = resolveMappedPhotoSlots(pass, sourceKeysBySlot, mapping);
  if (!resolved.length) {
    throw new Error(
      `${pass === 'arrival' ? 'Arrival' : 'Departure'} mapping has no destination slots`,
    );
  }

  const photoS3Keys = [];
  const failedSlots = [];
  for (const item of resolved) {
    if (item.slot === item.sourceSlot) {
      photoS3Keys.push({ slot: item.slot, pass, key: item.key });
      continue;
    }
    try {
      const copied = await api.copyRemoteTripPhoto(
        item.key,
        trip.slip_number,
        item.slot,
        pass,
      );
      if (copied?.key) {
        photoS3Keys.push({ slot: item.slot, pass, key: copied.key });
      } else {
        failedSlots.push(slotCode(pass, item.slot).toUpperCase());
      }
    } catch {
      failedSlots.push(slotCode(pass, item.slot).toUpperCase());
    }
  }

  if (failedSlots.length) {
    throw new Error(`Could not copy to ${failedSlots.join(', ')}`);
  }
  if (photoS3Keys.length !== resolved.length) {
    throw new Error('Mapped photo copy incomplete');
  }

  const attached = await api.attachRemoteTripPhotos(trip.id, photoS3Keys);
  if (!attached?.trip) {
    throw new Error('Could not attach mapped photos');
  }
  return { trip: attached.trip, skipped: false };
}

/** Shared by the per-trip button and Create images for all. */
export async function createTripImages(trip, { onStatus, onTripUpdate } = {}) {
  const warnings = [];
  const errors = [];
  let changed = false;
  let stopped = false;
  let toldDeparture = false;
  const mapping = loadPhotoMapping();
  const generated = { arrival: {}, departure: {} };
  let workingTrip = trip;
  const openTicket = isOpenTicket(trip?.ticket_status);

  try {
    for (const job of JOBS) {
      if (openTicket && job.pass === 'departure') {
        if (!toldDeparture) {
          warnings.push('Open ticket — departure photos skipped');
          toldDeparture = true;
        }
        continue;
      }
      if (!workingTrip?.[job.timeField]) {
        if (job.timeField === 'timestamp_out' && !toldDeparture) {
          warnings.push('Departure is waiting for an out time');
          toldDeparture = true;
        }
        if (job.timeField === 'timestamp_in') {
          warnings.push(`${job.label}: this trip has no in time`);
        }
        continue;
      }
      onStatus?.(`${job.label}…`);
      try {
        const result = await api.generateRemoteTripPhoto(workingTrip.id, {
          pass: job.pass,
          slot: job.slot,
          attach: false,
        });
        if (!result?.key) {
          throw new Error('Create images did not return an image key');
        }
        generated[job.pass][job.slot] = result.key;
      } catch (err) {
        const message = err.message || 'Could not create image';
        errors.push(STOP_RE.test(message) ? message : `${job.label}: ${message}`);
        if (STOP_RE.test(message)) {
          stopped = true;
          break;
        }
      }
    }

    if (!stopped) {
      for (const pass of ['arrival', 'departure']) {
        const sourceKeys = generated[pass];
        if (!Object.keys(sourceKeys).length) continue;
        onStatus?.(pass === 'arrival' ? 'Mapping arrival slots…' : 'Mapping departure slots…');
        try {
          const result = await attachMappedPhotos(workingTrip, pass, sourceKeys, mapping);
          if (result?.skipped) {
            warnings.push('Open ticket — departure mapping skipped');
            continue;
          }
          if (result?.trip) {
            workingTrip = result.trip;
            await publishTrip(result.trip, onTripUpdate);
            changed = true;
          }
        } catch (err) {
          const message = err.message || 'Could not attach mapped photos';
          errors.push(
            STOP_RE.test(message)
              ? message
              : `${pass === 'arrival' ? 'Arrival' : 'Departure'} mapping: ${message}`,
          );
          if (STOP_RE.test(message)) {
            stopped = true;
            break;
          }
        }
      }
    }
  } finally {
    onStatus?.('');
  }
  const note = [...errors, ...warnings].join(' · ');
  return { changed, note, warnings, errors, stopped };
}

export default function CreateTripImagesButton({ trip, disabled, onBusy, onDone, onTripUpdate }) {
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const busy = Boolean(status);

  async function run() {
    setNote('');
    onBusy?.(true);
    try {
      const { changed, note: nextNote } = await createTripImages(trip, {
        onStatus: setStatus,
        onTripUpdate,
      });
      setNote(nextNote);
      if (changed) onDone?.();
    } finally {
      onBusy?.(false);
    }
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
