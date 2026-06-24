'use strict';

const { captureRtspFrame, captureHttpSnapshot } = require('./ffmpeg');

/** Serialize captures per camera host so preview and save never hit the same IP at once. */
const hostLocks = new Map();

function getSnapshotCandidates(camera) {
  const list = [
    ...(Array.isArray(camera.httpSnapshotUrls) ? camera.httpSnapshotUrls : []),
    camera.httpSnapshotUrl,
  ]
    .map((u) => String(u || '').trim())
    .filter(Boolean);
  return [...new Set(list)];
}

function extractCameraHost(camera) {
  const url = String(camera?.rtspUrl || camera?.httpSnapshotUrl || '').trim();
  const match = url.match(/@([^/:]+)/) || url.match(/\/\/([^/:]+)/);
  return match?.[1] || camera?.ip || camera?.id || 'default';
}

function isJpegBuffer(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  );
}

async function withHostLock(camera, fn) {
  const host = extractCameraHost(camera);
  const previous = hostLocks.get(host) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(fn);
  hostLocks.set(
    host,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Capture a single JPEG frame from one camera (HTTP snapshot first, then RTSP).
 * @param {object} camera
 * @param {number} timeoutMs
 * @returns {Promise<Buffer>}
 */
async function captureFrameFromCamera(camera, timeoutMs = 20000) {
  return withHostLock(camera, () => captureFrameFromCameraUnlocked(camera, timeoutMs));
}

async function captureFrameFromCameraUnlocked(camera, timeoutMs = 20000) {
  const snapshotCandidates = getSnapshotCandidates(camera);
  const httpTimeoutMs = Math.min(timeoutMs, 4500);

  for (const snapshotUrl of snapshotCandidates) {
    try {
      const buffer = await captureHttpSnapshot(snapshotUrl, httpTimeoutMs);
      if (isJpegBuffer(buffer)) {
        return buffer;
      }
    } catch (_e) {
      /* try next snapshot URL */
    }
  }

  return captureRtspFrame(camera.rtspUrl, {
    timeoutMs,
    exactUrlOnly: true,
    transports: ['tcp', 'udp'],
    httpSnapshotUrl: camera.httpSnapshotUrl,
  });
}

module.exports = {
  captureFrameFromCamera,
  getSnapshotCandidates,
  isJpegBuffer,
  extractCameraHost,
};
