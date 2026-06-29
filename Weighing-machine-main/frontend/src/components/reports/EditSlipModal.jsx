import React, { useEffect, useState } from 'react';
import { reportAPI } from '../../api/ipc.js';

export default function EditSlipModal({ ticket, onClose, onSaved }) {
  const [value, setValue] = useState(ticket?.slip_number || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setValue(ticket?.slip_number || '');
    setError('');
  }, [ticket]);

  if (!ticket) return null;

  async function save() {
    const next = String(value || '').trim();
    if (!next) {
      setError('Enter the corrected slip number');
      return;
    }
    if (next.toUpperCase() === String(ticket.slip_number || '').toUpperCase()) {
      setError('Enter a different slip number');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const result = await reportAPI.updateSlipNumber({
        transactionId: ticket.id,
        newSlipNumber: next,
      });
      if (result?.ok === false) {
        throw new Error(result.error || 'Could not update slip number');
      }
      onSaved?.(result.transaction || result);
      onClose();
    } catch (e) {
      setError(e.message || 'Could not update slip number');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-white">Edit slip number</h2>
        <p className="mt-1 text-xs text-slate-400">
          Fix a wrong slip number for this ticket. The next new ticket will still follow the
          existing slip counter — nothing else is changed.
        </p>

        <div className="mt-4 space-y-3">
          <p className="text-xs text-slate-400">
            Vehicle <span className="text-white">{ticket.truck_number}</span>
            {' · '}
            Current slip{' '}
            <span className="font-mono text-white">{ticket.slip_number}</span>
          </p>

          <label className="block text-xs text-slate-400">
            Corrected slip number
            <input
              type="text"
              className="field-input mt-1 w-full font-mono text-sm"
              value={value}
              onChange={(e) => setValue(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && !busy && save()}
              placeholder="e.g. WB0015 or 15"
              autoFocus
            />
          </label>

          <p className="text-[11px] text-slate-500">
            Requires Advance Setting to be unlocked in Settings. Closed tickets will have their
            report PDF regenerated with the new slip number.
          </p>
        </div>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save slip number'}
          </button>
        </div>
      </div>
    </div>
  );
}
