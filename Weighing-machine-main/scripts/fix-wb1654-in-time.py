import os
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone

DB_PATH = os.path.join(
    os.environ['APPDATA'],
    'weighbridge-app',
    'weighbridge-data',
    'database',
    'weighbridge.db',
)

SLIP = 'WB1654'
IST = timezone(timedelta(hours=5, minutes=30))
# 18/7/2026 07:02:43 IST
NEW_IN_LOCAL = datetime(2026, 7, 18, 7, 2, 43, tzinfo=IST)


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    free = shutil.disk_usage(os.path.dirname(DB_PATH)).free
    if free > os.path.getsize(DB_PATH) + 50_000_000:
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        backup = DB_PATH + f'.bak-wb1654-intime-{stamp}'
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
               timestamp_in, timestamp_out, updated_at
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP,),
    ).fetchone()
    if not row:
        raise SystemExit(f'{SLIP} not found')
    print(f'\nBefore {SLIP}:', dict(row))
    print(
        '  local in:',
        datetime.fromisoformat(row['timestamp_in'].replace('Z', '+00:00')).astimezone(IST),
    )

    new_in = NEW_IN_LOCAL.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

    cur.execute(
        '''
        UPDATE transactions
        SET timestamp_in = ?,
            updated_at = ?
        WHERE slip_number = ?
        ''',
        (new_in, now, SLIP),
    )
    conn.commit()

    after = cur.execute(
        '''
        SELECT slip_number, truck_number, ticket_status,
               timestamp_in, timestamp_out, updated_at
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP,),
    ).fetchone()
    print(f'\nAfter {SLIP}:', dict(after))
    print(
        '  local in:',
        datetime.fromisoformat(after['timestamp_in'].replace('Z', '+00:00')).astimezone(IST),
    )
    print(f'\nDone. {SLIP} in=18/7/2026 07:02:43 (IST).')
    conn.close()


if __name__ == '__main__':
    main()
