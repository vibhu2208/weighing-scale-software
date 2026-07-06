'use strict';

const fs = require('fs');
const { getLogPath } = require('./fileStorage');

function append(line) {
  const ts = new Date().toISOString();
  const row = `[${ts}] ${line}\n`;
  try {
    // Resolve at write time so packaged apps use userData after initPackagedStorage().
    fs.appendFileSync(getLogPath('backup.log'), row, 'utf8');
  } catch {
    /* never block weighing on log failure */
  }
}

const backupLogger = {
  backupStarted: () => append('Backup Started'),
  backupCompleted: (detail) => append(`Backup Completed${detail ? ` — ${detail}` : ''}`),
  reportUploaded: (name) => append(`Report Uploaded — ${name}`),
  imageUploaded: (name) => append(`Image Uploaded — ${name}`),
  databaseBackupUploaded: (name) => append(`Database Backup Uploaded — ${name}`),
  logUploaded: (name) => append(`Log Uploaded — ${name}`),
  logsUploadCompleted: (detail) =>
    append(`Log Upload Completed${detail ? ` — ${detail}` : ''}`),
  uploadFailed: (name, err) =>
    append(`Upload Failed — ${name}${err ? `: ${err}` : ''}`),
  retryAttempt: (name, attempt) => append(`Retry Attempt — ${name} (#${attempt})`),
  info: (msg) => append(msg),
};

module.exports = backupLogger;
