import React, { useEffect, useState } from 'react';
import { reportAPI } from '../../api/ipc.js';

export default function ReportPreviewModal({ transactionId, slipNumber, onClose }) {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const result = await reportAPI.getReportPreviewHtml(transactionId);
        if (!active) return;
        if (result?.ok && result.html) {
          setHtml(result.html);
        } else {
          setError(result?.error || 'Unable to load preview');
        }
      } catch (e) {
        if (active) setError(e.message || 'Preview failed');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [transactionId]);

  return (
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
          <button type="button" className="btn-ghost text-xs py-1" onClick={onClose}>
            Close
          </button>
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
  );
}
