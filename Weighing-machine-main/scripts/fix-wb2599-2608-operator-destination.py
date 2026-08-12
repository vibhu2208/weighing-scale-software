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

# First 6: operator MUNESH, destination BADKHAL
START_SLIPS = ('WB2599', 'WB2600', 'WB2601', 'WB2603', 'WB2604', 'WB2605')
# Last 3: operator PARVESH, destination BADKHAL
END_SLIPS = ('WB2606', 'WB2607', 'WB2608')

NEW_DESTINATION = 'BADKHAL'


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    free = shutil.disk_usage(os.path.dirname(DB_PATH)).free
    print(f'Free disk bytes: {free}')
    if free > os.path.getsize(DB_PATH) + 50_000_000:
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        backup = DB_PATH + f'.bak-wb2599-2608-op-dest-{stamp}'
        shutil.copy2(DB_PATH, backup)
        print(f'Backup: {backup}')
    else:
        print('WARNING: not enough disk space for DB backup; proceeding with UPDATE only')

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    updates = [(slip, 'MUNESH') for slip in START_SLIPS] + [
        (slip, 'PARVESH') for slip in END_SLIPS
    ]

    for slip, _op in updates:
        row = cur.execute(
            '''
            SELECT id, slip_number, truck_number, ticket_status, operator_name,
                   destination, customer_name, material, remote_pg_id, updated_at
            FROM transactions WHERE slip_number = ?
            ''',
            (slip,),
        ).fetchone()
        if not row:
            raise SystemExit(f'{slip} not found')
        print(f'Before {slip}:', dict(row))

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
    for slip, operator in updates:
        cur.execute(
            '''
            UPDATE transactions
            SET operator_name = ?, destination = ?, updated_at = ?
            WHERE slip_number = ?
            ''',
            (operator, NEW_DESTINATION, now, slip),
        )
        print(f'Updated {slip}: {cur.rowcount} row(s) -> op={operator} dest={NEW_DESTINATION}')

    conn.commit()

    print()
    for slip, _op in updates:
        after = cur.execute(
            '''
            SELECT slip_number, truck_number, ticket_status, operator_name,
                   destination, remote_pg_id, updated_at
            FROM transactions WHERE slip_number = ?
            ''',
            (slip,),
        ).fetchone()
        print(f'After {slip}:', dict(after))

    print(
        f'\nDone. Start 6 -> MUNESH/{NEW_DESTINATION}; '
        f'end 3 -> PARVESH/{NEW_DESTINATION}.',
    )
    conn.close()


if __name__ == '__main__':
    main()
