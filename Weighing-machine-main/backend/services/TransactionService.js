'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/db');
const ts = require('../utils/timestamp');
const logger = require('../utils/logger');
const {
  TICKET_STATUS,
  TRANSACTION_STATUS,
  SYNC_STATUS,
} = require('../utils/constants');
const { isHywa } = require('../utils/vehicleTypes');
const SlipNumberService = require('./SlipNumberService');

function lookupVehicleType(truckNumber, rfidTag) {
  const db = getDb();
  if (truckNumber) {
    const normalized = String(truckNumber).trim().toUpperCase();
    const row = db
      .prepare(
        `SELECT vehicle_type FROM vehicles
         WHERE vehicle_number = ? AND status != 'inactive'`,
      )
      .get(normalized);
    if (row?.vehicle_type) return row.vehicle_type;
  }
  if (rfidTag) {
    const row = db
      .prepare(
        `SELECT vehicle_type FROM vehicles
         WHERE rfid_tag = ? AND status != 'inactive'`,
      )
      .get(String(rfidTag).trim());
    if (row?.vehicle_type) return row.vehicle_type;
  }
  return null;
}

function parseCameraSnapshotsField(raw) {
  if (!raw) return { tare: [], gross: [] };
  if (typeof raw === 'object') {
    return { tare: raw.tare || [], gross: raw.gross || [] };
  }
  try {
    const parsed = JSON.parse(raw);
    return { tare: parsed.tare || [], gross: parsed.gross || [] };
  } catch {
    return { tare: [], gross: [] };
  }
}

function rowToTransaction(row) {
  if (!row) return null;
  const { vehicle_number_join, owner_name, transporter, vehicle_type, ...txn } =
    row;
  const result = { ...txn };
  if (result.camera_snapshots != null) {
    result.camera_snapshots = parseCameraSnapshotsField(result.camera_snapshots);
  }
  if (vehicle_number_join || owner_name) {
    result.vehicle = {
      vehicle_number: vehicle_number_join || null,
      owner_name: owner_name || null,
      transporter: transporter || null,
      vehicle_type: vehicle_type || null,
    };
  }
  return result;
}

const SELECT_WITH_VEHICLE = `
  SELECT
    t.*,
    v.vehicle_number AS vehicle_number_join,
    v.owner_name,
    v.transporter,
    v.vehicle_type
  FROM transactions t
  LEFT JOIN vehicles v ON (
    v.vehicle_number = t.truck_number
    OR (t.rfid_tag IS NOT NULL AND v.rfid_tag = t.rfid_tag)
  )
`;

function ensureSlipCounter(db) {
  const row = db.prepare('SELECT id FROM slip_counter LIMIT 1').get();
  if (row) return;
  const now = ts.now();
  db.prepare(
    `INSERT INTO slip_counter (prefix, current_value, updated_at)
     VALUES ('WB', 0, ?)`,
  ).run(now);
  logger.info('Initialised slip_counter', { prefix: 'WB', current_value: 0 });
}

