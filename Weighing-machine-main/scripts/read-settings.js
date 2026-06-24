'use strict';
const Database = require('better-sqlite3');
const db = new Database('./database/weighbridge.db');
const rows = db
  .prepare(
    "SELECT key, value FROM settings WHERE key LIKE '%WEIGH%' OR key LIKE '%DISPLAY%' OR key LIKE '%EXTERNAL%' OR key LIKE '%MOCK%'",
  )
  .all();
console.log(JSON.stringify(rows, null, 2));
