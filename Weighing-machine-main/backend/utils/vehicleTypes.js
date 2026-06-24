'use strict';

const HYWA_TYPE = 'hywa';

function isHywa(vehicleType) {
  return String(vehicleType || '').trim().toLowerCase() === HYWA_TYPE;
}

/**
 * Weight-adjustment pass for save / live preview.
 * Standard: open=TARE, close=GROSS. HYWA: open=GROSS, close=TARE.
 */
function resolveAdjustmentPass({ vehicleType, isClose }) {
  const hywa = isHywa(vehicleType);
  if (isClose) {
    return hywa ? 'TARE' : 'GROSS';
  }
  return hywa ? 'GROSS' : 'TARE';
}

/** True when open ticket has captured its first weigh (tare for standard, gross for HYWA). */
function openTicketHasFirstWeigh(ticket, vehicleType) {
  if (!ticket) return false;
  if (isHywa(vehicleType)) {
    const gross = Number(ticket.gross_weight);
    return ticket.gross_weight != null && Number.isFinite(gross) && gross > 0;
  }
  const tare = Number(ticket.tare_weight);
  return ticket.tare_weight != null && Number.isFinite(tare) && tare > 0;
}

function resolveVehicleType(vehicle, ticket) {
  return (
    vehicle?.vehicle_type ||
    ticket?.vehicle?.vehicle_type ||
    null
  );
}

/** Timestamp for gross weight line on slips/reports. */
function grossWeightTimestamp(row, vehicleType) {
  const type = vehicleType || row?.vehicle_type || row?.vehicle?.vehicle_type;
  return isHywa(type) ? row?.timestamp_in : row?.timestamp_out;
}

/** Timestamp for tare weight line on slips/reports. */
function tareWeightTimestamp(row, vehicleType) {
  const type = vehicleType || row?.vehicle_type || row?.vehicle?.vehicle_type;
  return isHywa(type) ? row?.timestamp_out : row?.timestamp_in;
}

/** When net weight was recorded (ticket close / second weigh). */
function netWeightTimestamp(row) {
  if (!row) return null;
  if (String(row.ticket_status || '').toUpperCase() === 'CLOSED') {
    return row.timestamp_out || row.updated_at || null;
  }
  return row.timestamp_out || null;
}

/** Date used to place a ticket in daily report sections. */
function reportListingTimestamp(row) {
  if (!row) return null;
  if (String(row.ticket_status || '').toUpperCase() === 'CLOSED') {
    return netWeightTimestamp(row) || row.timestamp_in || row.created_at || null;
  }
  return row.timestamp_in || row.created_at || null;
}

module.exports = {
  HYWA_TYPE,
  isHywa,
  resolveAdjustmentPass,
  openTicketHasFirstWeigh,
  resolveVehicleType,
  grossWeightTimestamp,
  tareWeightTimestamp,
  netWeightTimestamp,
  reportListingTimestamp,
};
