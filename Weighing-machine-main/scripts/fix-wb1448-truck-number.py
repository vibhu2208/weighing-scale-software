import os
import shutil
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.path.join(
    os.environ['APPDATA'],
    'weighbridge-app',
    'weighbridge-data',
    'database',
    'weighbridge.db',
)

SLIP = 'WB1448'
OLD_TRUCK = 'HR38F4915'
NEW_TRUCK = 'HR58F4915'


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    # Skip full-file backup when disk is nearly full (DB ~1GB).
    free = shutil.disk_usage(os.path.dirname(DB_PATH)).free
    print(f'Free disk bytes: {free}')
    if free > os.path.getsize(DB_PATH) + 50_000_000:
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        backup = DB_PATH + f'.bak-hr58f4915-{stamp}'
        shutil.copy2(DB_PATH, backup)
        print(f'Backup: {backup}')
    else:
        print('WARNING: not enough disk space for DB backup; proceeding with UPDATE only')

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    ticket = cur.execute(
        """
        SELECT id, slip_number, truck_number, rfid_tag, ticket_status
        FROM transactions
        WHERE slip_number = ?
        """,
        (SLIP,),
    ).fetchone()
    if not ticket:
        raise SystemExit(f'{SLIP} not found')
    if ticket['truck_number'] != OLD_TRUCK:
        raise SystemExit(
            f'Expected truck {OLD_TRUCK}, found {ticket["truck_number"]}',
        )
    if ticket['ticket_status'] != 'OPEN':
        raise SystemExit(f'{SLIP} is not OPEN (status={ticket["ticket_status"]})')

    vehicle = cur.execute(
        """
        SELECT vehicle_number, rfid_tag, status
        FROM vehicles
        WHERE upper(replace(vehicle_number, ' ', '')) = ?
        """,
        (OLD_TRUCK,),
    ).fetchone()
    if not vehicle:
        raise SystemExit(f'{OLD_TRUCK} not found in vehicles')

    existing_new = cur.execute(
        """
        SELECT vehicle_number FROM vehicles
        WHERE upper(replace(vehicle_number, ' ', '')) = ?
        """,
        (NEW_TRUCK,),
    ).fetchone()
    if existing_new:
        raise SystemExit(f'{NEW_TRUCK} already exists in vehicles — aborting')

    print('\nBefore ticket:', dict(ticket))
    print('Before vehicle:', dict(vehicle))

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

    cur.execute(
        """
        UPDATE vehicles
        SET vehicle_number = ?, updated_at = ?
        WHERE upper(replace(vehicle_number, ' ', '')) = ?
        """,
        (NEW_TRUCK, now, OLD_TRUCK),
    )

    cur.execute(
        """
        UPDATE transactions
        SET truck_number = ?, updated_at = ?
        WHERE slip_number = ?
        """,
        (NEW_TRUCK, now, SLIP),
    )

    conn.commit()

    after_ticket = cur.execute(
        """
        SELECT slip_number, truck_number, rfid_tag, ticket_status
        FROM transactions WHERE slip_number = ?
        """,
        (SLIP,),
    ).fetchone()
    after_vehicle = cur.execute(
        """
        SELECT vehicle_number, rfid_tag, status
        FROM vehicles
        WHERE upper(replace(vehicle_number, ' ', '')) = ?
        """,
        (NEW_TRUCK,),
    ).fetchone()

    print('After ticket:', dict(after_ticket))
    print('After vehicle:', dict(after_vehicle))
    print(f'\nDone. Vehicle + open slip {SLIP} updated to {NEW_TRUCK}.')
    conn.close()


if __name__ == '__main__':
    main()
