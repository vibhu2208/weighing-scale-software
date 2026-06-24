import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';

export function captureVideoFrame(videoEl) {
  if (!videoEl || !videoEl.videoWidth) {
    throw new Error('Webcam is not ready');
  }
  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.92);
}

const WebcamPreview = forwardRef(function WebcamPreview({ className, onError, onReady }, ref) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const onReadyRef = useRef(onReady);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  onReadyRef.current = onReady;

  useImperativeHandle(ref, () => ({
    capture: () => captureVideoFrame(videoRef.current),
    isReady: () => ready && !!videoRef.current?.videoWidth,
  }));

  useEffect(() => {
    let cancelled = false;

    function markReady(video) {
      if (!video?.videoWidth) return;
      setReady(true);
      onReadyRef.current?.();
    }

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.onloadedmetadata = () => markReady(video);
          video.onplaying = () => markReady(video);
          if (video.readyState >= 2) {
            markReady(video);
          }
        }
      } catch (err) {
        const message = err?.message || 'Could not access webcam';
        setError(message);
        onError?.(message);
      }
    }

    start();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [onError]);

  if (error) {
    return (
      <div className={`flex items-center justify-center text-center p-4 ${className || ''}`}>
        <p className="text-red-300 text-sm">{error}</p>
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      className={className}
    />
  );
});

export default WebcamPreview;
