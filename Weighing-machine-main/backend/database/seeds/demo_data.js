'use strict';

const { v4: uuidv4 } = require('uuid');
const ts = require('../../utils/timestamp');
const { TRANSACTION_STATUS, SYNC_STATUS } = require('../../utils/constants');

const DEMO_VEHICLES = [
  {
    vehicle_number: 'MH12AB1234',
    rfid_tag: 'E280117000000208AABBCC01',
    owner_name: 'Sharma Transport',
    transporter: 'Sharma Logistics',
    vehicle_type: 'truck',
    max_capacity: 25000,
  },
  {
    vehicle_number: 'GJ05CD5678',
    rfid_tag: 'E280117000000208AABBCC02',
    owner_name: 'Patel Industries',
    transporter: 'Gujarat Freight Co',
    vehicle_type: 'tanker',
    max_capacity: 40000,
  },
  {
    vehicle_number: 'RJ14EF9012',
    rfid_tag: 'E280117000000208AABBCC03',
    owner_name: 'Rajasthan Minerals',
    transporter: 'Desert Haulers',
    vehicle_type: 'truck',
    max_capacity: 32000,
  },
  {
    vehicle_number: 'UP32GH3456',
    rfid_tag: 'E280117000000208AABBCC04',
    owner_name: 'Singh Brothers',
    transporter: 'North India Carriers',
    vehicle_type: 'truck',
    max_capacity: 18000,
  },
  {
    vehicle_number: 'DL01IJ7890',
    rfid_tag: 'E280117000000208AABBCC05',
    owner_name: 'Capital Cement Ltd',
    transporter: 'Delhi Bulk Movers',
    vehicle_type: 'tanker',
    max_capacity: 10000,
  },
  {
    vehicle_number: 'HR38AH6118',
    rfid_tag: 'E200470678E064222F03010C',
    owner_name: 'Krishna Transport Co.',
    transporter: 'Haryana Freight Lines',
    vehicle_type: 'truck',
    max_capacity: 28000,
  },
];

const SETTINGS_KEYS = [
  ['APP_ENV', 'development'],
  ['CLOUD_SYNC_URL', 'https://api.example.com/weighbridge'],
  ['CLOUD_SYNC_TOKEN', 'local-dev-token'],
  ['RFID_IP', '192.168.1.116'],
  ['RFID_IPS', '192.168.1.116,192.168.1.117'],
  ['RFID_PORT', '9090'],
  ['WEIGHBRIDGE_COM_PORT', 'COM3'],
  ['WEIGHBRIDGE_BAUD_RATE', '9600'],
  ['CAMERA_RTSP_URL', 'rtsp://user:pass@192.168.1.60:554/stream1'],
  ['SYNC_INTERVAL_SECONDS', '30'],
  ['BACKUP_INTERVAL_HOURS', '4'],
  ['MAX_RETRY_ATTEMPTS', '5'],
  ['LOG_LEVEL', 'info'],
  ['USE_MOCK_HARDWARE', 'false'],
];

