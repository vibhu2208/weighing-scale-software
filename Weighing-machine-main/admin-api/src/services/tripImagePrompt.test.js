'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_TRIP_IMAGE_PROMPT,
  buildTripImagePrompt,
  isNightInKolkata,
} = require('./tripImagePrompt');

test('night keeps the dark lighting lines and stamps the trip time', () => {
  const at = new Date('2026-11-06T14:00:27.000Z');
  const text = buildTripImagePrompt({ template: DEFAULT_TRIP_IMAGE_PROMPT, at });
  assert.match(text, /6\/11\/2026 19:30:27/);
  assert.match(text, /Nighttime must be realistically dark/);
  assert.match(text, /genuinely dark/);
  assert.doesNotMatch(text, /natural daylight/);
  assert.doesNotMatch(text, /\{\{TIMESTAMP\}\}/);
});

test('day swaps only the lighting lines', () => {
  const at = new Date('2026-11-06T06:00:00.000Z');
  const text = buildTripImagePrompt({ template: DEFAULT_TRIP_IMAGE_PROMPT, at });
  assert.match(text, /6\/11\/2026 11:30:00/);
  assert.match(text, /natural daylight/);
  assert.match(text, /genuine daytime CCTV/);
  assert.doesNotMatch(text, /Nighttime must be realistically dark/);
  assert.doesNotMatch(text, /genuinely dark/);
  assert.match(text, /Remove all people from the image/);
  assert.match(text, /yellow rod\/bar/);
  assert.match(text, /number plate completely unreadable/);
});

test('night window is 18:00 through 05:59 Asia/Kolkata', () => {
  assert.equal(isNightInKolkata(new Date('2026-11-06T12:30:00.000Z')), true);
  assert.equal(isNightInKolkata(new Date('2026-11-06T12:29:00.000Z')), false);
  assert.equal(isNightInKolkata(new Date('2026-11-06T00:29:00.000Z')), true);
  assert.equal(isNightInKolkata(new Date('2026-11-06T00:30:00.000Z')), false);
});

test('a custom prompt without the night sentences keeps its own lighting text', () => {
  const text = buildTripImagePrompt({
    template: 'Keep this yard.\n\n**Timestamp to display:**\n\n{{TIMESTAMP}}',
    at: new Date('2026-11-06T06:00:00.000Z'),
  });
  assert.match(text, /Keep this yard/);
  assert.match(text, /6\/11\/2026 11:30:00/);
  assert.doesNotMatch(text, /natural daylight/);
});
