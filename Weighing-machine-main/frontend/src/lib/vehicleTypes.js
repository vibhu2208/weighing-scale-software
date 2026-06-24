export const VEHICLE_TYPES = ['truck', 'tanker', 'container', 'hywa'];

const HYWA_TYPE = 'hywa';

export function isHywa(vehicleType) {
  return String(vehicleType || '').trim().toLowerCase() === HYWA_TYPE;
}

/** Weight-adjustment pass: standard open=TARE close=GROSS; HYWA open=GROSS close=TARE. */
export function resolveAdjustmentPass({ vehicleType, isClose }) {
  const hywa = isHywa(vehicleType);
  if (isClose) {
    return hywa ? 'TARE' : 'GROSS';
  }
  return hywa ? 'GROSS' : 'TARE';
}

export function openTicketHasFirstWeigh(ticket, vehicleType) {
  if (!ticket) return false;
  if (isHywa(vehicleType)) {
    const gross = Number(ticket.gross_weight);
    return ticket.gross_weight != null && Number.isFinite(gross) && gross > 0;
  }
  const tare = Number(ticket.tare_weight);
  return ticket.tare_weight != null && Number.isFinite(tare) && tare > 0;
}

export function resolveVehicleType(vehicle, ticket) {
  return vehicle?.vehicle_type || ticket?.vehicle?.vehicle_type || null;
}

/** Live weight label for weighment screen. */
export function liveWeightLabel({ vehicleType, isClose }) {
  const pass = resolveAdjustmentPass({ vehicleType, isClose });
  return pass === 'GROSS' ? 'Gross weight (live)' : 'Tare weight (live)';
}

/** First weigh captured on open ticket (for display in close mode / open ticket list). */
export function openTicketFirstWeighKg(ticket, vehicleType) {
  if (!ticket) return null;
  return isHywa(vehicleType) ? ticket.gross_weight : ticket.tare_weight;
}

export function openTicketFirstWeighLabel(vehicleType) {
  return isHywa(vehicleType) ? 'Gross' : 'Tare';
}
