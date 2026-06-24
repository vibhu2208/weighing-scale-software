import React, { useCallback, useEffect, useState } from 'react';
import { deviceAPI, subscribe } from '../api/ipc.js';
import RtspPreview from '../components/device/RtspPreview.jsx';
import Badge from '../components/shared/Badge.jsx';

function feedStatus(blank, lastFrameAt) {
  if (blank) return { label: 'BLANK', variant: 'warning' };
  if (!lastFrameAt) return { label: 'WAITING', variant: 'default' };
  const age = Date.now() - lastFrameAt;
  if (age < 4000) return { label: 'LIVE', variant: 'success' };
  if (age < 15000) return { label: 'LAGGING', variant: 'warning' };
  return { label: 'NO SIGNAL', variant: 'danger' };
}

function CameraSection({
  camera,
  previewActive,
  onTogglePreview,
  lastFrameAt,
  blank,
  toggling,
}) {
  const status = previewActive ? feedStatus(blank, lastFrameAt) : null;

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Camera</p>
          <h2 className="text-2xl font-semibold text-white">{camera.label}</h2>
        </div>
        {status && (
          <Badge variant={status.variant}>{status.label}</Badge>
        )}
      </div>

      <div className="relative aspect-[16/9] min-h-[220px] bg-slate-900">
        {camera.disabled ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="text-3xl opacity-30">📷</span>
            <p className="text-slate-500 text-sm">This camera is disabled in Settings.</p>
            <p className="text-slate-600 text-xs">Use - in Camera IPs to turn a slot off.</p>
          </div>
        ) : previewActive ? (
          <RtspPreview
            cameraId={camera.id}
            label={camera.label}
            className="h-full w-full object-cover"
            sharedPreview
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="text-5xl opacity-40">📷</span>
            <p className="text-slate-400 text-sm">Preview is off — start when you need a live view.</p>
          </div>
        )}
      </div>

      <div className="border-t border-slate-800 px-5 py-4">
        <button
          type="button"
          className={previewActive ? 'btn-ghost w-full sm:w-auto' : 'btn-primary w-full sm:w-auto'}
          disabled={toggling || camera.disabled}
          onClick={() => onTogglePreview(camera.id)}
        >
          {toggling
            ? previewActive
              ? 'Stopping…'
              : 'Starting…'
            : previewActive
              ? 'Stop preview'
              : 'Start preview'}
        </button>
      </div>
    </section>
  );
}

export default function LiveCameras() {
  const [testConfig, setTestConfig] = useState(null);
  const [activePreviews, setActivePreviews] = useState({});
  const [togglingId, setTogglingId] = useState(null);
  const [lastFrameAt, setLastFrameAt] = useState({});
  const [blankFeeds, setBlankFeeds] = useState({});

  const cameras = (testConfig?.cameras || []).slice(0, 3);
  const useRtsp = testConfig?.useRtspCamera && !testConfig?.useWebcamCamera;
  const activeCount = Object.values(activePreviews).filter(Boolean).length;

  useEffect(() => {
    deviceAPI.getTestConfig().then(setTestConfig).catch(() => {});
  }, []);

  useEffect(() => {
    const unsub = subscribe('device:cameraFrame', (payload) => {
      if (!payload?.cameraId) return;
      if (payload.blank || !payload.frame) {
        setBlankFeeds((prev) => ({ ...prev, [payload.cameraId]: true }));
        return;
      }
      setLastFrameAt((prev) => ({ ...prev, [payload.cameraId]: Date.now() }));
      setBlankFeeds((prev) => ({ ...prev, [payload.cameraId]: false }));
    });
    return unsub;
  }, []);

  useEffect(() => {
    return () => {
      deviceAPI.stopCameraPreview().catch(() => {});
    };
  }, []);

  const togglePreview = useCallback(async (cameraId) => {
    const isActive = !!activePreviews[cameraId];
    setTogglingId(cameraId);
    try {
      if (isActive) {
        await deviceAPI.stopCameraPreview(cameraId);
        setActivePreviews((prev) => ({ ...prev, [cameraId]: false }));
        setLastFrameAt((prev) => {
          const next = { ...prev };
          delete next[cameraId];
          return next;
        });
        setBlankFeeds((prev) => {
          const next = { ...prev };
          delete next[cameraId];
          return next;
        });
      } else {
        await deviceAPI.startCameraPreview(cameraId);
        setActivePreviews((prev) => ({ ...prev, [cameraId]: true }));
      }
    } catch {
      setActivePreviews((prev) => ({ ...prev, [cameraId]: false }));
    } finally {
      setTogglingId(null);
    }
  }, [activePreviews]);

  if (!testConfig) {
    return (
      <div className="flex h-48 items-center justify-center text-slate-500 text-sm">
        Loading cameras…
      </div>
    );
  }

  if (!useRtsp) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Live Cameras</h1>
          <p className="mt-1 text-sm text-slate-400">
            RTSP cameras are not configured. Set camera IPs in Settings or disable webcam mode.
          </p>
        </div>
        <div className="card p-8 text-center text-slate-500 text-sm">
          No RTSP camera feeds available.
        </div>
      </div>
    );
  }

  if (!cameras.length) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Live Cameras</h1>
          <p className="mt-1 text-sm text-slate-400">
            Add camera IPs under Settings → Hardware.
          </p>
        </div>
        <div className="card p-8 text-center text-slate-500 text-sm">
          No cameras configured in CAMERA_RTSP_URLS.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Live Cameras</h1>
          <p className="mt-1 text-sm text-slate-400">
            Each camera starts independently — only open the feeds you need.
          </p>
        </div>
        {activeCount > 0 && (
          <Badge variant="success">
            {activeCount} preview{activeCount === 1 ? '' : 's'} running
          </Badge>
        )}
      </div>

      <div className="space-y-6">
        {cameras.map((camera) => (
          <CameraSection
            key={camera.id}
            camera={camera}
            previewActive={!!activePreviews[camera.id]}
            onTogglePreview={togglePreview}
            lastFrameAt={lastFrameAt[camera.id]}
            blank={blankFeeds[camera.id]}
            toggling={togglingId === camera.id}
          />
        ))}
      </div>
    </div>
  );
}
