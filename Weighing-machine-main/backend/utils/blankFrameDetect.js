'use strict';

const { isJpegBuffer } = require('./cameraFrameCapture');

function parseThreshold(name, fallback) {
  const n = parseFloat(process.env[name] || '');
  return Number.isFinite(n) ? n : fallback;
}

const BLANK_ENTROPY_MAX = parseThreshold('CAMERA_BLANK_ENTROPY_MAX', 4.35);
const BLANK_VARIANCE_MAX = parseThreshold('CAMERA_BLANK_VARIANCE_MAX', 18);

function sampleByteStats(buffer, start = 400, sampleCount = 2400) {
  if (!Buffer.isBuffer(buffer) || buffer.length <= start + 16) {
    return { mean: 0, variance: 0, entropy: 0 };
  }

  const step = Math.max(
    1,
    Math.floor((buffer.length - start - 16) / sampleCount),
  );
  const freq = new Map();
  let n = 0;
  let sum = 0;
  let sumSq = 0;

  for (let i = start; i < buffer.length - 16; i += step) {
    const value = buffer[i];
    sum += value;
    sumSq += value * value;
    freq.set(value, (freq.get(value) || 0) + 1);
    n += 1;
    if (n >= sampleCount) break;
  }

  if (!n) return { mean: 0, variance: 0, entropy: 0 };

  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);

  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / n;
    entropy -= p * Math.log2(p);
  }

  return { mean, variance, entropy };
}

/**
 * Detect uniform grey/black/white placeholder JPEGs without full decode.
 * @param {Buffer} buffer
 * @returns {{ blank: boolean, reason?: string, stats?: object }}
 */
function analyzeJpegBuffer(buffer) {
  if (!isJpegBuffer(buffer)) {
    return { blank: true, reason: 'not-jpeg' };
  }

  const stats = sampleByteStats(buffer);
  const lowEntropy = stats.entropy <= BLANK_ENTROPY_MAX;
  const lowVariance = stats.variance <= BLANK_VARIANCE_MAX;

  if (lowEntropy && lowVariance) {
    return {
      blank: true,
      reason: 'uniform-frame',
      stats,
    };
  }

  return { blank: false, stats };
}

function isBlankJpegBuffer(buffer) {
  return analyzeJpegBuffer(buffer).blank;
}

module.exports = {
  analyzeJpegBuffer,
  isBlankJpegBuffer,
};
