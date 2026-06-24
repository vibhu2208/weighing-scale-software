import React, { useEffect, useState } from 'react';
import {
  CAMERA_SLOT_COUNT,
  parseCameraSlotsFromSettings,
  serializeCameraSlots,
} from '../../lib/cameraSlots.js';

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?!$)|$)){4}$/;

function validateIp(ip) {
  if (!ip) return 'Enter a camera IP address';
  if (!IPV4.test(ip)) return 'Enter a valid IPv4 address';
  return null;
}

export default function CameraSlotsEditor({ urlsValue, onChange }) {
  const [slots, setSlots] = useState(() => parseCameraSlotsFromSettings(urlsValue));
  const [errors, setErrors] = useState({});

  useEffect(() => {
    setSlots(parseCameraSlotsFromSettings(urlsValue));
  }, [urlsValue]);

  function applySlots(nextSlots) {
    setSlots(nextSlots);
    const nextErrors = {};
    nextSlots.forEach((s) => {
      if (s.enabled) {
        const err = validateIp(s.ip);
        if (err) nextErrors[s.slot] = err;
      }
    });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) {
      onChange(serializeCameraSlots(nextSlots));
    }
  }

  function setEnabled(slotIndex, enabled) {
    const next = slots.map((s, i) => {
      if (i !== slotIndex) return s;
      return { ...s, enabled, ip: enabled ? s.ip : '' };
    });
    if (!enabled) {
      setErrors((e) => {
        const copy = { ...e };
        delete copy[slotIndex + 1];
        return copy;
      });
      setSlots(next);
      onChange(serializeCameraSlots(next));
      return;
    }
    setSlots(next);
    if (next[slotIndex].ip) {
      applySlots(next);
    }
  }

  function setIp(slotIndex, ip) {
    const next = slots.map((s, i) => (i === slotIndex ? { ...s, ip } : s));
    setSlots(next);
    const err = validateIp(ip);
    setErrors((e) => {
      const copy = { ...e };
      if (err) copy[slotIndex + 1] = err;
      else delete copy[slotIndex + 1];
      return copy;
    });
    if (!err) {
      onChange(serializeCameraSlots(next));
    }
  }

  const enabledCount = slots.filter((s) => s.enabled).length;

  return (
    <div className="space-y-3 mb-4">
      <p className="text-xs text-slate-500">
        Enable each camera and set its IP. Disabled slots are skipped during photo capture.
        {' '}
        <span className="text-slate-400">{enabledCount} of {CAMERA_SLOT_COUNT} active.</span>
      </p>
      {slots.map((slot, index) => (
        <div
          key={slot.slot}
          className="rounded-lg border border-slate-700/60 p-3 space-y-2"
        >
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-slate-300 font-medium">{slot.label}</span>
            <span className="flex items-center gap-2 text-slate-400 text-xs">
              <span>{slot.enabled ? 'Enabled' : 'Disabled'}</span>
              <input
                type="checkbox"
                checked={slot.enabled}
                onChange={(e) => setEnabled(index, e.target.checked)}
              />
            </span>
          </label>
          {slot.enabled ? (
            <label className="block text-sm">
              <span className="text-slate-500 text-xs">IP address</span>
              <input
                type="text"
                className="field-input mt-1 w-full font-mono text-sm"
                placeholder="192.168.0.18"
                value={slot.ip}
                onChange={(e) => setIp(index, e.target.value.trim())}
              />
              {errors[slot.slot] && (
                <p className="text-xs text-red-400 mt-1">{errors[slot.slot]}</p>
              )}
              <p className="text-xs text-slate-600 mt-1">
                Uses shared username, password, and RTSP path from Primary camera URL below.
              </p>
            </label>
          ) : (
            <p className="text-xs text-slate-600">
              This camera will not be used for live preview or weighment photos.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
