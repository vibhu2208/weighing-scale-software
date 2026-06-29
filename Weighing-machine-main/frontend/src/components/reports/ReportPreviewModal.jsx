import React, { useCallback, useEffect, useState } from 'react';
import { reportAPI } from '../../api/ipc.js';
import ReportPhotosEditor from './ReportPhotosEditor.jsx';
import { listTripCameraImages } from '../../lib/tripPhotos.js';

export default function ReportPreviewModal({
  transactionId,
  slipNumber,
  editable = false,
  ticket,
  onClose,
  onPhotosUpdated,
}) {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [photos, setPhotos] = useState(() => listTripCameraImages(ticket));

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await reportAPI.getReportPreviewHtml(transactionId);
      if (result?.ok && result.html) {
        setHtml(result.html);
      } else {
        setError(result?.error || 'Unable to load preview');
      }
    } catch (e) {
      setError(e.message || 'Preview failed');
    } finally {
      setLoading(false);
    }
  }, [transactionId]);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  function handlePhotosSaved(updated) {
    const txn = updated?.transaction || updated;
    if (txn) {
      setPhotos(listTripCameraImages(txn));
    }
    onPhotosUpdated?.(updated);
    setEditorOpen(false);
    loadPreview();
  }

  const canEditPhotos = editable;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
        <div
          className="flex max-h-[95vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
            <div>
              <h2 className="text-lg font-semibold text-white">Report Preview</h2>
              <p className="text-xs text-slate-400">{slipNumber || transactionId}</p>
            </div>
            <div className="flex items-center gap-2">
              {canEditPhotos && (
                <button
                  type="button"
                  className="btn-ghost text-xs py-1 border border-brand-700/40 text-brand-300"
                  onClick={() => setEditorOpen(true)}
                >
                  {photos.length > 0 ? 'Edit photos' : 'Add photos'}
                </button>
              )}
              <button type="button" className="btn-ghost text-xs py-1" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto bg-slate-200 p-4">
            {loading && <p className="p-8 text-center text-slate-600">Loading preview…</p>}
            {!loading && error && <p className="p-8 text-center text-red-600">{error}</p>}
            {!loading && html && (
              <iframe
                title={`Report preview ${slipNumber || transactionId}`}
                srcDoc={html}
                className="mx-auto min-h-[80vh] w-full max-w-[820px] rounded border border-slate-300 bg-white shadow"
              />
            )}
          </div>
        </div>
      </div>

      {editorOpen && (
        <ReportPhotosEditor
          transactionId={transactionId}
          slipNumber={slipNumber}
          images={photos}
          editable={editable}
          onClose={() => setEditorOpen(false)}
          onSaved={handlePhotosSaved}
        />
      )}
    </>
  );
}
