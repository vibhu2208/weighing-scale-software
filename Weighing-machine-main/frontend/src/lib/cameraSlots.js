const DISABLED = new Set(['-', 'off', 'skip', 'disabled', 'none']);
export const CAMERA_SLOT_COUNT = 3;

export function isDisabledEntry(entry) {
  return DISABLED.has(String(entry || '').trim().toLowerCase());
}

function extractIpFromEntry(entry) {
  const t = String(entry || '').trim();
  if (!t || isDisabledEntry(t)) return '';
  if (t.startsWith('rtsp://')) {
    const m = t.match(/@([^/:]+)/);
    return m?.[1] || '';
  }
  return t;
}

/** @param {string} rawUrls CAMERA_RTSP_URLS value */
export function parseCameraSlotsFromSettings(rawUrls) {
  const parts = String(rawUrls || '').split(',').map((s) => s.trim());
  const slots = [];
  for (let i = 0; i < CAMERA_SLOT_COUNT; i += 1) {
    const entry = parts[i] ?? '';
    const enabled = entry.length > 0 && !isDisabledEntry(entry);
    slots.push({
      slot: i + 1,
      label: `Camera ${i + 1}`,
      enabled,
      ip: enabled ? extractIpFromEntry(entry) : '',
    });
  }
  return slots;
}

/** @param {{ enabled: boolean, ip: string }[]} slots */
export function serializeCameraSlots(slots) {
  return slots
    .slice(0, CAMERA_SLOT_COUNT)
    .map((s) => {
      if (!s.enabled) return '-';
      const ip = String(s.ip || '').trim();
      return ip || '-';
    })
    .join(',');
}
