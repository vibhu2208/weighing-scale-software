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

SLIP = 'WB1682'
EXPECTED_TRUCK = 'HR38W4173'
# Weighed as truck (tare first / gross second) but vehicle is HYWA
# (gross on arrival / tare on departure). Swap stored weights.
EXPECTED_TARE = 42420.0
EXPECTED_GROSS = 11140.0


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    free = shutil.disk_usage(os.path.dirname(DB_PATH)).free
    if free > os.path.getsize(DB_PATH) + 50_000_000:
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        backup = DB_PATH + f'.bak-wb1682-swap-{stamp}'
        shutil.copy2(DB_PATH, backup)
        print(f'Backup: {backup}')
    else:
        print('WARNING: not enough disk space for DB backup; proceeding without copy')

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    row = cur.execute(
        '''
        SELECT id, slip_number, truck_number, ticket_status,
               gross_weight, tare_weight, raw_gross_weight, raw_tare_weight, net_weight,
               sync_status, status
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP,),
    ).fetchone()
    if not row:
        raise SystemExit(f'{SLIP} not found')
    if row['truck_number'] != EXPECTED_TRUCK:
        raise SystemExit(
            f'{SLIP} truck expected {EXPECTED_TRUCK}, found {row["truck_number"]}',
        )
    if row['tare_weight'] != EXPECTED_TARE or row['gross_weight'] != EXPECTED_GROSS:
        raise SystemExit(
            f'{SLIP} weights unexpected: tare={row["tare_weight"]}, '
            f'gross={row["gross_weight"]} '
            f'(expected tare={EXPECTED_TARE}, gross={EXPECTED_GROSS})',
        )

    vehicle = cur.execute(
        'SELECT vehicle_number, vehicle_type FROM vehicles WHERE vehicle_number = ?',
        (EXPECTED_TRUCK,),
    ).fetchone()
    print(f'\nBefore {SLIP}:', dict(row))
    print('Vehicle:', dict(vehicle) if vehicle else None)

    new_tare = EXPECTED_GROSS
    new_gross = EXPECTED_TARE
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

    cur.execute(
        '''
        UPDATE transactions
        SET tare_weight = ?,
            raw_tare_weight = ?,
            gross_weight = ?,
            raw_gross_weight = ?,
            sync_status = 'pending',
            status = 'pending',
            updated_at = ?
        WHERE slip_number = ?
        ''',
        (new_tare, new_tare, new_gross, new_gross, now, SLIP),
    )

    if vehicle and str(vehicle['vehicle_type'] or '').lower() != 'hywa':
        cur.execute(
            '''
            UPDATE vehicles SET vehicle_type = ?, updated_at = ?
            WHERE vehicle_number = ?
            ''',
            ('hywa', now, EXPECTED_TRUCK),
        )

    conn.commit()

    after = cur.execute(
        '''
        SELECT slip_number, truck_number, ticket_status,
               gross_weight, tare_weight, raw_gross_weight, raw_tare_weight, net_weight,
               sync_status, status
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP,),
    ).fetchone()
    vehicle_after = cur.execute(
        'SELECT vehicle_number, vehicle_type FROM vehicles WHERE vehicle_number = ?',
        (EXPECTED_TRUCK,),
    ).fetchone()
    print(f'\nAfter {SLIP}:', dict(after))
    print('Vehicle:', dict(vehicle_after) if vehicle_after else None)
    print(
        f'\nDone. {SLIP} swapped tare={new_tare:.0f}, gross={new_gross:.0f}, '
        f'net={after["net_weight"]:.0f}.',
    )
    conn.close()


if __name__ == '__main__':
    main()
