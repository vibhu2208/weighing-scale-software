/** Shared media URL helpers (mirrors backend/utils/localMedia.js for the renderer). */

export function normalizeStoredPath(filePath) {
  let normalized = String(filePath || '').trim();
  if (!normalized) return '';

  if (normalized.startsWith('file://')) {
    normalized = decodeURIComponent(normalized.replace(/^file:\/\//i, ''));
    if (normalized.startsWith('/')) normalized = normalized.slice(1);
  }

  return normalized;
}

export function toRelativeMediaPath(filePath) {
  const normalized = normalizeStoredPath(filePath);
  if (!normalized) return null;

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

export function buildMediaUrl(relativePath) {
  const parts = String(relativePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part));

  if (!parts.length) return null;

  const bucket = parts[0].toLowerCase();
  if (bucket === 'uploads' || bucket === 'images') {
    return `weighbridge-local://${bucket}/${parts.slice(1).join('/')}`;
  }

  return `weighbridge-local:///${parts.join('/')}`;
}
