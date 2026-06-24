import React from 'react';
import LocalImage from '../shared/LocalImage.jsx';
import { groupTripPhotosByPass } from '../../lib/tripPhotos.js';

export default function PhotoGalleryModal({ ticket, onClose }) {
  const images = ticket?.images || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Trip Photos</h2>
            <p className="text-xs text-slate-400">
              {ticket?.slip_number} · {images.length} photo{images.length === 1 ? '' : 's'}
            </p>
          </div>
          <button type="button" className="btn-ghost text-xs py-1" onClick={onClose}>
            Close
          </button>
        </div>
        {images.length === 0 ? (
          <p className="text-sm text-slate-500">No photos saved for this trip.</p>
        ) : (
          groupTripPhotosByPass(images).map((group) => (
            <div key={group.pass} className="mb-6">
              <p className="mb-3 text-xs uppercase tracking-widest text-slate-500">{group.title}</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {group.items.map((cam) => (
                  <figure key={`${group.pass}-${cam.path}-${cam.id || cam.label}`} className="text-center">
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
                    <figcaption className="mt-1 text-xs text-slate-500">
                      {cam.label || cam.id || 'Camera'}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
