'use strict';

/**
 * Admin photo last-write-wins helpers.
 *
 * Contract:
 * - Report Edit and Create images both write the same keys to remote_trips +
 *   transactions_mirror (via attachPhotos).
 * - When the two tables temporarily disagree, the newer updated_at wins.
 * - Stable weighbridge sites/…/cam-N.jpg never beats Create-images
 *   remote-trips/… (those are stale PC stills, not admin edits).
 */

function isVersionedAdminMirrorKey(key) {
  return /sites\/[^/]+\/mirror\/[^/]+\/(arrival|departure)_cam-[1-3]-[a-z0-9]+\.jpe?g$/i.test(
    String(key || ''),
  );
}

function isStableWeighbridgeMirrorKey(key) {
  return /sites\/[^/]+\/mirror\/[^/]+\/(arrival|departure)_cam-[1-3]\.jpe?g$/i.test(
    String(key || ''),
  );
}

function parseTs(value) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * @param {string|null|undefined} remoteKey
 * @param {string|null|undefined} mirrorKey
 * @param {{
 *   slipChanged?: boolean,
 *   remoteUpdatedAt?: string|Date,
 *   mirrorUpdatedAt?: string|Date,
 * }} [opts]
 */
function preferLastWritePhotoKey(remoteKey, mirrorKey, opts = {}) {
  const remote = String(remoteKey || '').trim() || null;
  const mirror = String(mirrorKey || '').trim() || null;
  if (opts.slipChanged) return mirror || remote;
  if (!remote && !mirror) return null;
  if (!remote) return mirror;
  if (!mirror) return remote;
  if (remote === mirror) return remote;

  // Stale PC stills at the stable mirror path never replace Create-images.
  if (remote.startsWith('remote-trips/') && isStableWeighbridgeMirrorKey(mirror)) {
    return remote;
  }
  if (mirror.startsWith('remote-trips/') && isStableWeighbridgeMirrorKey(remote)) {
    return mirror;
  }

  const remoteAt = parseTs(opts.remoteUpdatedAt);
  const mirrorAt = parseTs(opts.mirrorUpdatedAt);
  if (mirrorAt > remoteAt) return mirror;
  if (remoteAt > mirrorAt) return remote;

  // Timestamp tie: prefer explicit admin write shapes over empty/legacy.
  if (isVersionedAdminMirrorKey(mirror)) return mirror;
  if (isVersionedAdminMirrorKey(remote)) return remote;
  if (remote.startsWith('remote-trips/')) return remote;
  if (mirror.startsWith('remote-trips/')) return mirror;
  return mirror || remote;
}

module.exports = {
  isVersionedAdminMirrorKey,
  isStableWeighbridgeMirrorKey,
  preferLastWritePhotoKey,
};
