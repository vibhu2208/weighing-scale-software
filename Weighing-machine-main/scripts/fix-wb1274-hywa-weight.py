'use strict';

import json
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

SLIP = 'WB1274'
TRUCK = 'HR55AH4848'


def main():
    print(f'DB path: {DB_PATH}')
    if not os.path.exists(DB_PATH):
        raise SystemExit('Database file not found')

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    row = cur.execute(
        'SELECT * FROM transactions WHERE slip_number = ?',
        (SLIP,),
    ).fetchone()
    if not row:
        raise SystemExit(f'{SLIP} not found')
    if row['truck_number'] != TRUCK:
        raise SystemExit(
            f'Expected truck {TRUCK}, found {row["truck_number"]}',
        )

    print('\nBefore transaction:')
    print(
        f"  gross_weight={row['gross_weight']}, tare_weight={row['tare_weight']}, "
        f"raw_gross={row['raw_gross_weight']}, raw_tare={row['raw_tare_weight']}",
    )

    vehicle = cur.execute(
        'SELECT vehicle_number, vehicle_type FROM vehicles WHERE vehicle_number = ?',
        (TRUCK,),
    ).fetchone()
    print('Before vehicle:', dict(vehicle) if vehicle else None)

    if row['gross_weight'] is not None:
        raise SystemExit(f'{SLIP} already has gross_weight — aborting')
    if row['tare_weight'] is None:
        raise SystemExit(f'{SLIP} has no tare_weight to move — aborting')

    weight = row['tare_weight']
    raw_weight = row['raw_tare_weight']

    snaps = {'tare': [], 'gross': []}
    if row['camera_snapshots']:
        parsed = json.loads(row['camera_snapshots'])
        snaps['tare'] = parsed.get('tare') or []
        snaps['gross'] = parsed.get('gross') or []

    fixed_snaps = json.dumps(
        {'tare': [], 'gross': snaps['tare'] + snaps['gross']},
        separators=(',', ':'),
    )

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
    cur.execute(
        """
        UPDATE transactions SET
          gross_weight = ?,
          raw_gross_weight = ?,
          tare_weight = NULL,
          raw_tare_weight = NULL,
          tare_image_path = NULL,
          camera_snapshots = ?,
          updated_at = ?
        WHERE slip_number = ?
        """,
        (weight, raw_weight, fixed_snaps, now, SLIP),
    )

    if vehicle and str(vehicle['vehicle_type'] or '').lower() != 'hywa':
        cur.execute(
            """
            UPDATE vehicles SET vehicle_type = ?, updated_at = ?
            WHERE vehicle_number = ?
            """,
            ('hywa', now, TRUCK),
        )

    conn.commit()

    after = cur.execute(
        'SELECT gross_weight, tare_weight, raw_gross_weight, raw_tare_weight, '
        'ticket_status FROM transactions WHERE slip_number = ?',
        (SLIP,),
    ).fetchone()
    vehicle_after = cur.execute(
        'SELECT vehicle_number, vehicle_type FROM vehicles WHERE vehicle_number = ?',
        (TRUCK,),
    ).fetchone()

    print('\nAfter transaction:', dict(after))
    print('After vehicle:', dict(vehicle_after) if vehicle_after else None)
    print(
        f'\nDone. {SLIP} open weigh is now gross ({weight} kg). '
        'Close pass will record tare when the loaded truck returns.',
    )
    conn.close()


if __name__ == '__main__':
    main()
