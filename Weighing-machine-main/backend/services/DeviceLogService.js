'use strict';

const { getDb } = require('../database/db');
const ts = require('../utils/timestamp');
const logger = require('../utils/logger');

const DeviceLogService = {
  insert({ device_type, event_type, message, metadata = null }) {
    try {
      const metaJson =
        metadata && typeof metadata === 'object'
          ? JSON.stringify(metadata)
          : metadata;
      getDb()
        .prepare(
          `INSERT INTO device_logs (device_type, event_type, message, metadata, timestamp)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(device_type, event_type, message, metaJson, ts.now());
    } catch (err) {
      logger.warn('DeviceLogService.insert failed', { message: err.message });
    }
  },
};

module.exports = DeviceLogService;
