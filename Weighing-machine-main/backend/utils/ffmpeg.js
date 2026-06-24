'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');

let cachedFfmpegPath = null;
/** Per-camera RTSP URL cache (key = requested primary URL). */
const cachedWorkingRtspByUrl = new Map();

const COMMON_RTSP_SUFFIXES = [
  '/ch01.264',
  '/ch00.264',
  '/live/mpeg4',
  '/Streaming/Channels/101',
  '/Streaming/Channels/1',
  '/cam/realmonitor?channel=1&subtype=0',
  '/onvif1',
  '/stream1',
];

/** Electron asar archives cannot execute binaries; use the unpacked copy. */
function toSpawnablePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return filePath;
  if (!filePath.includes('app.asar')) return filePath;

  const unpacked = filePath.replace('app.asar', 'app.asar.unpacked');
  if (unpacked !== filePath && fs.existsSync(unpacked)) {
    return unpacked;
  }
  return filePath;
}

/** Packaged Electron apps ship ffmpeg beside resources/ (see electron-builder extraResources). */
function getBundledFfmpegPath() {
  if (!process.resourcesPath) return null;
  const bundled = path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
  return fs.existsSync(bundled) ? bundled : null;
}

function resolveFfmpegPath() {
  if (cachedFfmpegPath) return cachedFfmpegPath;

  const candidates = [];

  if (process.env.FFMPEG_PATH) {
    candidates.push(process.env.FFMPEG_PATH);
  }

  const bundled = getBundledFfmpegPath();
  if (bundled) candidates.push(bundled);

  try {
    candidates.push(require('@ffmpeg-installer/ffmpeg').path);
  } catch (_e) {
    /* optional */
  }

  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath) candidates.push(staticPath);
  } catch (_e) {
    /* optional */
  }

  candidates.push('ffmpeg');

  for (const candidate of candidates) {
    if (candidate === 'ffmpeg') {
      cachedFfmpegPath = candidate;
      return cachedFfmpegPath;
    }
    const spawnable = toSpawnablePath(candidate);
    if (fs.existsSync(spawnable)) {
      cachedFfmpegPath = spawnable;
      return cachedFfmpegPath;
    }
  }

  cachedFfmpegPath = 'ffmpeg';
  return cachedFfmpegPath;
}

function maskUrl(url) {
  return String(url || '').replace(/:([^:@/]+)@/, ':***@');
}

function parseRtspBase(url) {
  const match = String(url).trim().match(/^(rtsp:\/\/[^/]+)(\/.*)?$/i);
  if (!match) return null;
  return { base: match[1], path: match[2] || '' };
}

function buildRtspCandidates(primaryUrl, extraAlternates, exactOnly = false) {
  const trimmed = String(primaryUrl || '').trim();
  const candidates = [];

  if (trimmed) candidates.push(trimmed);

  if (exactOnly) {
    return candidates;
  }

  if (extraAlternates) {
    for (const part of String(extraAlternates).split(',')) {
      const alt = part.trim();
      if (alt) candidates.push(alt);
    }
  }

  const parsed = parseRtspBase(trimmed);
  if (parsed && (!parsed.path || parsed.path === '/')) {
    for (const suffix of COMMON_RTSP_SUFFIXES) {
      candidates.push(`${parsed.base}${suffix}`);
    }
  }

  return [...new Set(candidates)];
}

function friendlyRtspError(stderr, url) {
  const s = String(stderr || '').toLowerCase();
  if (s.includes('401 unauthorized') || s.includes('401')) {
    return 'Camera login failed — check username and password in CAMERA_RTSP_URL';
  }
  if (s.includes('403')) {
    return 'Camera denied access — check user permissions on the camera';
  }
  if (s.includes('connection refused') || s.includes('failed to connect')) {
    return `Cannot reach camera at ${maskUrl(url)} — verify IP and that port 554 is open`;
  }
  if (s.includes('timed out') || s.includes('timeout')) {
    return 'Camera did not respond in time — check network cable/Wi‑Fi and firewall';
  }
  if (s.includes('unknown error')) {
    return `Cannot open RTSP stream at ${maskUrl(url)} — try the URL in VLC; confirm PC is on 192.168.1.x network`;
  }

  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !l.startsWith('ffmpeg version') &&
        !l.startsWith('built with') &&
        !l.startsWith('configuration:'),
    );
  const tail = lines.slice(-2).join(' | ');
  return tail || `RTSP capture failed for ${maskUrl(url)}`;
}