const TransactionService = {
  ensureSlipCounter() {
    ensureSlipCounter(getDb());
  },

  generateSlipNumber() {
    return SlipNumberService.generateSlipNumberLocal();
  },

  generateSlipNumberLocal() {
    return SlipNumberService.generateSlipNumberLocal();
  },

  /** Single source of truth: OPEN ticket by vehicle number or RFID. */
  findOpenTicketByTruck(truckNumber) {
    if (!truckNumber) return null;
    const normalized = String(truckNumber).trim().toUpperCase();
    return rowToTransaction(
      getDb()
        .prepare(
          `${SELECT_WITH_VEHICLE}
           WHERE t.truck_number = ?
             AND t.ticket_status = ?
           ORDER BY t.created_at DESC
           LIMIT 1`,
        )
        .get(normalized, TICKET_STATUS.OPEN),
    );
  },

  findOpenTicketByRFID(rfidTag) {
    if (!rfidTag) return null;
    return rowToTransaction(
      getDb()
        .prepare(
          `${SELECT_WITH_VEHICLE}
           WHERE t.rfid_tag = ?
             AND t.ticket_status = ?
           ORDER BY t.created_at DESC
           LIMIT 1`,
        )
        .get(String(rfidTag).trim().toUpperCase(), TICKET_STATUS.OPEN),
    );
  },

  findOpenTicket(truckNumber, rfidTag) {
    return (
      this.findOpenTicketByTruck(truckNumber) ||
      (rfidTag ? this.findOpenTicketByRFID(rfidTag) : null)
    );
  },

  findOpenTicketById(id) {
    if (!id) return null;
    return rowToTransaction(
      getDb()
        .prepare(
          `${SELECT_WITH_VEHICLE}
           WHERE t.id = ?
             AND t.ticket_status = ?
           LIMIT 1`,
        )
        .get(id, TICKET_STATUS.OPEN),
    );
  },

  /** @deprecated use findOpenTicket */
  findOpenTripByTruck(truckNumber) {
    return this.findOpenTicketByTruck(truckNumber);
  },

  /** @deprecated use findOpenTicket */
  findOpenTripByRFID(rfidTag) {
    return this.findOpenTicketByRFID(rfidTag);
  },

  /** @deprecated use findOpenTicket */
  findOpenTripForVehicle(truckNumber, rfidTag) {
    return this.findOpenTicket(truckNumber, rfidTag);
  },

  /** @deprecated use findOpenTicket */
  findOpenForVehicle(truckNumber, rfidTag) {
    return this.findOpenTicket(truckNumber, rfidTag);
  },

  /** @deprecated */
  findOpenByTruck(truckNumber) {
    return this.findOpenTicketByTruck(truckNumber);
  },

  /** @deprecated */
  findOpenByRFID(rfidTag) {
    return this.findOpenTicketByRFID(rfidTag);
  },

  listOpenTickets() {
    return getDb()
      .prepare(
        `${SELECT_WITH_VEHICLE}
         WHERE t.ticket_status = ?
         ORDER BY t.timestamp_in ASC`,
      )
      .all(TICKET_STATUS.OPEN)
      .map(rowToTransaction);
  },

  getVehicleWeighmentInfo(truckNumber, rfidTag) {
    const openTicket = this.findOpenTicket(truckNumber, rfidTag);
    const normalized = truckNumber
      ? String(truckNumber).trim().toUpperCase()
      : null;

    let lastTripSlip = null;
    if (normalized) {
      const lastCompleted = getDb()
        .prepare(
          `SELECT slip_number FROM transactions
           WHERE truck_number = ?
             AND ticket_status = ?
           ORDER BY COALESCE(timestamp_out, updated_at) DESC
           LIMIT 1`,
        )
        .get(normalized, TICKET_STATUS.CLOSED);
      lastTripSlip = lastCompleted?.slip_number || null;
    }

    const hasOpen = !!openTicket;
    const mode = hasOpen ? 'CLOSE' : 'OPEN';
    const ticketStatus = hasOpen ? 'open' : 'closed';

    let vehicleType = openTicket?.vehicle?.vehicle_type || null;
    if (!vehicleType) {
      vehicleType = lookupVehicleType(normalized, rfidTag);
    }
    const hywa = isHywa(vehicleType);

    return {
      mode,
      ticketStatus,
      openTicket: openTicket || null,
      openSlip: openTicket?.slip_number || null,
      openTransactionId: openTicket?.id || null,
      lastTripSlip,
      trip: hasOpen ? openTicket?.slip_number || null : lastTripSlip,
      isHywa: hywa,
      vehicleType,
    };
  },

  create(data) {
    const db = getDb();
    const truckNumber = String(data.truck_number || '')
      .trim()
      .toUpperCase();
    if (!truckNumber) {
      throw new Error('truck_number is required');
    }

    const existing = this.findOpenTicketByTruck(truckNumber);
    if (existing) {
      return {
        isDuplicate: true,
        existingId: existing.id,
        transaction: existing,
      };
    }

    const grossWeight =
      data.gross_weight !== undefined && data.gross_weight !== null
        ? Number(data.gross_weight)
        : null;
    const tareWeight =
      data.tare_weight !== undefined && data.tare_weight !== null
        ? Number(data.tare_weight)
        : null;

    let status = data.status || TRANSACTION_STATUS.PENDING;
    if (
      grossWeight !== null &&
      tareWeight !== null &&
      !Number.isNaN(grossWeight) &&
      !Number.isNaN(tareWeight) &&
      grossWeight < tareWeight
    ) {
      status = TRANSACTION_STATUS.ERROR;
      logger.warn('Transaction net weight would be negative — flagged as error', {
        truck_number: truckNumber,
        gross_weight: grossWeight,
        tare_weight: tareWeight,
      });
    }

    const id = uuidv4();
    const now = ts.now();
    const slipNumber = data.slip_number || this.generateSlipNumber();
    const syncStatus = data.sync_status || SYNC_STATUS.PENDING;
    const ticketStatus = data.ticket_status || TICKET_STATUS.OPEN;

    const insert = db.transaction(() => {
      db.prepare(
        `INSERT INTO transactions (
          id, truck_number, rfid_tag, gross_weight, tare_weight,
          timestamp_in, timestamp_out, image_path, operator_id,
          slip_number, sync_status, status, notes, created_at, updated_at,
          ticket_status, material, driver, customer_name, destination, operator_name,
          arrival_photo_1, arrival_photo_2, arrival_photo_3,
          departure_photo_1, departure_photo_2, departure_photo_3,
          report_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        truckNumber,
        data.rfid_tag || null,
        grossWeight,
        tareWeight,
        data.timestamp_in || now,
        data.timestamp_out || null,
        data.image_path || null,
        data.operator_id || null,
        slipNumber,
        syncStatus,
        status,
        data.notes || null,
        now,
        now,
        ticketStatus,
        data.material || null,
        data.driver || null,
        data.customer_name || null,
        data.destination || null,
        data.operator_name || null,
        data.arrival_photo_1 || null,
        data.arrival_photo_2 || null,
        data.arrival_photo_3 || null,
        data.departure_photo_1 || null,
        data.departure_photo_2 || null,
        data.departure_photo_3 || null,
        data.report_path || null,
      );
    });

    insert();
    return { isDuplicate: false, transaction: this.getById(id) };
  },

  getByRemotePgId(remotePgId) {
    if (!remotePgId) return null;
    return rowToTransaction(
      getDb()
        .prepare(`${SELECT_WITH_VEHICLE} WHERE t.remote_pg_id = ? LIMIT 1`)
        .get(String(remotePgId)),
    );
  },

  getBySlipNumber(slipNumber) {
    if (!slipNumber) return null;
    return rowToTransaction(
      getDb()
        .prepare(`${SELECT_WITH_VEHICLE} WHERE t.slip_number = ? LIMIT 1`)
        .get(String(slipNumber).trim()),
    );
  },

  /**
   * Import a closed trip from RDS into local SQLite (dedup by remote_pg_id / slip_number).
   */
  importClosedTrip(data) {
    const remotePgId = data.remote_pg_id ? String(data.remote_pg_id).trim() : null;
    if (!remotePgId) {
      throw new Error('remote_pg_id is required for import');
    }

    const existingByPg = this.getByRemotePgId(remotePgId);
    if (existingByPg) {
      return { imported: false, transaction: existingByPg, existing: true };
    }

    const slipNumber = String(data.slip_number || '').trim();
    if (!slipNumber) {
      throw new Error('slip_number is required for import');
    }

    const existingBySlip = this.getBySlipNumber(slipNumber);
    if (existingBySlip) {
      return { imported: false, transaction: existingBySlip, existing: true };
    }

    const truckNumber = String(data.truck_number || '')
      .trim()
      .toUpperCase();
    if (!truckNumber) {
      throw new Error('truck_number is required for import');
    }

    const grossWeight = Number(data.gross_weight);
    const tareWeight = Number(data.tare_weight);
    if (!Number.isFinite(grossWeight) || !Number.isFinite(tareWeight)) {
      throw new Error('gross_weight and tare_weight are required for import');
    }

    const id = data.id ? String(data.id) : uuidv4();
    const now = ts.now();
    const timestampIn = data.timestamp_in || now;
    const timestampOut = data.timestamp_out || now;

    const db = getDb();
    const insert = db.transaction(() => {
      db.prepare(
        `INSERT INTO transactions (
          id, truck_number, rfid_tag, gross_weight, tare_weight,
          timestamp_in, timestamp_out, image_path, operator_id,
          slip_number, sync_status, status, notes, created_at, updated_at,
          ticket_status, material, driver, customer_name, destination, operator_name,
          arrival_photo_1, arrival_photo_2, arrival_photo_3,
          departure_photo_1, departure_photo_2, departure_photo_3,
          report_path, remote_pg_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        truckNumber,
        data.rfid_tag || null,
        grossWeight,
        tareWeight,
        timestampIn,
        timestampOut,
        data.image_path || data.departure_photo_1 || data.arrival_photo_1 || null,
        data.operator_id || null,
        slipNumber,
        SYNC_STATUS.SYNCED,
        data.status || TRANSACTION_STATUS.CAPTURED,
        data.notes || null,
        now,
        now,
        TICKET_STATUS.CLOSED,
        data.material || null,
        data.driver || null,
        data.customer_name || null,
        data.destination || null,
        data.operator_name || null,
        data.arrival_photo_1 || null,
        data.arrival_photo_2 || null,
        data.arrival_photo_3 || null,
        data.departure_photo_1 || null,
        data.departure_photo_2 || null,
        data.departure_photo_3 || null,
        data.report_path || null,
        remotePgId,
      );
    });

    insert();

    const numeric = SlipNumberService.parseSlipNumeric(slipNumber);
    if (numeric > 0) {
      ensureSlipCounter(db);
      const row = db
        .prepare('SELECT id, current_value FROM slip_counter ORDER BY id LIMIT 1')
        .get();
      if (row && row.current_value < numeric) {
        db.prepare(
          'UPDATE slip_counter SET current_value = ?, updated_at = ? WHERE id = ?',
        ).run(numeric, now, row.id);
      }
    }

    logger.info('Imported closed trip from RDS', {
      transactionId: id,
      slipNumber,
      remotePgId,
    });

    return {
      imported: true,
      transaction: this.getById(id),
      existing: false,
    };
  },

  updateFields(id, fields = {}) {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Transaction not found: ${id}`);

    const allowed = [
      'gross_weight',
      'tare_weight',
      'raw_gross_weight',
      'raw_tare_weight',
      'weight_offset_kg',
      'image_path',
      'tare_image_path',
      'camera_snapshots',
      'timestamp_out',
      'timestamp_in',
      'status',
      'sync_status',
      'operator_id',
      'notes',
      'ticket_status',
      'material',
      'driver',
      'customer_name',
      'destination',
      'operator_name',
      'arrival_photo_1',
      'arrival_photo_2',
      'arrival_photo_3',
      'departure_photo_1',
      'departure_photo_2',
      'departure_photo_3',
      'report_path',
      'mcg_status',
      'mcg_error',
      'mcg_sent_at',
    ];
    const sets = [];
    const params = [];

    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(fields[key]);
      }
    }

    if (!sets.length) return existing;

    const now = ts.now();
    sets.push('updated_at = ?');
    params.push(now, id);

    getDb()
      .prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);

    return this.getById(id);
  },

  cancelTicket(id) {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Transaction not found: ${id}`);
    if (existing.ticket_status !== TICKET_STATUS.OPEN) {
      throw new Error('Only OPEN tickets can be cancelled');
    }
    return this.updateFields(id, {
      ticket_status: TICKET_STATUS.CANCELLED,
      status: TRANSACTION_STATUS.CANCELLED,
      notes: existing.notes
        ? `${existing.notes}; Cancelled by operator`
        : 'Cancelled by operator',
    });
  },

  getAll(filters = {}) {
    const db = getDb();
    const clauses = [];
    const params = [];

    if (filters.date) {
      clauses.push('DATE(t.timestamp_in) = DATE(?)');
      params.push(filters.date);
    }
    if (filters.status) {
      clauses.push('t.status = ?');
      params.push(filters.status);
    }
    if (filters.ticket_status) {
      clauses.push('t.ticket_status = ?');
      params.push(filters.ticket_status);
    }
    if (filters.truck_number) {
      clauses.push('UPPER(t.truck_number) = ?');
      params.push(String(filters.truck_number).trim().toUpperCase());
    }
    if (filters.sync_status) {
      clauses.push('t.sync_status = ?');
      params.push(filters.sync_status);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    return db
      .prepare(
        `${SELECT_WITH_VEHICLE}
         ${where}
         ORDER BY t.timestamp_in DESC`,
      )
      .all(...params)
      .map(rowToTransaction);
  },

  getById(id) {
    return rowToTransaction(
      getDb()
        .prepare(`${SELECT_WITH_VEHICLE} WHERE t.id = ?`)
        .get(id),
    );
  },

  updateStatus(id, status) {
    return this.updateFields(id, { status });
  },

  getOrphanedCaptured() {
    return getDb()
      .prepare(
        `${SELECT_WITH_VEHICLE}
         WHERE t.status = 'captured'`,
      )
      .all()
      .map(rowToTransaction);
  },

  getTodayStats() {
    const start = ts.todayStart();
    const end = ts.todayEnd();
    const db = getDb();
    const reportDateSql = `CASE
      WHEN ticket_status = 'CLOSED' THEN COALESCE(timestamp_out, updated_at)
      ELSE timestamp_in
    END`;

    const total = db
      .prepare(
        `SELECT COUNT(*) AS count FROM transactions
         WHERE ${reportDateSql} >= ? AND ${reportDateSql} <= ?`,
      )
      .get(start, end).count;

    const pending = db
      .prepare(
        `SELECT COUNT(*) AS count FROM transactions
         WHERE timestamp_in >= ? AND timestamp_in <= ?
           AND ticket_status = ?`,
      )
      .get(start, end, TICKET_STATUS.OPEN).count;

    const completed = db
      .prepare(
        `SELECT COUNT(*) AS count FROM transactions
         WHERE timestamp_out >= ? AND timestamp_out <= ?
           AND ticket_status = ?`,
      )
      .get(start, end, TICKET_STATUS.CLOSED).count;

    const weightRow = db
      .prepare(
        `SELECT COALESCE(SUM(net_weight), 0) AS totalWeight FROM transactions
         WHERE timestamp_out >= ? AND timestamp_out <= ?
           AND ticket_status = ?`,
      )
      .get(start, end, TICKET_STATUS.CLOSED);

    return {
      total,
      pending,
      completed,
      totalWeight: weightRow.totalWeight || 0,
    };
  },

  getUnsyncedTransactions() {
    return getDb()
      .prepare(
        `${SELECT_WITH_VEHICLE}
         WHERE t.sync_status IN ('pending', 'retry')
         ORDER BY t.timestamp_in ASC`,
      )
      .all()
      .map(rowToTransaction);
  },

  markSynced(id) {
    const now = ts.now();
    const db = getDb();
    const apply = db.transaction(() => {
      db.prepare(
        `UPDATE transactions SET sync_status = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      ).run(SYNC_STATUS.SYNCED, TRANSACTION_STATUS.SYNCED, now, id);

      db.prepare('DELETE FROM sync_queue WHERE transaction_id = ?').run(id);
    });
    apply();
    return this.getById(id);
  },

  markSyncFailed(id, errorMessage) {
    const now = ts.now();
    const db = getDb();

    const apply = db.transaction(() => {
      db.prepare(
        `UPDATE transactions SET sync_status = ?, updated_at = ? WHERE id = ?`,
      ).run(SYNC_STATUS.FAILED, now, id);

      const existing = db
        .prepare('SELECT id, retry_count FROM sync_queue WHERE transaction_id = ?')
        .get(id);

      if (existing) {
        db.prepare(
          `UPDATE sync_queue SET
            sync_status = ?,
            retry_count = retry_count + 1,
            last_attempt = ?,
            error_message = ?
           WHERE transaction_id = ?`,
        ).run(SYNC_STATUS.RETRY, now, errorMessage || null, id);
      } else {
        db.prepare(
          `INSERT INTO sync_queue (transaction_id, retry_count, sync_status, last_attempt, error_message, created_at)
           VALUES (?, 1, ?, ?, ?, ?)`,
        ).run(id, SYNC_STATUS.RETRY, now, errorMessage || null, now);
      }
    });

    apply();
    return this.getById(id);
  },
};

module.exports = TransactionService;