function seed(db) {
  const now = ts.now();
  let vehiclesInserted = 0;
  let transactionsInserted = 0;

  const vehicleIds = {};

  const seedAll = db.transaction(() => {
    // ── Settings ──────────────────────────────────────────────
    const upsertSetting = db.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    for (const [key, value] of SETTINGS_KEYS) {
      upsertSetting.run(key, value, now);
    }

    // ── Operator ──────────────────────────────────────────────
    const adminId = uuidv4();
    db.prepare(
      `INSERT OR IGNORE INTO operators (id, name, pin, role, status, created_at)
       VALUES (?, 'Admin', '1234', 'admin', 'active', ?)`,
    ).run(adminId, now);

    const adminRow = db
      .prepare("SELECT id FROM operators WHERE name = 'Admin' LIMIT 1")
      .get();
    const operatorId = adminRow ? adminRow.id : adminId;

    // ── Slip counter ──────────────────────────────────────────
    const counterExists = db
      .prepare('SELECT id FROM slip_counter LIMIT 1')
      .get();
    if (!counterExists) {
      db.prepare(
        `INSERT INTO slip_counter (prefix, current_value, updated_at)
         VALUES ('WB', 1000, ?)`,
      ).run(now);
    }

    // ── Vehicles ──────────────────────────────────────────────
    const insertVehicle = db.prepare(
      `INSERT OR IGNORE INTO vehicles (
        id, vehicle_number, rfid_tag, owner_name, transporter,
        vehicle_type, max_capacity, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    );

    for (const v of DEMO_VEHICLES) {
      const id = uuidv4();
      const result = insertVehicle.run(
        id,
        v.vehicle_number,
        v.rfid_tag,
        v.owner_name,
        v.transporter,
        v.vehicle_type,
        v.max_capacity,
        now,
        now,
      );
      if (result.changes > 0) {
        vehiclesInserted += 1;
        vehicleIds[v.vehicle_number] = id;
      } else {
        const row = db
          .prepare('SELECT id FROM vehicles WHERE vehicle_number = ?')
          .get(v.vehicle_number);
        if (row) vehicleIds[v.vehicle_number] = row.id;
      }
    }

    // ── Demo transactions (last 7 days) ───────────────────────
    const demoTxns = [
      { truck: 'MH12AB1234', rfid: 'E280117000000208AABBCC01', daysAgo: 6, gross: 22000, tare: 9000, sync: SYNC_STATUS.SYNCED, status: TRANSACTION_STATUS.SYNCED, slip: 'WB-1001' },
      { truck: 'GJ05CD5678', rfid: 'E280117000000208AABBCC02', daysAgo: 5, gross: 38000, tare: 11000, sync: SYNC_STATUS.SYNCED, status: TRANSACTION_STATUS.PRINTED, slip: 'WB-1002' },
      { truck: 'RJ14EF9012', rfid: 'E280117000000208AABBCC03', daysAgo: 4, gross: 31000, tare: 10000, sync: SYNC_STATUS.PENDING, status: TRANSACTION_STATUS.PRINTED, slip: 'WB-1003' },
      { truck: 'UP32GH3456', rfid: 'E280117000000208AABBCC04', daysAgo: 3, gross: 17500, tare: 8500, sync: SYNC_STATUS.FAILED, status: TRANSACTION_STATUS.PRINTED, slip: 'WB-1004' },
      { truck: 'DL01IJ7890', rfid: 'E280117000000208AABBCC05', daysAgo: 3, gross: 15000, tare: 8000, sync: SYNC_STATUS.SYNCED, status: TRANSACTION_STATUS.SYNCED, slip: 'WB-1005' },
      { truck: 'MH12AB1234', rfid: 'E280117000000208AABBCC01', daysAgo: 2, gross: 24500, tare: 9500, sync: SYNC_STATUS.PENDING, status: TRANSACTION_STATUS.PRINTED, slip: 'WB-1006' },
      { truck: 'GJ05CD5678', rfid: 'E280117000000208AABBCC02', daysAgo: 2, gross: 42000, tare: 12000, sync: SYNC_STATUS.SYNCED, status: TRANSACTION_STATUS.SYNCED, slip: 'WB-1007' },
      { truck: 'RJ14EF9012', rfid: 'E280117000000208AABBCC03', daysAgo: 1, gross: 29000, tare: 10500, sync: SYNC_STATUS.FAILED, status: TRANSACTION_STATUS.PRINTED, slip: 'WB-1008' },
      { truck: 'UP32GH3456', rfid: 'E280117000000208AABBCC04', daysAgo: 1, gross: 19800, tare: 8800, sync: SYNC_STATUS.PENDING, status: TRANSACTION_STATUS.PRINTED, slip: 'WB-1009' },
      { truck: 'DL01IJ7890', rfid: 'E280117000000208AABBCC05', daysAgo: 0, gross: 16500, tare: 8200, sync: SYNC_STATUS.SYNCED, status: TRANSACTION_STATUS.SYNCED, slip: 'WB-1010' },
      { truck: 'HR38AH6118', rfid: 'E200470678E064222F03010C', daysAgo: 2, gross: 26500, tare: 9200, sync: SYNC_STATUS.SYNCED, status: TRANSACTION_STATUS.SYNCED, slip: 'WB-1011' },
      { truck: 'HR38AH6118', rfid: 'E200470678E064222F03010C', daysAgo: 0, gross: 24800, tare: 9100, sync: SYNC_STATUS.PENDING, status: TRANSACTION_STATUS.PRINTED, slip: 'WB-1012' },
    ];

    const insertTxn = db.prepare(
      `INSERT OR IGNORE INTO transactions (
        id, truck_number, rfid_tag, gross_weight, tare_weight,
        timestamp_in, timestamp_out, operator_id, slip_number,
        sync_status, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertQueue = db.prepare(
      `INSERT OR IGNORE INTO sync_queue (transaction_id, retry_count, sync_status, created_at)
       VALUES (?, ?, ?, ?)`,
    );

    for (const t of demoTxns) {
      const id = uuidv4();
      const timestampIn = ts.daysAgo(t.daysAgo);
      const result = insertTxn.run(
        id,
        t.truck,
        t.rfid,
        t.gross,
        t.tare,
        timestampIn,
        timestampIn,
        operatorId,
        t.slip,
        t.sync,
        t.status,
        timestampIn,
        now,
      );
      if (result.changes > 0) {
        transactionsInserted += 1;
        if (t.sync === SYNC_STATUS.PENDING || t.sync === SYNC_STATUS.FAILED) {
          insertQueue.run(
            id,
            t.sync === SYNC_STATUS.FAILED ? 1 : 0,
            t.sync,
            timestampIn,
          );
        }
      }
    }

    // Advance slip counter past demo slips
    db.prepare(
      `UPDATE slip_counter SET current_value = 1012, updated_at = ? WHERE current_value < 1012`,
    ).run(now);
  });

  seedAll();

  return {
    vehicles: vehiclesInserted,
    transactions: transactionsInserted,
    settings: SETTINGS_KEYS.length,
    operators: 1,
  };
}

module.exports = { seed };
