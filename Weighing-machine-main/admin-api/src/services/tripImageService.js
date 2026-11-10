'use strict';

const { getAdvanceSettings, getList } = require('./settingsService');
const { getRemoteTrip, attachPhotos } = require('./remoteTripService');
const {
  getObjectBuffer,
  putObject,
  remoteTripPhotoKey,
  fillVehicleStillKey,
} = require('./s3Presign');
const { buildTripImagePrompt, DEFAULT_TRIP_IMAGE_PROMPT } = require('./tripImagePrompt');

const PLATE_RE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{3,4}$/;
const CAMERA_FIELDS = {
  arrival: { 1: 'arrival_cam_1', 2: 'arrival_cam_2' },
  departure: { 1: 'departure_cam_1', 2: 'departure_cam_2' },
};

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

function readGeminiImage(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part.inlineData || part.inline_data;
    const data = inline?.data;
    if (!data) continue;
    const buffer = Buffer.from(data, 'base64');
    if (!buffer.length) continue;
    return {
      buffer,
      mimeType: inline.mimeType || inline.mime_type || sniffImage(buffer),
    };
  }
  return null;
}

async function editImageWithGemini({ imageBuffer, mimeType, prompt }) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  const model = (process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image').trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: mimeType || 'image/jpeg',
                  data: imageBuffer.toString('base64'),
                },
              },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
        },
      }),
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error('Gemini image edit timed out');
    }
    throw new Error(`Gemini image edit failed: ${err.message || 'network error'}`);
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = payload?.error?.message || res.statusText || 'request failed';
    if (/free_tier/i.test(msg) && /limit:\s*0/.test(msg)) {
      throw new Error(
        'Gemini image editing is not included on the free tier. Enable billing for this API key in Google AI Studio, then try again.',
      );
    }
    throw new Error(`Gemini image edit failed: ${msg}`);
  }
  const image = readGeminiImage(payload);
  if (!image) {
    const reason = payload?.candidates?.[0]?.finishReason;
    throw new Error(
      reason
        ? `Gemini did not return an image (${reason})`
        : 'Gemini did not return an image',
    );
  }
  return image;
}

async function loadPromptTemplate() {
  const settings = await getAdvanceSettings();
  const stored = String(settings.trip_image_prompt || '').trim();
  return stored || DEFAULT_TRIP_IMAGE_PROMPT;
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

  const template = await loadPromptTemplate();
  const prompt = buildTripImagePrompt({ template, at: when });
  const edited = await editImageWithGemini({
    imageBuffer: source,
    mimeType: sniffImage(source),
    prompt,
  });

  const key = remoteTripPhotoKey(trip.slip_number, slot, pass);
  const contentType = String(edited.mimeType || '').startsWith('image/')
    ? edited.mimeType
    : sniffImage(edited.buffer);
  await putObject(key, edited.buffer, contentType);
  const updated = await attachPhotos(queryFn, id, [{ slot, pass, key }]);
  return { trip: updated, slot, pass, key };
}

module.exports = {
  generateRemoteTripPhoto,
  loadPromptTemplate,
};
