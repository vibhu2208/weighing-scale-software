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

SLIP_TARE = 'WB1485'
NEW_TARE = 12720.0
EXPECTED_OLD_TARE = 720.0

SLIP_DELETE = 'WB1488'
COUNTER_AFTER = 1487


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    free = shutil.disk_usage(os.path.dirname(DB_PATH)).free
    print(f'Free disk bytes: {free}')
    if free > os.path.getsize(DB_PATH) + 50_000_000:
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        backup = DB_PATH + f'.bak-wb1485-1488-{stamp}'
        shutil.copy2(DB_PATH, backup)
        print(f'Backup: {backup}')
    else:
        print('WARNING: not enough disk space for DB backup; proceeding without copy')

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    counter = cur.execute(
        'SELECT id, current_value, prefix, updated_at FROM slip_counter ORDER BY id LIMIT 1',
    ).fetchone()
    print('\nBefore slip_counter:', dict(counter) if counter else None)

    wb1485 = cur.execute(
        '''
        SELECT id, slip_number, truck_number, ticket_status,
               gross_weight, tare_weight, raw_tare_weight, net_weight
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP_TARE,),
    ).fetchone()
    if not wb1485:
        raise SystemExit(f'{SLIP_TARE} not found')
    if wb1485['tare_weight'] != EXPECTED_OLD_TARE:
        raise SystemExit(
            f'{SLIP_TARE} tare expected {EXPECTED_OLD_TARE}, found {wb1485["tare_weight"]}',
        )
    print(f'\nBefore {SLIP_TARE}:', dict(wb1485))

    wb1488 = cur.execute(
        '''
        SELECT id, slip_number, truck_number, ticket_status,
               gross_weight, tare_weight, net_weight, created_at
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP_DELETE,),
    ).fetchone()
    if not wb1488:
        raise SystemExit(f'{SLIP_DELETE} not found')
    print(f'Ticket to delete: {dict(wb1488)}')
    txn_id = wb1488['id']

    sync_rows = cur.execute(
        'SELECT id, sync_status FROM sync_queue WHERE transaction_id = ?',
        (txn_id,),
    ).fetchall()
    print(f'sync_queue rows for {SLIP_DELETE}: {len(sync_rows)}')

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

    # 1) Fix WB1485 tare (net_weight is generated from gross - tare)
    cur.execute(
        '''
        UPDATE transactions
        SET tare_weight = ?, raw_tare_weight = ?, updated_at = ?
        WHERE slip_number = ?
        ''',
        (NEW_TARE, NEW_TARE, now, SLIP_TARE),
    )

    # 2) Delete WB1488 and roll counter back to 1487
    cur.execute('DELETE FROM sync_queue WHERE transaction_id = ?', (txn_id,))
    cur.execute('DELETE FROM transactions WHERE id = ?', (txn_id,))
    cur.execute(
        'UPDATE slip_counter SET current_value = ?, updated_at = ? WHERE id = ?',
        (COUNTER_AFTER, now, counter['id']),
    )

    conn.commit()

    after_1485 = cur.execute(
        '''
        SELECT slip_number, truck_number, ticket_status,
               gross_weight, tare_weight, raw_tare_weight, net_weight
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP_TARE,),
    ).fetchone()
    after_1488 = cur.execute(
        'SELECT slip_number FROM transactions WHERE slip_number = ?',
        (SLIP_DELETE,),
    ).fetchone()
    after_counter = cur.execute(
        'SELECT id, current_value, prefix, updated_at FROM slip_counter ORDER BY id LIMIT 1',
    ).fetchone()
    top = cur.execute(
        '''
        SELECT slip_number FROM transactions
        WHERE slip_number IS NOT NULL
        ORDER BY slip_number DESC LIMIT 5
        ''',
    ).fetchall()

    print(f'\nAfter {SLIP_TARE}:', dict(after_1485))
    print(f'After {SLIP_DELETE}:', after_1488)
    print('After slip_counter:', dict(after_counter))
    print('Top slips now:', [r['slip_number'] for r in top])
    print(
        f'\nDone. {SLIP_TARE} tare -> {NEW_TARE:.0f} '
        f'(net={after_1485["net_weight"]:.0f}). '
        f'Deleted {SLIP_DELETE}. Next slip will be WB{COUNTER_AFTER + 1:04d}.',
    )
    conn.close()


if __name__ == '__main__':
    main()
