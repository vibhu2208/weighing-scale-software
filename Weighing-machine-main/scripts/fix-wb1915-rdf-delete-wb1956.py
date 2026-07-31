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

SLIP_MATERIAL = 'WB1915'
NEW_MATERIAL = 'RDF'
SLIP_DELETE = 'WB1956'


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

    # 1) WB1915 material → RDF
    row1915 = cur.execute(
        '''
        SELECT id, slip_number, truck_number, material, customer_name,
               destination, operator_name, ticket_status
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP_MATERIAL,),
    ).fetchone()
    if not row1915:
        raise SystemExit(f'{SLIP_MATERIAL} not found')
    print(f'\nBefore {SLIP_MATERIAL}:', dict(row1915))

    cur.execute(
        '''
        UPDATE transactions
        SET material = ?, updated_at = ?
        WHERE slip_number = ?
        ''',
        (NEW_MATERIAL, now, SLIP_MATERIAL),
    )

    after1915 = cur.execute(
        '''
        SELECT slip_number, truck_number, material, customer_name,
               destination, operator_name, ticket_status
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP_MATERIAL,),
    ).fetchone()
    print(f'After {SLIP_MATERIAL}:', dict(after1915))

    # 2) Delete WB1956 (do not roll slip_counter — higher slips exist)
    row1956 = cur.execute(
        '''
        SELECT id, slip_number, truck_number, ticket_status, material, created_at
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP_DELETE,),
    ).fetchone()
    if not row1956:
        raise SystemExit(f'{SLIP_DELETE} not found')
    print(f'\nDeleting {SLIP_DELETE}:', dict(row1956))
    txn_id = row1956['id']

    sync_n = cur.execute(
        'SELECT COUNT(*) AS n FROM sync_queue WHERE transaction_id = ?',
        (txn_id,),
    ).fetchone()['n']
    print(f'sync_queue rows: {sync_n}')

    cur.execute('DELETE FROM sync_queue WHERE transaction_id = ?', (txn_id,))
    cur.execute('DELETE FROM transactions WHERE id = ?', (txn_id,))

    gone = cur.execute(
        'SELECT slip_number FROM transactions WHERE slip_number = ?',
        (SLIP_DELETE,),
    ).fetchone()
    print(f'After delete present: {gone is not None}')

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

    conn.commit()
    conn.close()
    print(f'\nDone. {SLIP_MATERIAL} material={NEW_MATERIAL}; deleted {SLIP_DELETE}.')


if __name__ == '__main__':
    main()
