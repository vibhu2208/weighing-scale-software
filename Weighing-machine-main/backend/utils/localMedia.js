'use strict';

const fs = require('fs');
const path = require('path');

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'application/octet-stream';
  }
}

function normalizeStoredPath(filePath) {
  let normalized = String(filePath || '').trim();
  if (!normalized) return '';

  if (normalized.startsWith('file://')) {
    normalized = decodeURIComponent(normalized.replace(/^file:\/\//i, ''));
    if (normalized.startsWith('/')) normalized = normalized.slice(1);
  }

  return normalized;
}

function pathStartsWith(filePath, root) {
  const left = path.normalize(String(filePath || '')).toLowerCase();
  const right = path.normalize(String(root || '')).toLowerCase();
  return left.startsWith(right);
}

/** Extract uploads/... or images/... from any absolute path (handles legacy DB paths). */
function toRelativeMediaPath(filePath, fileStorage = null) {
  const normalized = fileStorage?.normalizePath
    ? fileStorage.normalizePath(filePath)
    : path.normalize(path.resolve(String(filePath || '')));
  if (!normalized) return null;

  if (fileStorage?.PATHS) {
    for (const [rootKey, prefix] of [
      ['UPLOADS', 'uploads'],
      ['IMAGES', 'images'],
    ]) {
      const root = fileStorage.normalizePath(fileStorage.PATHS[rootKey]);
      if (pathStartsWith(normalized, root)) {
        const tail = normalized.slice(root.length).replace(/^[\\/]+/, '');
        return `${prefix}/${tail.replace(/\\/g, '/')}`;
      }
    }
  }

  const uploadsMatch = normalized.match(/(?:^|[\\/])uploads[\\/](.+)$/i);
  if (uploadsMatch) {
    return `uploads/${uploadsMatch[1].replace(/\\/g, '/')}`;
  }

  const imagesMatch = normalized.match(/(?:^|[\\/])images[\\/](.+)$/i);
  if (imagesMatch) {
    return `images/${imagesMatch[1].replace(/\\/g, '/')}`;
  }

  return null;
}

function buildMediaUrl(relativePath) {
  const parts = String(relativePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part));

  if (!parts.length) return null;

  const bucket = parts[0].toLowerCase();
  if (bucket === 'uploads' || bucket === 'images') {
    // Chromium img tags normalize this to host=bucket (weighbridge-local://uploads/...)
    return `weighbridge-local://${bucket}/${parts.slice(1).join('/')}`;
  }

  return `weighbridge-local:///${parts.join('/')}`;
}

function toMediaUrl(filePath, fileStorage = null) {
  if (!filePath) return null;
  const raw = String(filePath);
  if (raw.startsWith('weighbridge-local://')) return raw;

  const normalized = fileStorage?.normalizePath
    ? fileStorage.normalizePath(filePath)
    : path.normalize(path.resolve(filePath));

  const relative = toRelativeMediaPath(normalized, fileStorage);
  if (relative) {
    return buildMediaUrl(relative);
  }

  return `weighbridge-local:///file/${encodeURIComponent(normalized)}`;
}

function resolveMediaFilePath(requestUrl, fileStorage) {
  const { PATHS, normalizePath } = fileStorage;
  const raw = String(requestUrl || '');

  if (raw.startsWith('weighbridge-local:///file/')) {
    const url = new URL(raw);
    let filePath = decodeURIComponent(url.pathname.replace(/^\/file\//, ''));
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) {
      filePath = filePath.slice(1);
    }
    return normalizePath(filePath);
  }

  try {
    const url = new URL(raw);
    const host = (url.hostname || '').toLowerCase();

    if (host === 'uploads' || host === 'images') {
      const subPath = url.pathname
        .replace(/^\//, '')
        .split('/')
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
      const root = host === 'uploads' ? PATHS.UPLOADS : PATHS.IMAGES;
      return normalizePath(path.join(root, ...subPath));
    }

    const segments = url.pathname
      .replace(/^\//, '')
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));

    if (!segments.length) return null;

    const bucket = segments[0].toLowerCase();
    if (bucket === 'uploads' || bucket === 'images') {
      const root = bucket === 'uploads' ? PATHS.UPLOADS : PATHS.IMAGES;
      return normalizePath(path.join(root, ...segments.slice(1)));
    }
  } catch (_e) {
    /* fall through */
  }

  return null;
}

function isAllowedMediaPath(filePath, fileStorage) {
  const { PATHS, normalizePath } = fileStorage;
  const normalized = normalizePath(filePath);
  return (
    pathStartsWith(normalized, PATHS.UPLOADS) ||
    pathStartsWith(normalized, PATHS.IMAGES)
  );
}

async function readMediaResponse(filePath) {
  const data = await fs.promises.readFile(filePath);
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': contentTypeFor(filePath),
      'Cache-Control': 'no-cache',
    },
  });
}

/** Read a local image and return a data: URL (reliable in packaged Electron UI). */
function readMediaDataUrl(filePath, fileStorage) {
  if (!filePath) return null;

  let resolved = String(filePath);
  if (!path.isAbsolute(resolved)) {
    resolved = fileStorage.normalizePath(resolved);
  } else {
    resolved = fileStorage.normalizePath(resolved);
  }

  if (!isAllowedMediaPath(resolved, fileStorage)) {
    const relative = toRelativeMediaPath(resolved, fileStorage);
    if (relative) {
      resolved = resolveMediaFilePath(buildMediaUrl(relative), fileStorage);
    }
  }

  if (!resolved || !isAllowedMediaPath(resolved, fileStorage)) {
    throw new Error('Image path is not allowed');
  }
  if (!fs.existsSync(resolved)) {
    throw new Error('Image file not found');
  }

  const data = fs.readFileSync(resolved);
  return `data:${contentTypeFor(resolved)};base64,${data.toString('base64')}`;
}

module.exports = {
  contentTypeFor,
  normalizeStoredPath,
  toRelativeMediaPath,
  buildMediaUrl,
  toMediaUrl,
  resolveMediaFilePath,
  isAllowedMediaPath,
  readMediaResponse,
  readMediaDataUrl,
};
