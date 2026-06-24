import React, { useEffect, useRef, useState } from 'react';
import { deviceAPI, subscribe } from '../../api/ipc.js';
import { isBlankPreviewImage } from '../../lib/blankFrameDetect.js';

const frameCache = new Map();

export default function RtspPreview({
  className,
  cameraId,
  label,
  onReady,
  onError,
  onQualityChange,
  /** When true, parent MultiRtspPreview already called startCameraPreview */
  sharedPreview = false,
}) {
  const cacheKey = cameraId || 'default';
  const [frameSrc, setFrameSrc] = useState(() => frameCache.get(cacheKey) || null);
  const [isBlank, setIsBlank] = useState(false);
  const [error, setError] = useState(null);
  const gotFrameRef = useRef(false);
  const frameSrcRef = useRef(frameSrc);

  useEffect(() => {
    frameSrcRef.current = frameSrc;
  }, [frameSrc]);

  useEffect(() => {
    let active = true;

    const unsub = subscribe('device:cameraFrame', (payload) => {
      if (!active || !payload?.cameraId) return;
      if (cameraId && payload.cameraId !== cameraId) return;

      if (payload.blank || !payload.frame) {
        setIsBlank(true);
        onQualityChange?.({ blank: true, cameraId: payload.cameraId });
        return;
      }

      gotFrameRef.current = true;
      const nextFrame = `data:image/jpeg;base64,${payload.frame}`;
      frameCache.set(cacheKey, nextFrame);
      setFrameSrc(nextFrame);
      setError(null);
      setIsBlank(false);
      onReady?.();
    });

    if (!sharedPreview) {
      deviceAPI
        .startCameraPreview()
        .then((result) => {
          if (!active) return;
          if (!result?.ok) {
            const message = result?.error || 'Could not start camera preview';
            if (!frameSrcRef.current) {
              setError(message);
            }
            onError?.(message);
          }
        })
        .catch((err) => {
          if (!active) return;
          const message =
            err?.message ||
            'Could not start camera preview — check CAMERA_RTSP_URLS in .env';
          if (!frameSrcRef.current) {
            setError(message);
          }
          onError?.(message);
        });
    }

    const frameTimeout = setTimeout(() => {
      if (!active || gotFrameRef.current) return;
      setError('No signal — check camera network and RTSP URL');
    }, 35000);

    return () => {
      active = false;
      clearTimeout(frameTimeout);
      unsub();
      if (!sharedPreview) {
        deviceAPI.stopCameraPreview().catch(() => {});
      }
    };
  }, [cacheKey, cameraId, onError, onQualityChange, onReady, sharedPreview]);

  const handleImageLoad = (event) => {
    const blank = isBlankPreviewImage(event.currentTarget);
    setIsBlank(blank);
    onQualityChange?.({ blank, cameraId: cameraId || cacheKey });
    if (!blank) onReady?.();
  };

  if (error && !frameSrc) {
    return (
      <div
        className={`flex items-center justify-center p-2 text-center ${className || ''}`}
      >
        <p className="text-red-300 text-xs">{error}</p>
      </div>
    );
  }

  if (!frameSrc) {
    return (
      <div className={`flex items-center justify-center ${className || ''}`}>
        <span className="text-slate-500 text-xs">Connecting…</span>
      </div>
    );
  }

  return (
    <div className={`relative h-full w-full ${isBlank ? 'bg-slate-800' : ''}`}>
      <img
        src={frameSrc}
        alt={label || cameraId || 'Live camera'}
        className={`${className || ''} ${isBlank ? 'opacity-20' : ''}`}
        decoding="async"
        onLoad={handleImageLoad}
      />
      {isBlank && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80 px-2 text-center">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-300">
            Blank feed — wait
          </span>
        </div>
      )}
    </div>
  );
}
