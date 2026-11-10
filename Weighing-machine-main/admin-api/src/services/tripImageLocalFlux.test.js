'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveImageEditProvider,
  buildMfluxKontextArgs,
} = require('./tripImageLocalFlux');

test('defaults to local flux when IMAGE_EDIT_PROVIDER is unset', () => {
  assert.equal(resolveImageEditProvider({}), 'local');
});

test('accepts gemini or local providers', () => {
  assert.equal(resolveImageEditProvider({ IMAGE_EDIT_PROVIDER: 'gemini' }), 'gemini');
  assert.equal(resolveImageEditProvider({ IMAGE_EDIT_PROVIDER: 'LOCAL' }), 'local');
  assert.equal(resolveImageEditProvider({ IMAGE_EDIT_PROVIDER: 'flux' }), 'local');
});

test('builds a low-ram Q4 kontext command for 16 GB Macs', () => {
  const args = buildMfluxKontextArgs({
    imagePath: '/tmp/in.jpg',
    outputPath: '/tmp/out.png',
    prompt: 'Make it night. Timestamp: 6/11/2026 19:30:27',
    env: {
      MFLUX_MODEL: 'mflux-community/flux-1-dev-kontext-mflux-q4',
      MFLUX_WIDTH: '768',
      MFLUX_HEIGHT: '768',
      MFLUX_STEPS: '20',
      MFLUX_LOW_RAM: 'true',
    },
  });
  assert.deepEqual(args.slice(0, 2), ['--model', 'mflux-community/flux-1-dev-kontext-mflux-q4']);
  assert.ok(args.includes('--base-model'));
  assert.ok(args.includes('dev-kontext'));
  assert.ok(args.includes('--image-path'));
  assert.ok(args.includes('/tmp/in.jpg'));
  assert.ok(args.includes('--output'));
  assert.ok(args.includes('/tmp/out.png'));
  assert.ok(args.includes('--low-ram'));
  assert.ok(args.includes('--width'));
  assert.ok(args.includes('768'));
  assert.ok(args.includes('--prompt'));
  assert.ok(args.includes('Make it night. Timestamp: 6/11/2026 19:30:27'));
});
