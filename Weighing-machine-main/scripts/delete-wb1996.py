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

SLIP = 'WB1996'


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    row = cur.execute(
        '''
        SELECT id, slip_number, truck_number, ticket_status, material,
               customer_name, destination, operator_name, remote_pg_id, created_at
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP,),
    ).fetchone()
    if not row:
        raise SystemExit(f'{SLIP} not found')
    print('Deleting:', dict(row))
    txn_id = row['id']

    sync_n = cur.execute(
        'SELECT COUNT(*) AS n FROM sync_queue WHERE transaction_id = ?',
        (txn_id,),
    ).fetchone()['n']
    print(f'sync_queue rows: {sync_n}')

    cur.execute('DELETE FROM sync_queue WHERE transaction_id = ?', (txn_id,))
    cur.execute('DELETE FROM transactions WHERE id = ?', (txn_id,))
    conn.commit()

    gone = cur.execute(
        'SELECT slip_number FROM transactions WHERE slip_number = ?',
        (SLIP,),
    ).fetchone()
    print('Still present:', gone is not None)

    counter = cur.execute(
        'SELECT id, current_value, prefix FROM slip_counter ORDER BY id LIMIT 1',
    ).fetchone()
    print('slip_counter (unchanged):', dict(counter) if counter else None)

    top = cur.execute(
        '''
        SELECT slip_number FROM transactions
        WHERE slip_number IS NOT NULL
        ORDER BY CAST(substr(slip_number, 3) AS INTEGER) DESC
        LIMIT 5
        ''',
    ).fetchall()
    print('Top slips now:', [r['slip_number'] for r in top])

    conn.close()
    print(f'\nDone. Deleted {SLIP} locally.')


if __name__ == '__main__':
    main()
