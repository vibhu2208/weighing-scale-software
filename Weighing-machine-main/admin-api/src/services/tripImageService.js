'use strict';

const sharp = require('sharp');
const { getList } = require('./settingsService');
const { getRemoteTrip, attachPhotos } = require('./remoteTripService');
  const {
  getObjectBuffer,
  putObject,
  newRemoteTripPhotoVersion,
  remoteTripPhotoKey,
  remoteTripPhotoThumbKeyFromKey,
  fillVehicleStillKey,
} = require('./s3Presign');
const { getAdminBuilderWorkspace } = require('./adminBuilderWorkspace');

const PLATE_RE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{3,4}$/;
const CAMERA_FIELDS = {
  arrival: { 1: 'arrival_cam_1', 2: 'arrival_cam_2' },
  departure: { 1: 'departure_cam_1', 2: 'departure_cam_2' },
};
const CAMERA_TIMEZONE = 'Asia/Kolkata';

function compactPlate(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

function findFillVehicle(items, plate) {
  const want = compactPlate(plate);
  for (const raw of items || []) {
    if (raw && typeof raw === 'object') {
      const got = compactPlate(raw.truck_number || raw.plate || raw.vehicle || '');
      if (got && got === want) return raw;
    } else if (compactPlate(raw) === want) {
      return { truck_number: want };
    }
  }
  return null;
}

function sniffImage(buf) {
  if (!buf || buf.length < 12) return 'image/jpeg';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function toDataUrl(buffer, mimeType) {
  const type = String(mimeType || '').startsWith('image/') ? mimeType : sniffImage(buffer);
  return `data:${type};base64,${Buffer.from(buffer).toString('base64')}`;
}

function kolkataDateTimeLocal(date) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) throw new Error('Invalid trip time');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CAMERA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const map = {};
  for (const part of parts) map[part.type] = part.value;
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`;
}

async function encodeTripJpeg(buffer) {
  return sharp(buffer, { failOn: 'error', limitInputPixels: 20_000_000 })
    .rotate()
    .removeAlpha()
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();
}

async function writeTripPhotoThumb(fullKey, body, thumbKey) {
  try {
    const thumb = await sharp(body)
      .rotate()
      .resize({ width: 320, height: 240, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70, mozjpeg: true })
      .toBuffer();
    await putObject(thumbKey || fullKey.replace(/\.jpe?g$/i, '.thumb.jpg'), thumb, 'image/jpeg');
  } catch (err) {
    console.warn('[tripImage] thumb skipped', err.message);
  }
}

async function editImageWithAdminBuilder({ imageBuffer, mimeType, datetimeLocal, operatorEmail }) {
  const workspace = await getAdminBuilderWorkspace();
  let result;
  try {
    result = await workspace.process({
      sourceDataUrl: toDataUrl(imageBuffer, mimeType),
      datetimeLocal,
      timezone: CAMERA_TIMEZONE,
      lamps: [],
      operatorEmail: operatorEmail || null,
    });
  } catch (err) {
    const message = err?.message || 'Admin Builder request failed';
    if (err?.code === 'SERVER_BUSY') {
      throw new Error('Admin Builder is processing other images. Try again in a moment.');
    }
    throw new Error(message);
  }

  if (!result?.output_image_base64) {
    throw new Error('Admin Builder did not return an image');
  }
  if (result.source_sha256 === result.output_sha256) {
    throw new Error('Admin Builder returned an unchanged image');
  }

  const pngBuffer = Buffer.from(result.output_image_base64, 'base64');
  if (!pngBuffer.length) {
    throw new Error('Admin Builder did not return an image');
  }
  const jpegBuffer = await encodeTripJpeg(pngBuffer);
  return {
    buffer: jpegBuffer,
    mimeType: 'image/jpeg',
  };
}

async function generateRemoteTripPhoto(queryFn, id, body = {}) {
  const pass = body.pass === 'arrival' ? 'arrival' : body.pass === 'departure' ? 'departure' : '';
  const slot = Number(body.slot);
  if (!pass || (slot !== 1 && slot !== 2)) {
    throw new Error('pass (arrival|departure) and slot (1 or 2) are required');
  }

  const trip = await getRemoteTrip(queryFn, id);
  if (!trip) throw new Error('Remote trip not found');

  const plate = compactPlate(trip.truck_number);
  if (!PLATE_RE.test(plate)) throw new Error(`Invalid vehicle number ${trip.truck_number || ''}`.trim());

  const when = pass === 'arrival' ? trip.timestamp_in : trip.timestamp_out;
  if (!when) {
    throw new Error(
      pass === 'departure'
        ? 'Departure images are waiting for an out time'
        : 'This trip has no in time',
    );
  }

  const vehicles = await getList('fill_vehicles');
  const vehicle = findFillVehicle(vehicles, plate);
  if (!vehicle) throw new Error(`${plate} is not in the fill vehicle list`);

  const field = CAMERA_FIELDS[pass][slot];
  const expectedKey = fillVehicleStillKey(plate, pass, slot);
  const sourceKey = String(vehicle[field] || '').trim();
  if (!sourceKey) throw new Error(`Missing ${pass} cam ${slot} still for ${plate}`);
  if (sourceKey !== expectedKey) {
    throw new Error(`Missing ${pass} cam ${slot} still for ${plate}`);
  }

  const source = await getObjectBuffer(sourceKey);
  if (!source || !source.length) {
    throw new Error(`Reference image not found for ${pass} cam ${slot}`);
  }

  const edited = await editImageWithAdminBuilder({
    imageBuffer: source,
    mimeType: sniffImage(source),
    datetimeLocal: kolkataDateTimeLocal(when),
    operatorEmail: body.operatorEmail,
  });

  const version = newRemoteTripPhotoVersion();
  const key = remoteTripPhotoKey(trip.slip_number, slot, pass, version);
  const thumbKey = remoteTripPhotoThumbKeyFromKey(key);
  await putObject(key, edited.buffer, 'image/jpeg');
  await writeTripPhotoThumb(key, edited.buffer, thumbKey);
  const updated = await attachPhotos(queryFn, id, [{ slot, pass, key }]);
  return { trip: updated, slot, pass, key };
}

module.exports = {
  generateRemoteTripPhoto,
};
