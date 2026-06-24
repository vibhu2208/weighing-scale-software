'use strict';

const fs = require('fs');
const path = require('path');
const winston = require('winston');
const Transport = require('winston-transport');
const { getLogPath, PATHS, ensureDir } = require('./fileStorage');

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const IS_DEV = (process.env.APP_ENV || 'development') === 'development';
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_ROTATED = 7;

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function shouldLog(level) {
  return (LEVELS[level] ?? 2) <= (LEVELS[LOG_LEVEL] ?? 2);
}

function buildEntry(info) {
  const meta = info.meta && typeof info.meta === 'object' ? { ...info.meta } : {};
  return {
    level: info.level,
    timestamp: info.timestamp || new Date().toISOString(),
    message: info.message,
    meta,
  };
}

function rotateLogFile(filePath, baseName) {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.statSync(filePath);
  if (stat.size < MAX_BYTES) return;

  const stamp = new Date().toISOString().slice(0, 10);
  let target = path.join(path.dirname(filePath), `${baseName}.${stamp}.log`);
  let n = 1;
  while (fs.existsSync(target)) {
    target = path.join(path.dirname(filePath), `${baseName}.${stamp}.${n}.log`);
    n += 1;
  }
  fs.renameSync(filePath, target);

  const dir = path.dirname(filePath);
  const pattern = new RegExp(`^${baseName.replace('.', '\\.')}\\.`);
  fs.readdirSync(dir)
    .filter((f) => pattern.test(f) && f.endsWith('.log') && f !== path.basename(filePath))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(KEEP_ROTATED)
    .forEach(({ f }) => {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        /* ignore */
      }
    });

  fs.writeFileSync(filePath, '', 'utf8');
}

class RotatingJsonFile {
  constructor(filename, baseName) {
    this.filename = filename;
    this.baseName = baseName;
  }

  /** Resolve at write time so packaged apps pick up initPackagedStorage() paths. */
  resolvePath() {
    ensureDir(PATHS.LOGS);
    const filePath = getLogPath(this.filename);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf8');
    return filePath;
  }

  write(info) {
    try {
      const filePath = this.resolvePath();
      rotateLogFile(filePath, this.baseName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf8');
      fs.appendFileSync(filePath, `${JSON.stringify(buildEntry(info))}\n`, 'utf8');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[logger] write failed:', err.message);
    }
  }
}

const appSink = new RotatingJsonFile('app.log', 'app');
const errorSink = new RotatingJsonFile('error.log', 'error');
const deviceSink = new RotatingJsonFile('device.log', 'device');
const externalDisplaySink = new RotatingJsonFile('external-display.log', 'external-display');

class FileRouterTransport extends Transport {
  log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    if (!shouldLog(info.level)) {
      callback();
      return;
    }
    appSink.write(info);
    if (info.level === 'error') errorSink.write(info);
    if (info.meta && info.meta.type === 'device') {
      deviceSink.write(info);
      if (info.meta.deviceType === 'externalDisplay') {
        externalDisplaySink.write(info);
      }
    }
    callback();
  }
}

const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format((info) => {
      const { level, message, timestamp, stack, ...rest } = info;
      const meta = { ...rest };
      if (stack) meta.stack = stack;
      // Mutate in place — returning a new object drops Winston's internal
      // level/message symbols and silently prevents all file transports.
      info.meta = meta;
      return info;
    })(),
  ),
  transports: [new FileRouterTransport()],
  exitOnError: false,
});

if (IS_DEV) {
  logger.add(
    new winston.transports.Console({
      level: LOG_LEVEL,
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message, meta }) => {
          const extra =
            meta && Object.keys(meta).length
              ? ` ${JSON.stringify(meta)}`
              : '';
          return `${timestamp} ${level} ${message}${extra}`;
        }),
      ),
    }),
  );
}

const SKIP_DEVICE_LOG_DB = new Set(['weight-change']);

function logDevice(deviceType, eventType, message, metadata = {}) {
  logger.info(message, {
    type: 'device',
    deviceType,
    eventType,
    ...metadata,
  });
  if (SKIP_DEVICE_LOG_DB.has(eventType)) return;
  try {
    const DeviceLogService = require('../services/DeviceLogService');
    DeviceLogService.insert({
      device_type: deviceType,
      event_type: eventType,
      message,
      metadata,
    });
  } catch (err) {
    logger.warn('logDevice: device_logs insert failed', { message: err.message });
  }
}

function logTransaction(transactionId, event, metadata = {}) {
  logger.info(event, { type: 'transaction', transactionId, ...metadata });
}

function logSync(event, metadata = {}) {
  logger.info(event, { type: 'sync', ...metadata });
}

function logError(context, error) {
  const err = error instanceof Error ? error : new Error(String(error));
  logger.error(context, {
    type: 'error',
    message: err.message,
    stack: err.stack,
    code: err.code,
  });
}

logger.device = (deviceName, message, meta = {}) =>
  logDevice(deviceName, meta.event_type || 'event', message, meta);

logger.logDevice = logDevice;
logger.logTransaction = logTransaction;
logger.logSync = logSync;
logger.logError = logError;

module.exports = logger;
module.exports.logDevice = logDevice;
module.exports.logTransaction = logTransaction;
module.exports.logSync = logSync;
module.exports.logError = logError;
