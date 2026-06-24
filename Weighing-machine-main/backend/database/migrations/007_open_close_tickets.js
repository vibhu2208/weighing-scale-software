'use strict';

/** Open/Close ticket lifecycle columns and photo fields. */
const id = '007_open_close_tickets';

function columnExists(db, table, name) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === name);
}

function addColumnIfMissing(db, table, name, type) {
  if (!columnExists(db, table, name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

function parseSnapshots(raw) {
  if (!raw) return { tare: [], gross: [] };
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { tare: parsed.tare || [], gross: parsed.gross || [] };
  } catch {
    return { tare: [], gross: [] };
  }
}

function up(db) {
  addColumnIfMissing(db, 'transactions', 'ticket_status', "TEXT NOT NULL DEFAULT 'OPEN'");
  addColumnIfMissing(db, 'transactions', 'material', 'TEXT');
  addColumnIfMissing(db, 'transactions', 'driver', 'TEXT');
  addColumnIfMissing(db, 'transactions', 'arrival_photo_1', 'TEXT');
  addColumnIfMissing(db, 'transactions', 'arrival_photo_2', 'TEXT');
  addColumnIfMissing(db, 'transactions', 'arrival_photo_3', 'TEXT');
  addColumnIfMissing(db, 'transactions', 'departure_photo_1', 'TEXT');
  addColumnIfMissing(db, 'transactions', 'departure_photo_2', 'TEXT');
  addColumnIfMissing(db, 'transactions', 'departure_photo_3', 'TEXT');
  addColumnIfMissing(db, 'transactions', 'report_path', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_transactions_truck_ticket_status
      ON transactions(truck_number, ticket_status);
    CREATE INDEX IF NOT EXISTS idx_transactions_rfid_ticket_status
      ON transactions(rfid_tag, ticket_status);
  `);

  const rows = db.prepare('SELECT id, tare_weight, gross_weight, status, camera_snapshots FROM transactions').all();

  const updateStatus = db.prepare(
    `UPDATE transactions SET ticket_status = ? WHERE id = ?`,
  );
  const updatePhotos = db.prepare(`
    UPDATE transactions SET
      arrival_photo_1 = ?,
      arrival_photo_2 = ?,
      arrival_photo_3 = ?,
      departure_photo_1 = ?,
      departure_photo_2 = ?,
      departure_photo_3 = ?
    WHERE id = ?
  `);

  for (const row of rows) {
    let ticketStatus = 'OPEN';
    if (row.gross_weight != null && row.tare_weight != null) {
      ticketStatus = 'CLOSED';
    } else if (row.status === 'error' || row.status === 'failed') {
      ticketStatus = 'CANCELLED';
    } else if (row.tare_weight != null && row.gross_weight == null) {
      ticketStatus = 'OPEN';
    } else if (row.tare_weight == null && row.gross_weight == null) {
      ticketStatus = row.status === 'error' || row.status === 'failed' ? 'CANCELLED' : 'OPEN';
    }

    updateStatus.run(ticketStatus, row.id);

    const snaps = parseSnapshots(row.camera_snapshots);
    const tarePaths = (snaps.tare || []).map((s) => s.path).filter(Boolean);
    const grossPaths = (snaps.gross || []).map((s) => s.path).filter(Boolean);

    if (tarePaths.length || grossPaths.length) {
      updatePhotos.run(
        tarePaths[0] || null,
        tarePaths[1] || null,
        tarePaths[2] || null,
        grossPaths[0] || null,
        grossPaths[1] || null,
        grossPaths[2] || null,
        row.id,
      );
    }
  }

  const now = new Date().toISOString();
  const existingMaterials = db
    .prepare(`SELECT value FROM settings WHERE key = 'materials_list' LIMIT 1`)
    .get();
  if (!existingMaterials) {
    const defaultMaterials = JSON.stringify([
      'Coal',
      'Iron Ore',
      'Limestone',
      'Sand',
      'Gravel',
      'Other',
    ]);
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('materials_list', ?, ?)`,
    ).run(defaultMaterials, now);
  }
}

function down(db) {
  /* SQLite cannot drop columns easily — no-op for dev reset */
}

module.exports = { id, up, down };
