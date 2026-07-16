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

SLIPS = ('WB1482', 'WB1479', 'WB1478')
# Match the dominant stored form used elsewhere in this DB.
NEW_OPERATOR = 'MANSINGH'


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    free = shutil.disk_usage(os.path.dirname(DB_PATH)).free
    print(f'Free disk bytes: {free}')
    if free > os.path.getsize(DB_PATH) + 50_000_000:
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        backup = DB_PATH + f'.bak-wb1482-operator-{stamp}'
        shutil.copy2(DB_PATH, backup)
        print(f'Backup: {backup}')
    else:
        print('WARNING: not enough disk space for DB backup; proceeding with UPDATE only')

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    before_rows = []
    for slip in SLIPS:
        row = cur.execute(
            '''
            SELECT id, slip_number, truck_number, ticket_status, operator_name,
                   material, customer_name, updated_at
            FROM transactions WHERE slip_number = ?
            ''',
            (slip,),
        ).fetchone()
        if not row:
            raise SystemExit(f'{slip} not found')
        before_rows.append(row)
        print(f'Before {slip}:', dict(row))

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
    for slip in SLIPS:
        cur.execute(
            '''
            UPDATE transactions
            SET operator_name = ?, updated_at = ?
            WHERE slip_number = ?
            ''',
            (NEW_OPERATOR, now, slip),
        )
        print(f'Updated {slip}: {cur.rowcount} row(s)')

    conn.commit()

    print()
    for slip in SLIPS:
        after = cur.execute(
            '''
            SELECT slip_number, truck_number, ticket_status, operator_name, updated_at
            FROM transactions WHERE slip_number = ?
            ''',
            (slip,),
        ).fetchone()
        print(f'After {slip}:', dict(after))

    print(f'\nDone. Set operator_name={NEW_OPERATOR} on {", ".join(SLIPS)}.')
    conn.close()


if __name__ == '__main__':
    main()
