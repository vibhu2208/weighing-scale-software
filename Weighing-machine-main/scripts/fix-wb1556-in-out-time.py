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

SLIP = 'WB1556'
IST = timezone(timedelta(hours=5, minutes=30))
NEW_IN_LOCAL = (0, 48, 32)
NEW_OUT_LOCAL = (3, 23, 16)


def to_utc_iso(existing_iso, hour, minute, second):
    """Keep the existing local calendar date; replace clock time (IST)."""
    utc = datetime.fromisoformat(existing_iso.replace('Z', '+00:00'))
    local = utc.astimezone(IST).replace(
        hour=hour, minute=minute, second=second, microsecond=0,
    )
    return local.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    free = shutil.disk_usage(os.path.dirname(DB_PATH)).free
    if free > os.path.getsize(DB_PATH) + 50_000_000:
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        backup = DB_PATH + f'.bak-wb1556-times-{stamp}'
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
        '  local in/out:',
        datetime.fromisoformat(row['timestamp_in'].replace('Z', '+00:00')).astimezone(IST),
        '->',
        datetime.fromisoformat(row['timestamp_out'].replace('Z', '+00:00')).astimezone(IST),
    )

    new_in = to_utc_iso(row['timestamp_in'], *NEW_IN_LOCAL)
    new_out = to_utc_iso(row['timestamp_out'], *NEW_OUT_LOCAL)
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

    cur.execute(
        '''
        UPDATE transactions
        SET timestamp_in = ?,
            timestamp_out = ?,
            updated_at = ?
        WHERE slip_number = ?
        ''',
        (new_in, new_out, now, SLIP),
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
        '  local in/out:',
        datetime.fromisoformat(after['timestamp_in'].replace('Z', '+00:00')).astimezone(IST),
        '->',
        datetime.fromisoformat(after['timestamp_out'].replace('Z', '+00:00')).astimezone(IST),
    )
    print(f'\nDone. {SLIP} in=00:48:32 out=03:23:16 (local).')
    conn.close()


if __name__ == '__main__':
    main()
