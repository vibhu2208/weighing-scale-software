'use strict';

const DISABLED_ENTRY = new Set(['-', 'off', 'skip', 'disabled', 'none']);

function isDisabledCameraEntry(entry) {
  return DISABLED_ENTRY.has(String(entry || '').trim().toLowerCase());
}

/**
 * Build RTSP / HTTP snapshot URLs from IPs or full rtsp:// URLs.
 * @param {{
 *   urls?: string,
 *   rtspUrl?: string,
 *   user?: string,
 *   password?: string,
 *   path?: string,
 *   port?: string,
 * }} config
 */
function parseCameraList(config = {}) {
  const user = config.user || process.env.CAMERA_RTSP_USER || 'admin';
  const password = config.password || process.env.CAMERA_RTSP_PASSWORD || '123456';
  const path = config.path || process.env.CAMERA_RTSP_PATH || '/ch01.264';
  const port = String(config.port || process.env.CAMERA_RTSP_PORT || '554');
  const snapshotPath =
    config.snapshotPath ||
    process.env.CAMERA_HTTP_SNAPSHOT_PATH ||
    '/cgi-bin/snapshot.cgi';
  const snapshotPathsRaw =
    config.snapshotPaths ||
    process.env.CAMERA_HTTP_SNAPSHOT_PATHS ||
    '/cgi-bin/snapshot.cgi,/ISAPI/Streaming/channels/101/picture,/webcapture.jpg';
  const snapshotPaths = String(snapshotPathsRaw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const raw =
    config.urls ||
    config.rtspUrls ||
    process.env.CAMERA_RTSP_URLS ||
    '';

  let entries = String(raw)
    .split(',')
    .map((s) => {
      const t = s.trim();
      return t === '' ? '-' : t;
    })
    .filter((s) => s.length > 0);

  if (entries.length === 0 && config.rtspUrl) {
    entries = [String(config.rtspUrl).trim()];
  }

  return entries.map((entry, index) => {
    const slot = index + 1;
    const label = `Camera ${slot}`;
    const id = `cam-${slot}`;

    if (isDisabledCameraEntry(entry)) {
      return { id, label, disabled: true, ip: '' };
    }

    if (entry.startsWith('rtsp://')) {
      const hostMatch = entry.match(/@([^/:]+)/);
      let httpSnapshotUrl = '';
      let httpSnapshotUrls = [];
      if (hostMatch) {
        httpSnapshotUrl = `http://${user}:${password}@${hostMatch[1]}${snapshotPath}`;
        httpSnapshotUrls = snapshotPaths.map(
          (p) => `http://${user}:${password}@${hostMatch[1]}${p}`,
        );
      }
      return {
        id,
        label,
        rtspUrl: entry,
        httpSnapshotUrl,
        httpSnapshotUrls,
        ip: hostMatch?.[1] || '',
      };
    }

    const ip = entry;
    const rtspUrl = `rtsp://${user}:${password}@${ip}:${port}${path}`;
    const httpSnapshotUrl = `http://${user}:${password}@${ip}${snapshotPath}`;
    const httpSnapshotUrls = snapshotPaths.map(
      (p) => `http://${user}:${password}@${ip}${p}`,
    );
    return { id, label, rtspUrl, httpSnapshotUrl, httpSnapshotUrls, ip };
  });
}

function countEnabledCameras(config = {}) {
  return parseCameraList(config).filter((c) => !c.disabled).length;
}

module.exports = { parseCameraList, isDisabledCameraEntry, countEnabledCameras };
