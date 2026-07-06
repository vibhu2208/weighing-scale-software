'use strict';

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

SLIP_TO_DELETE = 'WB1215'
COUNTER_AFTER = 1214


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    counter = cur.execute(
        'SELECT id, current_value, prefix, updated_at FROM slip_counter ORDER BY id LIMIT 1',
    ).fetchone()
    print('\nBefore slip_counter:', dict(counter) if counter else None)

    row = cur.execute(
        'SELECT id, slip_number, truck_number, ticket_status, created_at FROM transactions WHERE slip_number = ?',
        (SLIP_TO_DELETE,),
    ).fetchone()
    if not row:
        raise SystemExit(f'{SLIP_TO_DELETE} not found in local database')
    print(f'\nTicket to delete: {dict(row)}')
    txn_id = row['id']

    sync_rows = cur.execute(
        'SELECT id, sync_status FROM sync_queue WHERE transaction_id = ?',
        (txn_id,),
    ).fetchall()
    print(f'sync_queue rows for ticket: {len(sync_rows)}')

    cur.execute('DELETE FROM sync_queue WHERE transaction_id = ?', (txn_id,))
    cur.execute('DELETE FROM transactions WHERE id = ?', (txn_id,))

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
    cur.execute(
        'UPDATE slip_counter SET current_value = ?, updated_at = ? WHERE id = ?',
        (COUNTER_AFTER, now, counter['id']),
    )
    conn.commit()

    after = cur.execute(
        'SELECT id, current_value, prefix, updated_at FROM slip_counter ORDER BY id LIMIT 1',
    ).fetchone()
    print('\nAfter slip_counter:', dict(after))

    remaining = cur.execute(
        'SELECT slip_number FROM transactions WHERE slip_number IS NOT NULL ORDER BY slip_number DESC LIMIT 3',
    ).fetchall()
    print('Top slips now:', [r['slip_number'] for r in remaining])
    print(f'\nDone. Deleted {SLIP_TO_DELETE} locally only. Next slip will be WB{COUNTER_AFTER + 1:04d}.')
    conn.close()


if __name__ == '__main__':
    main()
