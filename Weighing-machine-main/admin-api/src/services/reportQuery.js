'use strict';

const REPORT_DATE_SQL = `CASE
  WHEN ticket_status = 'CLOSED' THEN COALESCE(timestamp_out, updated_at)
  ELSE timestamp_in
END`;

function buildWhere(siteId, filters = {}) {
  const clauses = ['site_id = $1'];
  const params = [siteId];
  let idx = 2;

  if (filters.from) {
    clauses.push(`${REPORT_DATE_SQL} >= $${idx++}`);
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push(`${REPORT_DATE_SQL} <= $${idx++}`);
    params.push(filters.to);
  }
  if (filters.truck_number) {
    clauses.push(`UPPER(truck_number) = $${idx++}`);
    params.push(String(filters.truck_number).trim().toUpperCase());
  }
  if (filters.ticket_status && filters.ticket_status !== 'all') {
    clauses.push(`ticket_status = $${idx++}`);
    params.push(filters.ticket_status);
  }
  if (filters.sync_status && filters.sync_status !== 'all') {
    clauses.push(`sync_status = $${idx++}`);
    params.push(filters.sync_status);
  }
  if (filters.operator_name && filters.operator_name !== 'all') {
    clauses.push(`operator_name = $${idx++}`);
    params.push(filters.operator_name);
  }
  if (filters.material && filters.material !== 'all') {
    clauses.push(`material = $${idx++}`);
    params.push(filters.material);
  }
  if (filters.search && String(filters.search).trim()) {
    const term = `%${String(filters.search).trim()}%`;
    const upperTerm = `%${String(filters.search).trim().toUpperCase()}%`;
    clauses.push(`(
      slip_number ILIKE $${idx} OR
      UPPER(truck_number) LIKE $${idx + 1} OR
      UPPER(COALESCE(rfid_tag, '')) LIKE $${idx + 1} OR
      UPPER(COALESCE(transporter, '')) LIKE $${idx + 1} OR
      UPPER(COALESCE(operator_name, '')) LIKE $${idx + 1} OR
      UPPER(COALESCE(material, '')) LIKE $${idx + 1} OR
      UPPER(COALESCE(destination, '')) LIKE $${idx + 1}
    )`);
    params.push(term, upperTerm);
    idx += 2;
  }

  return { where: `WHERE ${clauses.join(' AND ')}`, params, reportDateSql: REPORT_DATE_SQL };
}

async function queryPaginated(queryFn, siteId, filters = {}) {
  const { where, params, reportDateSql } = buildWhere(siteId, filters);
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 200));
  const page = Math.max(0, Number(filters.page) || 0);
  const offset = page * limit;

  const countRes = await queryFn(
    `SELECT COUNT(*) AS c FROM transactions_mirror ${where}`,
    params,
  );
  const total = Number(countRes.rows[0].c);

  const rowsRes = await queryFn(
    `SELECT * FROM transactions_mirror ${where}
     ORDER BY ${reportDateSql} DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return {
    rows: rowsRes.rows,
    pagination: {
      page,
      pageSize: limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

async function summarise(queryFn, siteId, filters = {}) {
  const { where, params } = buildWhere(siteId, filters);
  const res = await queryFn(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE ticket_status = 'OPEN') AS open_count,
       COUNT(*) FILTER (WHERE ticket_status = 'CLOSED') AS closed_count,
       COALESCE(SUM(gross_weight) FILTER (WHERE ticket_status = 'CLOSED'), 0) AS total_gross,
       COALESCE(SUM(tare_weight) FILTER (WHERE ticket_status = 'CLOSED'), 0) AS total_tare,
       COALESCE(SUM(net_weight) FILTER (WHERE ticket_status = 'CLOSED'), 0) AS total_net,
       COUNT(DISTINCT truck_number) AS total_vehicles,
       COUNT(*) FILTER (WHERE report_s3_key IS NOT NULL AND report_s3_key <> '') AS reports_generated
     FROM transactions_mirror ${where}`,
    params,
  );
  return res.rows[0];
}

async function getFilterOptions(queryFn, siteId) {
  const operators = await queryFn(
    `SELECT DISTINCT operator_name AS name FROM transactions_mirror
     WHERE site_id = $1 AND operator_name IS NOT NULL AND operator_name <> ''
     ORDER BY operator_name`,
    [siteId],
  );
  const materials = await queryFn(
    `SELECT DISTINCT material AS name FROM transactions_mirror
     WHERE site_id = $1 AND material IS NOT NULL AND material <> ''
     ORDER BY material`,
    [siteId],
  );
  return {
    operators: operators.rows.map((r) => r.name),
    materials: materials.rows.map((r) => r.name),
  };
}

function formatExportRow(row) {
  const fmtDate = (iso) => {
    if (!iso) return { date: '', time: '' };
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { date: '', time: '' };
    const pad = (n) => String(n).padStart(2, '0');
    return {
      date: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
  };
  const gross = fmtDate(row.timestamp_out);
  const tare = fmtDate(row.timestamp_in);
  const net = fmtDate(row.timestamp_out);
  const entry = fmtDate(row.timestamp_in);
  return [
    row.slip_number || '',
    row.customer_name || '',
    row.truck_number || '',
    row.material || '',
    row.customer_name || '',
    row.operator_name || '',
    row.destination || '',
    row.gross_weight ?? '',
    row.tare_weight ?? '',
    row.net_weight ?? '',
    gross.date,
    gross.time,
    tare.date,
    tare.time,
    net.date,
    net.time,
    entry.date,
  ];
}

const EXPORT_HEADERS = [
  'Ticket_No',
  'Customer_Name',
  'Vehicle_No',
  'Item_Name',
  'Company_Name',
  'Operator_Name',
  'Destination',
  'GrossWt',
  'TareWt',
  'NetWt',
  'GrossDate',
  'GrossTime',
  'TareDate',
  'TareTime',
  'Net_Date',
  'Net_Time',
  'EntryDate',
];

module.exports = {
  buildWhere,
  queryPaginated,
  summarise,
  getFilterOptions,
  formatExportRow,
  EXPORT_HEADERS,
  REPORT_DATE_SQL,
};
