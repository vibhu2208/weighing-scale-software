# RDS remote trips setup

PostgreSQL on AWS RDS for remote closed-trip entry. The weighbridge Electron app pulls rows into local SQLite.

## RDS connection

| Setting | Value |
|---------|--------|
| Host | `database-1.cd66cqyiuaay.ap-south-1.rds.amazonaws.com` |
| Port | `5432` |
| Database | `postgres` |
| Username | `weighbridge` |
| SSL | Required |

## Home PC (setup now)

1. AWS Console → RDS → your instance → VPC security group → **Inbound rules**
2. Add **PostgreSQL 5432** from your home public IP (`https://ifconfig.me`)/32
3. Open pgAdmin or DBeaver, connect with SSL enabled
4. Run [`001_schema.sql`](./001_schema.sql)
5. Test: `SELECT next_slip_number();` twice → `WB1001`, `WB1002`
6. Optional: `UPDATE slip_counter SET current_value = <your_highest_wb_number> WHERE id = 1;`
7. Upload photos to S3: `remote-trips/{slip}/arrival_cam-1.jpg` in bucket `weighbridge-management-system`
8. Test INSERT (see example in plan or below)

## Weighbridge PC (at site)

1. On weighbridge PC, open `https://ifconfig.me` and add that IP/32 to the **same** RDS security group
2. Copy `.env` (or update Settings) with:

```env
PG_SYNC_URL=postgresql://weighbridge:YOUR_PASSWORD@database-1.cd66cqyiuaay.ap-south-1.rds.amazonaws.com:5432/postgres?sslmode=require
REMOTE_TRIP_SYNC_INTERVAL_SECONDS=30
MCG_PORTAL_ENABLED=true
MCG_PORTAL_URL=https://sms-be.austere.biz/weightbridge
MCG_PORTAL_API_KEY=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-south-1
AWS_S3_BUCKET=weighbridge-management-system
```

3. Run `npm install` in the app folder
4. Test: `psql "$PG_SYNC_URL" -c "SELECT 1;"`
5. Start the app — remote trips sync automatically; new rows appear in **Reports** with no special label

## Remote INSERT example

```sql
INSERT INTO remote_trips (
  truck_number, customer_name, destination, material, operator_name,
  transporter, tare_weight, gross_weight,
  timestamp_in, timestamp_out,
  arrival_photo_1, departure_photo_1
) VALUES (
  'HR38AB1234', 'MCG', 'MEERUT', 'C&D', 'SUNNY',
  'ABC Transport', 8500, 25000,
  '2026-06-27 09:15:00+05:30', '2026-06-27 11:45:00+05:30',
  'remote-trips/WB1043/arrival_cam-1.jpg',
  'remote-trips/WB1043/departure_cam-1.jpg'
);
```

`slip_number` is assigned automatically if omitted.

## S3 keys

Store S3 object keys only in `arrival_photo_*` / `departure_photo_*` columns, e.g.:

`remote-trips/WB1043/arrival_cam-1.jpg`

The weighbridge app downloads these to local `uploads/` on sync so PDF/Excel reports work offline.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Connection timeout | Add current public IP to RDS security group |
| SSL error | Use `sslmode=require` in `PG_SYNC_URL` |
| Slip collision | Ensure weighbridge app is online on startup for counter sync |
| Photos missing in PDF | Check S3 key paths and AWS credentials on weighbridge PC |
| MCG not sent | Check `MCG_PORTAL_*` settings; failed posts retry on next sync |

---

## Remote admin panel (`002_admin_panel.sql`)

Run [`002_admin_panel.sql`](./002_admin_panel.sql) after `001_schema.sql` for the browser admin panel.

Tables: `sites`, `admin_users`, `transactions_mirror`, `site_settings`, `admin_commands`.

### Weighbridge PC — CloudAdminSync

The Electron app pushes closed tickets to `transactions_mirror` and pulls web edits from `admin_commands`. Add to `.env`:

```env
WEIGHBRIDGE_ID=WB-03
ADMIN_SYNC_INTERVAL_SECONDS=30
PG_SYNC_URL=postgresql://weighbridge:YOUR_PASSWORD@database-1.cd66cqyiuaay.ap-south-1.rds.amazonaws.com:5432/postgres?sslmode=require
```

`CloudAdminSyncService` starts automatically with the app (see `electron/main.js`). Do not point a dev laptop at production `PG_SYNC_URL` — test data will sync to the admin panel.

### Deploy

See [`DEPLOY.md`](../../DEPLOY.md) for Render (admin-api) + Vercel (admin-web) setup.
