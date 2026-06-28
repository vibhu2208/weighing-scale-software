/** Display ticket lifecycle for UI badges (prefers ticket_status over legacy status). */
import { isHywa, resolveVehicleType } from './vehicleTypes.js';

export function ticketStatusLabel(transaction) {
  if (!transaction) return '—';
  const ticket = transaction.ticket_status;
  if (ticket === 'OPEN') return 'Open';
  if (ticket === 'CLOSED') return 'Closed';
  if (ticket === 'CANCELLED') return 'Cancelled';

  const legacy = transaction.status;
  if (legacy === 'error' || legacy === 'cancelled') return 'Cancelled';
  if (legacy === 'weighing' || legacy === 'pending') return 'Open';
  if (legacy === 'captured' || legacy === 'printed' || legacy === 'synced') {
    return 'Closed';
  }
  return legacy || '—';
}

/** True when ticket has both weighs captured (matches backend isClosedTrip). */
export function isClosedTicket(transaction) {
  if (!transaction) return false;
  if (transaction.ticket_status === 'CLOSED') return true;
  if (transaction.ticket_status === 'OPEN' || transaction.ticket_status === 'CANCELLED') {
    return false;
  }
  return transaction.gross_weight != null && transaction.tare_weight != null;
}

/** True when ticket can be closed from Reports / Weighment (matches listOpenTickets). */
export function isClosableOpenTicket(transaction) {
  if (!transaction?.id) return false;
  if (transaction.ticket_status !== 'OPEN') return false;
  const vehicleType = resolveVehicleType(transaction.vehicle, transaction);
  if (isHywa(vehicleType)) {
    const gross = Number(transaction.gross_weight);
    return transaction.gross_weight != null && Number.isFinite(gross) && gross > 0;
  }
  const tare = Number(transaction.tare_weight);
  return transaction.tare_weight != null && Number.isFinite(tare) && tare > 0;
}

export function isStuckOpenTicket(transaction) {
  if (!isClosableOpenTicket(transaction)) return false;
  const legacy = transaction.status;
  return legacy === 'error' || legacy === 'failed' || legacy === 'cancelled';
}

export function ticketStatusVariant(transaction) {
  const label = ticketStatusLabel(transaction);
  if (label === 'Open') return 'warning';
  if (label === 'Closed') return 'success';
  if (label === 'Cancelled') return 'danger';
  if (transaction?.status === 'synced' || transaction?.status === 'printed') {
    return 'success';
  }
  if (transaction?.status === 'error' || transaction?.status === 'failed') {
    return 'danger';
  }
  if (transaction?.status === 'pending' || transaction?.status === 'weighing') {
    return 'warning';
  }
  return 'default';
}
