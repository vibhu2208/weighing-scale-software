'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/db');
const ts = require('../utils/timestamp');
const TransactionService = require('./TransactionService');

function rowToVehicle(row) {
  if (!row) return null;
  return { ...row };
}

function attachWeighmentInfo(vehicle) {
  if (!vehicle) return vehicle;
  const info = TransactionService.getVehicleWeighmentInfo(
    vehicle.vehicle_number,
    vehicle.rfid_tag,
  );
  return {
    ...vehicle,
    ticket_status: info.ticketStatus,
    weigh_mode: info.mode,
    open_slip: info.openSlip,
    trip: info.trip,
    last_trip_slip: info.lastTripSlip,
  };
}

function mapVehicles(rows) {
  return rows.map((row) => attachWeighmentInfo(rowToVehicle(row)));
}

function normalizeVehicleNumber(number) {
  if (!number || typeof number !== 'string' || !number.trim()) {
    throw new Error('vehicle_number is required and must be non-empty');
  }
  return number.trim().toUpperCase();
}

function assertUniqueRfid(db, rfidTag, excludeId = null) {
  if (!rfidTag) return;
  const existing = db
    .prepare(
      `SELECT id, vehicle_number FROM vehicles
       WHERE rfid_tag = ? AND status != 'inactive'${excludeId ? ' AND id != ?' : ''}`,
    )
    .get(excludeId ? [rfidTag, excludeId] : [rfidTag]);
  if (existing) {
    throw new Error(
      `rfid_tag "${rfidTag}" is already assigned to vehicle ${existing.vehicle_number}`,
    );
  }
}

function validateMaxCapacity(maxCapacity) {
  if (maxCapacity === undefined || maxCapacity === null || maxCapacity === '') {
    return null;
  }
  const n = Number(maxCapacity);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error('max_capacity must be a positive number');
  }
  return n;
}

const VehicleService = {
  getAll(options = {}) {
    const includeInactive = !!options.includeInactive;
    const sql = includeInactive
      ? `SELECT * FROM vehicles ORDER BY vehicle_number ASC`
      : `SELECT * FROM vehicles WHERE status != 'inactive' ORDER BY vehicle_number ASC`;
    return mapVehicles(getDb().prepare(sql).all());
  },

  getById(id) {
    return attachWeighmentInfo(
      rowToVehicle(getDb().prepare('SELECT * FROM vehicles WHERE id = ?').get(id)),
    );
  },

  findByRFID(rfidTag) {
    if (!rfidTag) return null;
    return attachWeighmentInfo(
      rowToVehicle(
        getDb()
          .prepare(
            `SELECT * FROM vehicles
           WHERE rfid_tag = ? AND status != 'inactive'`,
          )
          .get(rfidTag),
      ),
    );
  },

  findByNumber(number) {
    if (!number) return null;
    const normalized = normalizeVehicleNumber(number);
    return attachWeighmentInfo(
      rowToVehicle(
        getDb()
          .prepare(
            `SELECT * FROM vehicles
           WHERE vehicle_number = ? AND status != 'inactive'`,
          )
          .get(normalized),
      ),
    );
  },

  getWeighmentInfo(truckNumber, rfidTag) {
    return TransactionService.getVehicleWeighmentInfo(truckNumber, rfidTag);
  },

  create(data) {
    const db = getDb();
    const vehicleNumber = normalizeVehicleNumber(data.vehicle_number);
    const rfidTag = data.rfid_tag ? String(data.rfid_tag).trim() : null;
    const maxCapacity = validateMaxCapacity(data.max_capacity);

    assertUniqueRfid(db, rfidTag);

    const existingNumber = db
      .prepare('SELECT id FROM vehicles WHERE vehicle_number = ?')
      .get(vehicleNumber);
    if (existingNumber) {
      throw new Error(`vehicle_number "${vehicleNumber}" already exists`);
    }

    const id = uuidv4();
    const now = ts.now();

    db.prepare(
      `INSERT INTO vehicles (
        id, vehicle_number, rfid_tag, owner_name, transporter,
        vehicle_type, max_capacity, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      vehicleNumber,
      rfidTag,
      data.owner_name || null,
      data.transporter || null,
      data.vehicle_type || null,
      maxCapacity,
      data.status || 'active',
      now,
      now,
    );

    return this.getById(id);
  },

  update(id, data) {
    const db = getDb();
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Vehicle not found: ${id}`);
    }

    const vehicleNumber =
      data.vehicle_number !== undefined
        ? normalizeVehicleNumber(data.vehicle_number)
        : existing.vehicle_number;

    const rfidTag =
      data.rfid_tag !== undefined
        ? data.rfid_tag
          ? String(data.rfid_tag).trim()
          : null
        : existing.rfid_tag;

    const maxCapacity =
      data.max_capacity !== undefined
        ? validateMaxCapacity(data.max_capacity)
        : existing.max_capacity;

    assertUniqueRfid(db, rfidTag, id);

    if (vehicleNumber !== existing.vehicle_number) {
      const clash = db
        .prepare('SELECT id FROM vehicles WHERE vehicle_number = ? AND id != ?')
        .get(vehicleNumber, id);
      if (clash) {
        throw new Error(`vehicle_number "${vehicleNumber}" already exists`);
      }
    }

    const now = ts.now();

    db.prepare(
      `UPDATE vehicles SET
        vehicle_number = ?,
        rfid_tag = ?,
        owner_name = ?,
        transporter = ?,
        vehicle_type = ?,
        max_capacity = ?,
        status = ?,
        updated_at = ?
      WHERE id = ?`,
    ).run(
      vehicleNumber,
      rfidTag,
      data.owner_name !== undefined ? data.owner_name : existing.owner_name,
      data.transporter !== undefined ? data.transporter : existing.transporter,
      data.vehicle_type !== undefined ? data.vehicle_type : existing.vehicle_type,
      maxCapacity,
      data.status !== undefined ? data.status : existing.status,
      now,
      id,
    );

    return this.getById(id);
  },

  delete(id) {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Vehicle not found: ${id}`);
    }
    const now = ts.now();
    getDb()
      .prepare(`UPDATE vehicles SET status = 'inactive', updated_at = ? WHERE id = ?`)
      .run(now, id);
    return { ok: true, id };
  },

  search(query) {
    if (!query || !String(query).trim()) {
      return this.getAll();
    }
    const q = `%${String(query).trim().toUpperCase()}%`;
    return mapVehicles(
      getDb()
        .prepare(
          `SELECT * FROM vehicles
         WHERE status != 'inactive'
           AND (UPPER(vehicle_number) LIKE ? OR UPPER(owner_name) LIKE ?)
         ORDER BY vehicle_number ASC`,
        )
        .all(q, q),
    );
  },
};

module.exports = VehicleService;
