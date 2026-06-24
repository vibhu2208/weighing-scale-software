import React from 'react';

export default function PrintButton({ onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
    >
      Print Ticket
    </button>
  );
}
