import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.path.join(
    os.environ['APPDATA'],
    'weighbridge-app',
    'weighbridge-data',
    'database',
    'weighbridge.db',
)

SLIP = 'WB2743'
OLD_TRUCK = 'HR38X7051'
NEW_TRUCK = 'HR38X7059'


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    row = cur.execute(
        '''
        SELECT id, slip_number, truck_number, rfid_tag, ticket_status,
               remote_pg_id, tare_weight, gross_weight, net_weight
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP,),
    ).fetchone()
    if not row:
        raise SystemExit(f'{SLIP} not found')
    if row['truck_number'] != OLD_TRUCK:
        raise SystemExit(
            f'Expected truck {OLD_TRUCK}, found {row["truck_number"]}',
        )

    vehicle = cur.execute(
        '''
        SELECT vehicle_number, vehicle_type, rfid_tag FROM vehicles
        WHERE upper(replace(vehicle_number, ' ', '')) = ?
        ''',
        (NEW_TRUCK,),
    ).fetchone()

    print('\nBefore:', dict(row))
    print('Vehicle master:', dict(vehicle) if vehicle else 'not in vehicles table')

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
    new_rfid = vehicle['rfid_tag'] if vehicle else row['rfid_tag']

    cur.execute(
        '''
        UPDATE transactions SET
          truck_number = ?,
          rfid_tag = ?,
          updated_at = ?
        WHERE slip_number = ?
        ''',
        (NEW_TRUCK, new_rfid, now, SLIP),
    )
    conn.commit()

    after = cur.execute(
        '''
        SELECT t.slip_number, t.truck_number, t.rfid_tag, t.ticket_status,
               t.remote_pg_id, t.tare_weight, t.gross_weight, t.net_weight,
               v.vehicle_type
        FROM transactions t
        LEFT JOIN vehicles v ON upper(replace(v.vehicle_number, ' ', ''))
          = upper(replace(t.truck_number, ' ', ''))
        WHERE t.slip_number = ?
        ''',
        (SLIP,),
    ).fetchone()
    print('After:', dict(after))
    print(f'\nDone. {SLIP} truck number changed to {NEW_TRUCK}.')
    conn.close()


if __name__ == '__main__':
    main()
