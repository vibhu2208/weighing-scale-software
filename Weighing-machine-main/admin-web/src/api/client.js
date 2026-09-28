// In dev, Vite proxies API routes to admin-api (no CORS). Production uses VITE_API_URL.
const API_URL = import.meta.env.DEV
  ? ''
  : (import.meta.env.VITE_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const TOKEN_KEY = 'wb_admin_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function isLoggedIn() {
  return !!getToken();
}

async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_URL}${path}`, { ...options, headers });
  } catch {
    throw new Error(
      import.meta.env.DEV
        ? 'Cannot reach admin API — run "npm run dev" in the admin-api folder (port 3001)'
        : 'Network error — check VITE_API_URL and that the API is online',
    );
  }
  const json = await res.json().catch(() => ({}));

  if (res.status === 401) {
    setToken(null);
    if (!path.includes('/auth/login')) {
      window.location.href = '/login';
    }
  }

  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  return json;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read image file'));
    reader.readAsDataURL(file);
  });
}

async function downloadPdfBlob(path, filename) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_URL}${path}`, { headers });
  } catch {
    throw new Error(
      import.meta.env.DEV
        ? 'Cannot reach admin API — run "npm run dev" in the admin-api folder (port 3001)'
        : 'Network error — check VITE_API_URL and that the API is online',
    );
  }

  if (res.status === 401) {
    setToken(null);
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || `PDF download failed (${res.status})`);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'report.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  login(email, password) {
    return request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  getReports(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports?${qs}`);
  },

  getReportFilters() {
    return request('/reports/filters');
  },

  getReport(slip) {
    return request(`/reports/${encodeURIComponent(slip)}`);
  },

  async downloadReportPdf(slip) {
    return downloadPdfBlob(`/reports/${encodeURIComponent(slip)}/pdf`, `${slip}_report.pdf`);
  },

  editReport(slip, body) {
    return request(`/reports/${encodeURIComponent(slip)}/edit`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  deleteReport(slip) {
    return request(`/reports/${encodeURIComponent(slip)}/delete`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  exportCsvUrl(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return `${API_URL}/reports/export/csv?${qs}`;
  },

  exportExcelUrl(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return `${API_URL}/reports/export/excel?${qs}`;
  },

  async downloadExport(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const token = getToken();
    const res = await fetch(`${API_URL}${path}?${qs}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error('Export failed');
    return res.blob();
  },

  getAdvanceSettings() {
    return request('/settings/advance');
  },

  putAdvanceSettings(settings) {
    return request('/settings/advance', {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    });
  },

  getList(name) {
    return request(`/settings/lists/${name}`);
  },

  putList(name, items) {
    return request(`/settings/lists/${name}`, {
      method: 'PUT',
      body: JSON.stringify({ items }),
    });
  },

  getSyncStatus() {
    return request('/sync/status');
  },

  requestSyncOpenTickets() {
    return request('/sync/sync-open-tickets', {
      method: 'POST',
    });
  },

  retrySyncCommand(id) {
    return request(`/sync/commands/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
    });
  },

  retryFailedSyncCommands() {
    return request('/sync/commands/retry-failed', {
      method: 'POST',
    });
  },

  getUploadUrl(slip, slot, contentType, pass = 'departure') {
    return request('/media/upload-url', {
      method: 'POST',
      body: JSON.stringify({ slip, slot, contentType, pass }),
    });
  },

  getRemoteTripUploadUrl(slip, slot, contentType, pass = 'departure') {
    return request('/media/remote-trip-upload-url', {
      method: 'POST',
      body: JSON.stringify({ slip, slot, contentType, pass }),
    });
  },

  async uploadRemoteTripPhoto(slip, slot, file, pass = 'departure') {
    const imageBase64 = await fileToDataUrl(file);
    return request('/media/remote-trip-upload', {
      method: 'POST',
      body: JSON.stringify({
        slip,
        slot,
        pass,
        contentType: file.type || 'image/jpeg',
        imageBase64,
      }),
    });
  },

  async uploadMirrorPhoto(slip, slot, file, pass = 'departure') {
    const imageBase64 = await fileToDataUrl(file);
    return request('/media/upload', {
      method: 'POST',
      body: JSON.stringify({
        slip,
        slot,
        pass,
        contentType: file.type || 'image/jpeg',
        imageBase64,
      }),
    });
  },

  getRemoteTrips(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/remote-trips?${qs}`);
  },

  createRemoteTrip(body) {
    return request('/remote-trips', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  attachRemoteTripPhotos(id, photoS3Keys) {
    return request(`/remote-trips/${encodeURIComponent(id)}/photos`, {
      method: 'PATCH',
      body: JSON.stringify({ photoS3Keys }),
    });
  },

  async downloadRemoteTripPdf(id, slipNumber) {
    return downloadPdfBlob(
      `/remote-trips/${encodeURIComponent(id)}/pdf`,
      `${slipNumber || id}_report.pdf`,
    );
  },

  getSlipReservations(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/slip-reservations?${qs}`);
  },

  getSlipReservationHint() {
    return request('/slip-reservations/hint');
  },

  planSlipReservations(body) {
    return request('/slip-reservations/plan', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  releaseSlipReservation(id) {
    return request(`/slip-reservations/${encodeURIComponent(id)}/release`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  fireSlipReservation(id) {
    return request(`/slip-reservations/${encodeURIComponent(id)}/fire`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
};

export { API_URL };
