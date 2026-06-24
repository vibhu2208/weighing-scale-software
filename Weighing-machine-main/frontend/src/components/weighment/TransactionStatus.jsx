import React from 'react';
import Badge from '../shared/Badge.jsx';

export default function TransactionStatus({ status = 'pending' }) {
  const tone =
    {
      pending: 'amber',
      weighing: 'blue',
      captured: 'indigo',
      printed: 'emerald',
      synced: 'emerald',
      failed: 'red',
    }[status] || 'slate';
  return <Badge tone={tone}>{status}</Badge>;
}
