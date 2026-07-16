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

SLIP = 'WB1489'
EXPECTED_TRUCK = 'HR38AH6118'
NEW_TARE = 12700.0
NEW_GROSS = 53760.0


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    free = shutil.disk_usage(os.path.dirname(DB_PATH)).free
    if free > os.path.getsize(DB_PATH) + 50_000_000:
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        backup = DB_PATH + f'.bak-wb1489-{stamp}'
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
               gross_weight, tare_weight, raw_gross_weight, raw_tare_weight, net_weight
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
    print(f'\nBefore {SLIP}:', dict(row))

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
    cur.execute(
        '''
        UPDATE transactions
        SET tare_weight = ?,
            raw_tare_weight = ?,
            gross_weight = ?,
            raw_gross_weight = ?,
            updated_at = ?
        WHERE slip_number = ?
        ''',
        (NEW_TARE, NEW_TARE, NEW_GROSS, NEW_GROSS, now, SLIP),
    )
    conn.commit()

    after = cur.execute(
        '''
        SELECT slip_number, truck_number, ticket_status,
               gross_weight, tare_weight, raw_gross_weight, raw_tare_weight, net_weight
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP,),
    ).fetchone()
    print(f'\nAfter {SLIP}:', dict(after))
    print(
        f'\nDone. {SLIP} tare={NEW_TARE:.0f}, gross={NEW_GROSS:.0f}, '
        f'net={after["net_weight"]:.0f}.',
    )
    conn.close()


if __name__ == '__main__':
    main()