function captureRtspFrameOnce(rtspUrl, transport, timeoutMs) {
  const ffmpegPath = resolveFfmpegPath();

  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-rtsp_transport',
      transport,
      '-stimeout',
      '10000000',
      '-analyzeduration',
      '10000000',
      '-probesize',
      '10000000',
      '-i',
      rtspUrl,
      '-an',
      '-vframes',
      '1',
      '-q:v',
      '2',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      'pipe:1',
    ];

    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    const chunks = [];
    let stderr = '';
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!proc.killed) {
        try {
          proc.kill();
        } catch (_e) {
          /* ignore */
        }
      }
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Camera capture timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    proc.stdout.on('data', (chunk) => chunks.push(chunk));
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      finish(
        new Error(
          `ffmpeg not available (${err.message}). Install ffmpeg or set FFMPEG_PATH.`,
        ),
      );
    });
    proc.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code === 0 && buf.length > 0) {
        finish(null, buf);
        return;
      }
      finish(new Error(friendlyRtspError(stderr, rtspUrl)));
    });
  });
}

async function captureHttpSnapshot(httpUrl, timeoutMs = 10000) {
  const url = String(httpUrl || '').trim();
  if (!url) {
    throw new Error('CAMERA_HTTP_SNAPSHOT_URL is not configured');
  }

  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const buf = Buffer.from(res.data);
  if (!buf.length) {
    throw new Error('HTTP snapshot returned empty image');
  }
  if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) {
    throw new Error('HTTP snapshot did not return a JPEG image');
  }
  return buf;
}

/**
 * Grab a JPEG frame from RTSP (with alternates) or HTTP snapshot fallback.
 * @param {string} rtspUrl
 * @param {{ timeoutMs?: number, alternates?: string, httpSnapshotUrl?: string }} [options]
 * @returns {Promise<Buffer>}
 */
async function captureRtspFrame(rtspUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20000;
  const transports = options.transports || ['tcp', 'udp'];
  const httpSnapshotUrl =
    options.httpSnapshotUrl || process.env.CAMERA_HTTP_SNAPSHOT_URL || '';
  const cacheKey = String(rtspUrl || '').trim();
  const exactOnly = !!options.exactUrlOnly;

  const cachedForCamera = cachedWorkingRtspByUrl.get(cacheKey);
  if (cachedForCamera) {
    for (const transport of transports) {
      try {
        return await captureRtspFrameOnce(cachedForCamera, transport, timeoutMs);
      } catch (_e) {
        cachedWorkingRtspByUrl.delete(cacheKey);
        break;
      }
    }
  }

  const candidates = buildRtspCandidates(
    rtspUrl,
    options.alternates,
    exactOnly,
  );
  const errors = [];

  for (const candidate of candidates) {
    for (const transport of transports) {
      try {
        const buf = await captureRtspFrameOnce(candidate, transport, timeoutMs);
        cachedWorkingRtspByUrl.set(cacheKey, candidate);
        return buf;
      } catch (err) {
        errors.push(`${maskUrl(candidate)} (${transport}): ${err.message}`);
      }
    }
  }

  if (httpSnapshotUrl) {
    try {
      const buf = await captureHttpSnapshot(httpSnapshotUrl, timeoutMs);
      return buf;
    } catch (err) {
      errors.push(`HTTP snapshot: ${err.message}`);
    }
  }

  const detail = errors.slice(-3).join('; ');
  throw new Error(
    detail ||
      'Could not capture from camera — verify RTSP URL in Settings and test in VLC',
  );
}

function clearRtspUrlCache() {
  cachedWorkingRtspByUrl.clear();
}

module.exports = {
  resolveFfmpegPath,
  captureRtspFrame,
  captureHttpSnapshot,
  buildRtspCandidates,
  clearRtspUrlCache,
  maskUrl,
};
