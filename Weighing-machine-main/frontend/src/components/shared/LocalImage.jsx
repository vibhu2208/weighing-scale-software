import React, { useEffect, useState } from 'react';
import { resolveMediaSrc } from '../../lib/resolveMediaSrc.js';

export default function LocalImage({
  path,
  cacheKey = '',
  alt = '',
  className = '',
  fallback = null,
  onLoad,
  onError,
}) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    setSrc(null);

    if (!path) {
      setFailed(true);
      return undefined;
    }

    resolveMediaSrc(path, cacheKey)
      .then((url) => {
        if (!active) return;
        if (!url) {
          setFailed(true);
          return;
        }
        setSrc(url);
      })
      .catch(() => {
        if (active) setFailed(true);
      });

    return () => {
      active = false;
    };
  }, [path, cacheKey]);

  if (failed || !src) {
    return (
      fallback || (
        <div
          className={`flex items-center justify-center bg-slate-900 text-[10px] text-slate-500 ${className}`}
        >
          Image missing
        </div>
      )
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      decoding="async"
      onLoad={onLoad}
      onError={() => {
        setFailed(true);
        onError?.();
      }}
    />
  );
}
