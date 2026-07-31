import os
import sqlite3
from datetime import datetime, timedelta, timezone

DB_PATH = os.path.join(
    os.environ['APPDATA'],
    'weighbridge-app',
    'weighbridge-data',
    'database',
    'weighbridge.db',
)

SLIP = 'WB2041'
IST = timezone(timedelta(hours=5, minutes=30))
# 03:26:45 IST on the existing out-time calendar date
NEW_OUT = (3, 26, 45)


def to_utc_iso(existing_iso, hour, minute, second):
    utc = datetime.fromisoformat(existing_iso.replace('Z', '+00:00'))
    local = utc.astimezone(IST).replace(
        hour=hour, minute=minute, second=second, microsecond=0,
    )
    return local.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    row = cur.execute(
        '''
        SELECT id, slip_number, truck_number, ticket_status, remote_pg_id,
               timestamp_in, timestamp_out, updated_at
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP,),
    ).fetchone()
    if not row:
        raise SystemExit(f'{SLIP} not found')

    print('Before:', dict(row))
    print(
        '  local in/out:',
        datetime.fromisoformat(row['timestamp_in'].replace('Z', '+00:00')).astimezone(IST),
        '->',
        datetime.fromisoformat(row['timestamp_out'].replace('Z', '+00:00')).astimezone(IST),
    )

    new_out = to_utc_iso(row['timestamp_out'], *NEW_OUT)
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

    cur.execute(
        '''
        UPDATE transactions
        SET timestamp_out = ?,
            updated_at = ?
        WHERE slip_number = ?
        ''',
        (new_out, now, SLIP),
    )
    conn.commit()

    after = cur.execute(
        '''
        SELECT slip_number, truck_number, ticket_status, remote_pg_id,
               timestamp_in, timestamp_out, updated_at
        FROM transactions WHERE slip_number = ?
        ''',
        (SLIP,),
    ).fetchone()
    print('After:', dict(after))
    print(
        '  local in/out:',
        datetime.fromisoformat(after['timestamp_in'].replace('Z', '+00:00')).astimezone(IST),
        '->',
        datetime.fromisoformat(after['timestamp_out'].replace('Z', '+00:00')).astimezone(IST),
    )
    print(f'\nDone. {SLIP} out=03:26:45 IST.')
    if after['remote_pg_id']:
        print(f"remote_pg_id={after['remote_pg_id']} (update RDS separately if needed)")
    conn.close()


if __name__ == '__main__':
    main()
