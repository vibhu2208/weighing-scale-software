import os
import sqlite3

DB_PATH = os.path.join(
    os.environ['APPDATA'],
    'weighbridge-app',
    'weighbridge-data',
    'database',
    'weighbridge.db',
)

print('DB:', DB_PATH)
print('exists:', os.path.exists(DB_PATH))
conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row
cur = conn.cursor()
print('--- columns ---')
for r in cur.execute('PRAGMA table_info(transactions)'):
    print(dict(r))
print('--- WB3571 ---')
row = cur.execute(
    "SELECT * FROM transactions WHERE slip_number = ?",
    ('WB3571',),
).fetchone()
if not row:
    print('NOT FOUND')
    nearby = cur.execute(
        """
        SELECT slip_number, truck_number, ticket_status, status
        FROM transactions
        WHERE slip_number LIKE 'WB357%'
        ORDER BY slip_number
        """
    ).fetchall()
    for n in nearby:
        print(dict(n))
else:
    d = dict(row)
    for k, v in d.items():
        print(f'{k}: {v}')
conn.close()
