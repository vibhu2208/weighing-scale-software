'use strict';

/**
 * Admin photo last-write-wins helpers.
 *
 * Versioned keys embed Date.now().toString(36) (Create images + Report Edit).
 * That object write time is the source of truth when tables disagree — not
 * row updated_at races from reconcile / sync.
 *
 * Stable weighbridge sites/…/cam-N.jpg (no version suffix) never beats
 * Create-images remote-trips/… keys.
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

function isVersionedRemoteTripKey(key) {
  return /^remote-trips\/[^/]+\/(arrival|departure)_cam-[1-3]-[a-z0-9]+\.jpe?g$/i.test(
    String(key || ''),
  );
}

/**
 * Extract embeded write time from versioned photo keys.
 * Format: …_cam-N-{Date.now().toString(36)}{4 random chars}.jpg
 */
function photoKeyWriteTime(key) {
  const k = String(key || '');
  if (!k || /\.thumb\.jpe?g$/i.test(k)) return 0;
  const m = k.match(/_cam-[1-3]-([a-z0-9]+)\.jpe?g$/i);
  if (!m) return 0;
  const ver = m[1];
  if (ver.length <= 4) return 0;
  const ms = parseInt(ver.slice(0, -4), 36);
  // Plausible epoch ms window (2015–2100).
  if (!Number.isFinite(ms) || ms < 1.4e12 || ms > 4e12) return 0;
  return ms;
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

  // Prefer the object that was actually written later (embedded version ts).
  const remoteWrite = photoKeyWriteTime(remote);
  const mirrorWrite = photoKeyWriteTime(mirror);
  if (remoteWrite || mirrorWrite) {
    if (mirrorWrite > remoteWrite) return mirror;
    if (remoteWrite > mirrorWrite) return remote;
  }

  const remoteAt = parseTs(opts.remoteUpdatedAt);
  const mirrorAt = parseTs(opts.mirrorUpdatedAt);
  if (mirrorAt > remoteAt) return mirror;
  if (remoteAt > mirrorAt) return remote;

  // Timestamp tie: prefer Report Edit versioned keys, then Create-images.
  if (isVersionedAdminMirrorKey(mirror)) return mirror;
  if (isVersionedAdminMirrorKey(remote)) return remote;
  if (remote.startsWith('remote-trips/')) return remote;
  if (mirror.startsWith('remote-trips/')) return mirror;
  return mirror || remote;
}

/** Newest key among candidates for one camera slot (skips thumbs). */
function pickNewestPhotoKey(keys) {
  let best = null;
  let bestTs = -1;
  for (const raw of keys || []) {
    const key = String(raw || '').trim();
    if (!key || /\.thumb\.jpe?g$/i.test(key)) continue;
    if (!/\.(jpe?g|png|webp|gif)$/i.test(key)) continue;
    const ts = photoKeyWriteTime(key);
    // Versioned keys beat unversioned; among equals prefer admin mirror path.
    const score = ts || (isStableWeighbridgeMirrorKey(key) ? 1 : 2);
    if (score > bestTs) {
      bestTs = score;
      best = key;
    } else if (score === bestTs && best) {
      if (isVersionedAdminMirrorKey(key) && !isVersionedAdminMirrorKey(best)) {
        best = key;
      }
    }
  }
  return best;
}

module.exports = {
  isVersionedAdminMirrorKey,
  isStableWeighbridgeMirrorKey,
  isVersionedRemoteTripKey,
  photoKeyWriteTime,
  preferLastWritePhotoKey,
  pickNewestPhotoKey,
};
