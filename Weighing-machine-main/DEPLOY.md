# Remote Admin Panel — Deployment Guide

Browser admin for Weighbridge Manager (site **WB-03**). The weighbridge PC syncs directly to RDS/S3; Render and Vercel only serve the admin API and UI.

## Architecture

```
Browser (Vercel admin-web)
    → Render admin-api → RDS PostgreSQL + S3 presign

Weighbridge PC (Electron)
    ↔ RDS + S3 via CloudAdminSyncService (not through Render)
```

- **Local SQLite** on the PC = source of truth for live weighing
- **RDS `transactions_mirror`** = reports shown in the web admin
- **Web edits** → `admin_commands` → PC applies via `AdminReportService`
- **Settings** → `site_settings` → PC pulls via `SettingsService`

---

## 1. RDS (one-time)

1. Run [`scripts/rds/001_schema.sql`](scripts/rds/001_schema.sql) if not already applied.
2. Run [`scripts/rds/002_admin_panel.sql`](scripts/rds/002_admin_panel.sql) in pgAdmin or `psql`.
3. Confirm tables exist: `sites`, `admin_users`, `transactions_mirror`, `site_settings`, `admin_commands`.
4. Ensure RDS security group allows PostgreSQL **5432** from:
   - Your home IP (dev)
   - Render outbound IPs (check Render docs for your region)
   - Weighbridge PC public IP

---

## 2. Render — admin-api

**Root directory:** `admin-api`

| Setting | Value |
|---------|--------|
| Build command | `npm install` |
| Start command | `npm start` |
| Health check | `/health` |

**Environment variables:**

| Variable | Example |
|----------|---------|
| `DATABASE_URL` | `postgresql://weighbridge:PASSWORD@host:5432/postgres?sslmode=require` |
| `JWT_SECRET` | Long random string |
| `ADMIN_BOOTSTRAP_EMAIL` | Your admin email |
| `ADMIN_BOOTSTRAP_PASSWORD` | Strong password (used only when `admin_users` is empty) |
| `AWS_ACCESS_KEY_ID` | S3 read/presign |
| `AWS_SECRET_ACCESS_KEY` | |
| `AWS_REGION` | `ap-south-1` |
| `AWS_S3_BUCKET` | `weighbridge-management-system` |
| `SITE_ID` | `WB-03` |
| `CORS_ORIGIN` | `https://your-admin-web.vercel.app` |

After first deploy, open `https://your-api.onrender.com/health` — should return `{"ok":true}`.

Login uses bootstrap credentials on first run; change password later via DB or re-seed.

---

## 3. Vercel — admin-web

**Root directory:** `admin-web`

| Setting | Value |
|---------|--------|
| Framework | Vite |
| Build command | `npm run build` |
| Output | `dist` |

**Environment variable:**

| Variable | Value |
|----------|--------|
| `VITE_API_URL` | `https://your-api.onrender.com` |

Redeploy after changing `VITE_API_URL`.

---

## 4. Weighbridge PC (Electron app)

Add to root `.env` (same RDS as admin-api):

```env
PG_SYNC_URL=postgresql://weighbridge:PASSWORD@database-1.cd66cqyiuaay.ap-south-1.rds.amazonaws.com:5432/postgres?sslmode=require
WEIGHBRIDGE_ID=WB-03
ADMIN_SYNC_INTERVAL_SECONDS=30

AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-south-1
AWS_S3_BUCKET=weighbridge-management-system
```

1. Pull latest app code from GitHub.
2. `npm install`
3. Start the app — `CloudAdminSyncService` starts with the Electron bootstrap.
4. Closed tickets push to `transactions_mirror`; web edits pull via `admin_commands`.

**Important:** Do not use production `PG_SYNC_URL` on a dev laptop — test data will appear in the admin panel.

---

## 5. Local development

**admin-api** (port 3001):

```bash
cd admin-api
cp .env.example .env   # or edit existing .env
npm install
npm run dev
```

**admin-web** (port 5173):

```bash
cd admin-web
echo VITE_API_URL=http://localhost:3001 > .env
npm install
npm run dev
```

Open `http://localhost:5173`, log in with bootstrap credentials from `admin-api/.env`.

---

## 6. Verify end-to-end

1. Close a ticket on the weighbridge PC → row appears in admin **Reports** within ~30s.
2. Edit a report in admin → command shows **pending**, then **applied** on PC.
3. Change weight offset in **Advance Settings** → PC pulls on next sync.
4. Export CSV/Excel from admin; open PDF if report was synced to S3.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `relation "admin_users" does not exist` | Run `002_admin_panel.sql` on RDS |
| Login fails | Check `ADMIN_BOOTSTRAP_*` and that `admin_users` is empty on first bootstrap |
| No reports in admin | Confirm `PG_SYNC_URL` + `WEIGHBRIDGE_ID=WB-03` on PC; check `transactions_mirror` in pgAdmin |
| CORS error | Set `CORS_ORIGIN` on Render to exact Vercel URL |
| Commands stuck pending | PC must be online with sync running; check app logs for `CloudAdminSync` |
| Photos missing | Verify AWS keys on PC and Render; S3 keys under `mirror/{siteId}/...` |
