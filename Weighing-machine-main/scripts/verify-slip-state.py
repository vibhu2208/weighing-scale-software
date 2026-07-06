import os
import re
import sqlite3

DB_PATH = os.path.join(
    os.environ['APPDATA'],
    'weighbridge-app',
    'weighbridge-data',
    'database',
    'weighbridge.db',
)


def parse_num(slip):
    match = re.search(r'(\d+)\s*$', str(slip or ''))
    return int(match.group(1)) if match else 0


conn = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
cur = conn.cursor()
counter = cur.execute(
    'SELECT current_value, prefix, updated_at FROM slip_counter',
).fetchone()
print('slip_counter:', counter)
wb40 = cur.execute(
    "SELECT slip_number, ticket_status FROM transactions WHERE slip_number LIKE 'WB40%'",
).fetchall()
print('WB40xx remaining:', wb40)
slips = [r[0] for r in cur.execute(
    'SELECT slip_number FROM transactions WHERE slip_number IS NOT NULL',
).fetchall()]
nums = sorted(set(parse_num(s) for s in slips), reverse=True)
print('Top slips:', [f'WB{n:04d}' for n in nums[:5]])
print('WB1142 present:', 'WB1142' in slips)
conn.close()
