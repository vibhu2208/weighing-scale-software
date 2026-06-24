import React from 'react';

export default function ConfirmModal({
  open,
  title = 'Confirm',
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  dangerous = false,
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="card w-full max-w-md p-5">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <p className="mt-2 text-sm text-slate-300">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn-ghost">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={
              dangerous
                ? 'rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500'
                : 'btn-primary'
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
