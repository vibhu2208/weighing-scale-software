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

SLIP = 'WB1915'
NEW_TRUCK = 'UP21CT0843'
NEW_CUSTOMER = 'MCG'
NEW_DESTINATION = 'MUZAFFAR NAGAR'
NEW_OPERATOR = 'PARDEEP'


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
               customer_name, destination, operator_name, material, remote_pg_id
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP,),
    ).fetchone()
    if not row:
        raise SystemExit(f'{SLIP} not found')

    vehicle = cur.execute(
        '''
        SELECT vehicle_number, rfid_tag FROM vehicles
        WHERE upper(replace(vehicle_number, ' ', '')) = ?
        ''',
        (NEW_TRUCK,),
    ).fetchone()
    if not vehicle:
        raise SystemExit(f'{NEW_TRUCK} not found in vehicles table')

    print('\nBefore:', dict(row))

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
    cur.execute(
        '''
        UPDATE transactions SET
          truck_number = ?,
          rfid_tag = ?,
          customer_name = ?,
          destination = ?,
          operator_name = ?,
          updated_at = ?
        WHERE slip_number = ?
        ''',
        (
            NEW_TRUCK,
            vehicle['rfid_tag'],
            NEW_CUSTOMER,
            NEW_DESTINATION,
            NEW_OPERATOR,
            now,
            SLIP,
        ),
    )
    conn.commit()

    after = cur.execute(
        '''
        SELECT slip_number, truck_number, rfid_tag, ticket_status,
               customer_name, destination, operator_name, material
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP,),
    ).fetchone()
    print('After:', dict(after))
    print(f'\nDone. {SLIP} updated.')
    conn.close()


if __name__ == '__main__':
    main()
