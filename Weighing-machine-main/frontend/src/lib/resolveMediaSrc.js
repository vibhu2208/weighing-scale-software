import { storageAPI } from '../api/ipc.js';
import { toMediaUrl } from './mediaUrl.js';

const dataUrlCache = new Map();

function usesHttpMedia() {
  if (typeof window === 'undefined') return false;
  if (!window.electronAPI && typeof fetch !== 'undefined') return true;
  return window.location?.protocol?.startsWith('http') ?? false;
}

function shouldUseIpcMedia() {
  return typeof window !== 'undefined' && window.electronAPI && !usesHttpMedia();
}

/**
 * Resolve a stored file path to something an <img> can load.
 * Packaged Electron uses IPC data URLs; dev uses /media/ or weighbridge-local.
 */
export async function resolveMediaSrc(filePath, cacheKey = '') {
  if (!filePath) return null;
  if (String(filePath).startsWith('data:') || String(filePath).startsWith('blob:')) {
    return filePath;
  }

  if (shouldUseIpcMedia()) {
    const key = `${filePath}|${cacheKey}`;
    if (dataUrlCache.has(key)) {
      return dataUrlCache.get(key);
    }
    const dataUrl = await storageAPI.readMediaDataUrl(filePath);
    dataUrlCache.set(key, dataUrl);
    return dataUrl;
  }

  const url = toMediaUrl(filePath);
  if (!url || !cacheKey) return url;
  return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(cacheKey)}`;
}

export function clearMediaSrcCache() {
  dataUrlCache.clear();
}
