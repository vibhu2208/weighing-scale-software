'use strict';

const NIGHT_LIGHTING_RULE =
  '5. Adjust the lighting strictly according to the requested date and time. Nighttime must be realistically dark, without introducing artificial light sources.';

const DAY_LIGHTING_RULE =
  '5. Adjust the lighting strictly according to the requested date and time. Daytime must look like natural daylight on the original low-quality CCTV image, without beautifying the scene or adding light sources.';

const NIGHT_ENVIRONMENT =
  'The environment must appear genuinely dark, consistent with nighttime CCTV footage. Do not simulate sunrise, dawn, or brightly illuminated ground.';

const DAY_ENVIRONMENT =
  'The environment must appear as genuine daytime CCTV footage under natural daylight. Keep the original dull, low-resolution look. Do not beautify the image or simulate sunrise or sunset.';

const DEFAULT_TRIP_IMAGE_PROMPT = `Edit the attached original weighbridge image according to all KAATA KARO master project instructions.

**Required changes:**

1. Remove all people from the image.
2. Remove every vehicle except the truck positioned on the weighing scale.
3. Make the truck's number plate completely unreadable using natural mud and dirt.
4. Make the ground almost completely dry while retaining all original garbage, stones, tyre marks, stains, surface irregularities, and debris.
5. Adjust the lighting strictly according to the requested date and time. Nighttime must be realistically dark, without introducing artificial light sources.
6. Preserve the truck's original design, colour, cabin, container, dimensions, headlights, wheel count, and position.
7. Preserve the raised weighbridge, its actual elevation, edges, and the yellow rod/bar associated with the ramp.
8. Preserve the same surrounding structures, background, camera angle, original resolution, and low-quality CCTV appearance.
9. Make no additional modifications beyond those explicitly specified above.

The environment must appear genuinely dark, consistent with nighttime CCTV footage. Do not simulate sunrise, dawn, or brightly illuminated ground.

Preserve the original timestamp's font, size, position, spacing, and low-resolution appearance. Ensure no timestamp characters are clipped.

**Most important:** Do not recreate or beautify the image. Make only localized, necessary edits to the original. Maintain the original truck, elevated weighing ramp, yellow rod, dirty environment, and CCTV image quality as faithfully as possible.

Internally compare the completed image against the source and check every relevant preservation requirement before returning the image.

**Timestamp to display:**

{{TIMESTAMP}}`;

function kolkataParts(date) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) throw new Error('Invalid trip time');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const map = {};
  for (const part of parts) map[part.type] = part.value;
  return map;
}

function formatCctvTimestamp(date) {
  const map = kolkataParts(date);
  const hour = String(map.hour || '').padStart(2, '0');
  const minute = String(map.minute || '').padStart(2, '0');
  const second = String(map.second || '').padStart(2, '0');
  return `${Number(map.day)}/${Number(map.month)}/${map.year} ${hour}:${minute}:${second}`;
}

function isNightInKolkata(date) {
  const hour = Number(kolkataParts(date).hour);
  return hour >= 18 || hour < 6;
}

function buildTripImagePrompt({ template, at } = {}) {
  const source = String(template || '').trim() || DEFAULT_TRIP_IMAGE_PROMPT;
  const stamp = formatCctvTimestamp(at);
  let text = source;
  if (!isNightInKolkata(at)) {
    text = text.replaceAll(NIGHT_LIGHTING_RULE, DAY_LIGHTING_RULE);
    text = text.replaceAll(NIGHT_ENVIRONMENT, DAY_ENVIRONMENT);
  }
  text = text.replaceAll('{{TIMESTAMP}}', stamp);
  text = text.replace(/(\*\*Timestamp to display:\*\*\s*\n+)[^\n]+/g, `$1${stamp}`);
  if (!text.includes(stamp)) {
    text = `${text.trim()}\n\n**Timestamp to display:**\n\n${stamp}`;
  }
  return text;
}

module.exports = {
  DEFAULT_TRIP_IMAGE_PROMPT,
  NIGHT_LIGHTING_RULE,
  DAY_LIGHTING_RULE,
  NIGHT_ENVIRONMENT,
  DAY_ENVIRONMENT,
  formatCctvTimestamp,
  isNightInKolkata,
  buildTripImagePrompt,
};
