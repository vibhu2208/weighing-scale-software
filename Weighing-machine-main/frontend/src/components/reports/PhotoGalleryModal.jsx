import React, { useMemo, useState } from 'react';
import LocalImage from '../shared/LocalImage.jsx';
import ReportPhotosEditor from './ReportPhotosEditor.jsx';
import { listReportPhotoSlots, photoSlotKey, resolvePhotoSlot } from '../../lib/tripPhotos.js';

export default function PhotoGalleryModal({ ticket, editable = false, onClose, onPhotosUpdated }) {
  const images = ticket?.images || [];
  const [editorOpen, setEditorOpen] = useState(false);

  const grouped = useMemo(
    () => listReportPhotoSlots(images, { includeEmpty: editable }),
    [images, editable],
  );

  function handleSaved(updated) {
    onPhotosUpdated?.(updated);
    setEditorOpen(false);
  }

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
        <div
          className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-white">Trip Photos</h2>
              <p className="text-xs text-slate-400">
                {ticket?.slip_number} · {images.length} photo{images.length === 1 ? '' : 's'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {editable && (
                <button
                  type="button"
                  className="btn-ghost text-xs py-1 border border-brand-700/40 text-brand-300"
                  onClick={() => setEditorOpen(true)}
                >
                  {images.length > 0 ? 'Edit photos' : 'Add photos'}
                </button>
              )}
              <button type="button" className="btn-ghost text-xs py-1" onClick={onClose}>
                Close
              </button>
            </div>
          </div>

          {!editable && images.length === 0 ? (
            <p className="text-sm text-slate-500">No photos saved for this trip.</p>
          ) : (
            grouped.map((group) => (
              <div key={group.pass} className="mb-6">
                <p className="mb-3 text-xs uppercase tracking-widest text-slate-500">{group.title}</p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  {group.items.map((cam) => {
                    const { pass, slot } = resolvePhotoSlot(cam);
                    const key = photoSlotKey(pass, slot);
                    const isEmpty = cam.empty || !cam.path;
                    return (
                      <figure key={key} className="text-center">
                        {isEmpty ? (
                          <div className="flex h-40 w-full items-center justify-center rounded border border-dashed border-slate-600 bg-slate-800 text-xs text-slate-500">
                            No photo
                          </div>
                        ) : (
                          <LocalImage
                            path={cam.path}
                            alt={cam.label || cam.pass}
                            className="h-40 w-full rounded border border-slate-700 object-cover bg-slate-800"
                            fallback={
                              <div className="flex h-40 w-full items-center justify-center rounded border border-dashed border-slate-600 bg-slate-800 text-xs text-slate-500">
                                Image missing
                              </div>
                            }
                          />
                        )}
                        <figcaption className="mt-1 text-xs text-slate-500">
                          {cam.label || `Camera ${slot}`}
                        </figcaption>
                        {editable && (
                          <button
                            type="button"
                            className="mt-1 text-xs text-brand-300 hover:text-brand-200"
                            onClick={() => setEditorOpen(true)}
                          >
                            {isEmpty ? 'Add' : 'Edit'}
                          </button>
                        )}
                      </figure>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {editorOpen && (
        <ReportPhotosEditor
          transactionId={ticket?.transactionId}
          slipNumber={ticket?.slip_number}
          images={images}
          editable={editable}
          onClose={() => setEditorOpen(false)}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
