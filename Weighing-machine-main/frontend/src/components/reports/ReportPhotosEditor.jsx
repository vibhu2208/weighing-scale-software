import React, { useMemo, useState } from 'react';
import { reportAPI } from '../../api/ipc.js';
import LocalImage from '../shared/LocalImage.jsx';
import {
  listReportPhotoSlots,
  photoSlotKey,
  resolvePhotoSlot,
} from '../../lib/tripPhotos.js';

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read image file'));
    reader.readAsDataURL(file);
  });
}

function slotInfoFrom(photo) {
  if (photo?.pass && photo?.slot) {
    return { pass: photo.pass, slot: photo.slot };
  }
  return resolvePhotoSlot(photo);
}

function EmptySlotPlaceholder({ label }) {
  return (
    <div className="flex h-40 w-full flex-col items-center justify-center rounded border border-dashed border-slate-600 bg-slate-800/80 px-3 text-center">
      <span className="text-2xl text-slate-600">+</span>
      <span className="mt-1 text-xs text-slate-500">{label || 'No photo'}</span>
    </div>
  );
}

export default function ReportPhotosEditor({
  transactionId,
  slipNumber,
  images = [],
  editable = true,
  onClose,
  onSaved,
}) {
  const [pending, setPending] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const grouped = useMemo(
    () => listReportPhotoSlots(images, { includeEmpty: editable }),
    [images, editable],
  );
  const pendingCount = Object.keys(pending).length;

  async function onFileChange(photo, file) {
    const { pass, slot } = slotInfoFrom(photo);
    const key = photoSlotKey(pass, slot);
    if (!file) {
      setPending((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    try {
      const imageBase64 = await readFileAsDataUrl(file);
      setPending((prev) => ({
        ...prev,
        [key]: { pass, slot, imageBase64, imageName: file.name, preview: imageBase64 },
      }));
      setError('');
    } catch (err) {
      setError(err.message || 'Could not read image file');
    }
  }

  async function saveChanges() {
    if (!transactionId) {
      setError('Missing transaction ID');
      return;
    }
    if (!pendingCount) {
      setError('Choose at least one photo to add or replace');
      return;
    }

    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const manualImages = Object.values(pending).map(({ pass, slot, imageBase64 }) => ({
        pass,
        slot,
        imageBase64,
      }));

      const result = await reportAPI.adminUpdateClosedReport({
        transactionId,
        manualImages,
      });

      if (result?.ok === false) {
        throw new Error(result.error || 'Update failed');
      }

      setSuccess('Photos saved and report regenerated.');
      setPending({});
      onSaved?.(result?.transaction || result);
    } catch (e) {
      setError(
        e.message?.includes('Admin session') || e.message?.includes('Passcode')
          ? `${e.message} — unlock Advance Setting and Manual HYWA in Settings first.`
          : e.message || 'Update failed',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Edit report photos</h2>
            <p className="text-xs text-slate-400">
              {slipNumber || transactionId}
              {editable && ' · Add or replace photos in any camera slot'}
              {!editable && ' · Editing available for closed tickets only'}
            </p>
          </div>
          <button type="button" className="btn-ghost text-xs py-1 shrink-0" onClick={onClose}>
            Close
          </button>
        </div>

        {!editable ? (
          <p className="text-sm text-slate-500">Photo editing is available for closed tickets only.</p>
        ) : (
          grouped.map((group) => (
            <div key={group.pass} className="mb-6">
              <p className="mb-3 text-xs uppercase tracking-widest text-slate-500">{group.title}</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {group.items.map((cam) => {
                  const { pass, slot } = slotInfoFrom(cam);
                  const key = photoSlotKey(pass, slot);
                  const replacement = pending[key];
                  const isEmpty = cam.empty || !cam.path;
                  return (
                    <figure
                      key={key}
                      className="rounded-lg border border-slate-700/60 bg-slate-900/50 p-2"
                    >
                      {replacement?.preview ? (
                        <img
                          src={replacement.preview}
                          alt="Selected photo preview"
                          className="h-40 w-full rounded border border-emerald-700/50 object-cover bg-slate-800"
                        />
                      ) : isEmpty ? (
                        <EmptySlotPlaceholder label="Empty slot" />
                      ) : (
                        <LocalImage
                          path={cam.path}
                          alt={cam.label || cam.pass}
                          className="h-40 w-full rounded border border-slate-700 object-cover bg-slate-800"
                          fallback={<EmptySlotPlaceholder label="Image missing" />}
                        />
                      )}
                      <figcaption className="mt-2 text-xs text-slate-400">
                        {cam.label || `Camera ${slot}`}
                      </figcaption>
                      <label className="mt-2 block cursor-pointer text-center text-xs text-brand-300 hover:text-brand-200">
                        {replacement ? 'Change selection' : isEmpty ? 'Add photo' : 'Replace photo'}
                        <input
                          type="file"
                          accept="image/*"
                          className="sr-only"
                          onChange={(e) => onFileChange(cam, e.target.files?.[0])}
                        />
                      </label>
                      {replacement?.imageName && (
                        <p className="mt-1 truncate text-center text-[10px] text-emerald-400/80">
                          {replacement.imageName}
                        </p>
                      )}
                    </figure>
                  );
                })}
              </div>
            </div>
          ))
        )}

        {editable && (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-800 pt-4">
            <button
              type="button"
              className="btn-primary text-sm"
              disabled={busy || !pendingCount}
              onClick={saveChanges}
            >
              {busy ? 'Saving…' : `Save ${pendingCount || ''} photo${pendingCount === 1 ? '' : 's'}`}
            </button>
            {pendingCount > 0 && (
              <button
                type="button"
                className="btn-ghost text-xs"
                disabled={busy}
                onClick={() => setPending({})}
              >
                Clear pending
              </button>
            )}
          </div>
        )}

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        {success && <p className="mt-3 text-xs text-emerald-400">{success}</p>}
      </div>
    </div>
  );
}
