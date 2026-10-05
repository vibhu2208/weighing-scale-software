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

SLIP = 'WB3321'
WEIGHT = 100.0
CANCEL_LABEL = 'CANCEL'

SELECT_COLS = '''
    id, slip_number, truck_number, ticket_status, status,
    gross_weight, tare_weight, net_weight,
    material, customer_name, destination, driver,
    operator_name, notes, remote_pg_id
'''


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cols = {r['name'] for r in cur.execute('PRAGMA table_info(transactions)')}
    extra = ', company' if 'company' in cols else ''
    row = cur.execute(
        f'''
        SELECT {SELECT_COLS}{extra}
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP,),
    ).fetchone()
    if not row:
        raise SystemExit(f'{SLIP} not found')

    print('Before:', dict(row))

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

    sets = [
        'gross_weight = ?',
        'tare_weight = ?',
        'material = ?',
        'customer_name = ?',
        'destination = ?',
        'driver = ?',
        'operator_name = ?',
        'notes = ?',
        'ticket_status = ?',
        'status = ?',
        'timestamp_out = ?',
        'updated_at = ?',
    ]
    params = [
        WEIGHT,
        WEIGHT,
        CANCEL_LABEL,
        CANCEL_LABEL,
        CANCEL_LABEL,
        CANCEL_LABEL,
        CANCEL_LABEL,
        CANCEL_LABEL,
        'CLOSED',
        'completed',
        now,
        now,
    ]

    if 'raw_gross_weight' in cols:
        sets.append('raw_gross_weight = ?')
        params.append(WEIGHT)
    if 'raw_tare_weight' in cols:
        sets.append('raw_tare_weight = ?')
        params.append(WEIGHT)
    if 'company' in cols:
        sets.append('company = ?')
        params.append(CANCEL_LABEL)

    params.append(SLIP)
    cur.execute(
        f'UPDATE transactions SET {", ".join(sets)} WHERE slip_number = ?',
        params,
    )
    conn.commit()

    after = cur.execute(
        f'''
        SELECT {SELECT_COLS}{extra}, timestamp_out
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP,),
    ).fetchone()
    print('After:', dict(after))
    print(
        f'\nDone. {SLIP} closed: gross={WEIGHT:.0f} tare={WEIGHT:.0f}, '
        f'text fields={CANCEL_LABEL}.',
    )
    conn.close()


if __name__ == '__main__':
    main()
