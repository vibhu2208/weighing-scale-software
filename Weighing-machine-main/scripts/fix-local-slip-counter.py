'use strict';

import os
import re
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.path.join(
    os.environ['APPDATA'],
    'weighbridge-app',
    'weighbridge-data',
    'database',
    'weighbridge.db',
)

TARGET_VALUE = 1137


def parse_num(slip):
    match = re.search(r'(\d+)\s*$', str(slip or ''))
    return int(match.group(1)) if match else 0


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

    wb40 = cur.execute(
        """
        SELECT slip_number, ticket_status, created_at
        FROM transactions
        WHERE slip_number LIKE 'WB40%'
        ORDER BY slip_number
        """,
    ).fetchall()
    print(f'\nWB40xx slips found: {len(wb40)}')
    for row in wb40:
        print(f"  {row['slip_number']} | {row['ticket_status']} | {row['created_at']}")

    slips = cur.execute(
        'SELECT slip_number FROM transactions WHERE slip_number IS NOT NULL',
    ).fetchall()
    max_numeric = max((parse_num(r['slip_number']) for r in slips), default=0)
    print(f'\nMax slip numeric in transactions: {max_numeric}')

    if wb40:
        print('\nWARNING: WB40xx slips still exist in transactions.')
        print('Renaming slips in Reports does not update slip_counter by itself.')
        print('Proceeding with slip_counter reset only.')

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
    cur.execute(
        'UPDATE slip_counter SET current_value = ?, updated_at = ? WHERE id = ?',
        (TARGET_VALUE, now, counter['id']),
    )
    conn.commit()

    after = cur.execute(
        'SELECT id, current_value, prefix, updated_at FROM slip_counter ORDER BY id LIMIT 1',
    ).fetchone()
    print('\nAfter slip_counter:', dict(after))
    print(f'\nDone. Local counter set to {TARGET_VALUE}. Next local slip would be WB{TARGET_VALUE + 1:04d}.')
    conn.close()


if __name__ == '__main__':
    main()
