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

SLIP = 'WB2875'
EXPECTED_TRUCK = 'HR38AL4088'
NEW_GROSS = 55840.0


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cols = {r['name'] for r in cur.execute('PRAGMA table_info(transactions)')}
    row = cur.execute(
        '''
        SELECT id, slip_number, truck_number, ticket_status,
               gross_weight, tare_weight, net_weight, remote_pg_id
               {raw}
        FROM transactions WHERE slip_number = ?
        '''.format(
            raw=', raw_gross_weight' if 'raw_gross_weight' in cols else '',
        ),
        (SLIP,),
    ).fetchone()
    if not row:
        raise SystemExit(f'{SLIP} not found')
    if row['truck_number'] != EXPECTED_TRUCK:
        raise SystemExit(
            f'{SLIP} truck expected {EXPECTED_TRUCK}, found {row["truck_number"]}',
        )

    print('Before:', dict(row))

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
    if 'raw_gross_weight' in cols:
        cur.execute(
            '''
            UPDATE transactions
            SET gross_weight = ?,
                raw_gross_weight = ?,
                updated_at = ?
            WHERE slip_number = ?
            ''',
            (NEW_GROSS, NEW_GROSS, now, SLIP),
        )
    else:
        cur.execute(
            '''
            UPDATE transactions
            SET gross_weight = ?,
                updated_at = ?
            WHERE slip_number = ?
            ''',
            (NEW_GROSS, now, SLIP),
        )
    conn.commit()

    after = cur.execute(
        '''
        SELECT slip_number, truck_number, ticket_status,
               gross_weight, tare_weight, net_weight
               {raw}
        FROM transactions WHERE slip_number = ?
        '''.format(
            raw=', raw_gross_weight' if 'raw_gross_weight' in cols else '',
        ),
        (SLIP,),
    ).fetchone()
    print('After:', dict(after))
    print(f'\nDone. {SLIP} gross={NEW_GROSS:.0f}.')
    conn.close()


if __name__ == '__main__':
    main()
