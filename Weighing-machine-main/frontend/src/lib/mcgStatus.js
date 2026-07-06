/** MCG portal send status for closed tickets in Reports. */

export function mcgStatusLabel(ticket) {
  if (!ticket || ticket.ticket_status !== 'CLOSED') return '—';
  const status = (ticket.mcg_status || '').toLowerCase();
  if (status === 'sent') return 'Sent';
  if (status === 'failed') return 'Failed';
  if (status === 'skipped') return 'Skipped';
  if (status === 'pending') return 'Pending';
  return 'Not sent';
}

export function mcgStatusVariant(ticket) {
  if (!ticket || ticket.ticket_status !== 'CLOSED') return 'default';
  const status = (ticket.mcg_status || '').toLowerCase();
  if (status === 'sent') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'skipped') return 'default';
  if (status === 'pending') return 'warning';
  return 'warning';
}

export function mcgStatusTitle(ticket) {
  if (!ticket?.mcg_error) return undefined;
  return String(ticket.mcg_error);
}

export function isMcgSkipped(ticket) {
  if (!ticket || ticket.ticket_status !== 'CLOSED') return false;
  return (ticket.mcg_status || '').toLowerCase() === 'skipped';
}
