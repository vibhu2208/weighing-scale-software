/**
 * Build a renderer-safe URL for local image files.
 * Dev (Vite + Electron): same-origin /media/ route
 * Production Electron: weighbridge-local:// custom protocol
 */
import {
  buildMediaUrl,
  normalizeStoredPath,
  toRelativeMediaPath,
} from './localMediaShared.js';

function usesHttpMedia() {
  if (typeof window === 'undefined') return false;
  if (!window.electronAPI && typeof fetch !== 'undefined') return true;
  return window.location?.protocol?.startsWith('http') ?? false;
}

export function toMediaUrl(filePath) {
  if (!filePath) return null;
  if (filePath.startsWith('weighbridge-local://')) return filePath;
  if (filePath.startsWith('/media/')) return filePath;
  if (filePath.startsWith('data:') || filePath.startsWith('blob:')) return filePath;

  const normalized = normalizeStoredPath(filePath);
  if (!normalized) return null;

  if (usesHttpMedia()) {
    return `/media/${encodeURIComponent(normalized)}`;
  }

  const relative = toRelativeMediaPath(normalized);
  if (relative) {
    return buildMediaUrl(relative);
  }

  return `weighbridge-local:///file/${encodeURIComponent(normalized)}`;
}

export default toMediaUrl;
