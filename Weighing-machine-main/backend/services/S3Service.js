'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');

const SettingsService = require('./SettingsService');

// Prefer IPv4 — some Windows/ISP setups hang on IPv6 to AWS.
try {
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (_e) {
  /* ignore */
}

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const CONNECTION_TIMEOUT_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

let client = null;
let clientFingerprint = '';

function getConfig() {
  return {
    accessKeyId: (SettingsService.get('AWS_ACCESS_KEY_ID') || '').trim(),
    secretAccessKey: (SettingsService.get('AWS_SECRET_ACCESS_KEY') || '').trim(),
    region: (SettingsService.get('AWS_REGION') || 'eu-north-1').trim(),
    bucket: (SettingsService.get('AWS_S3_BUCKET') || 'k1-k2').trim(),
  };
}

function isConfigured() {
  const { accessKeyId, secretAccessKey } = getConfig();
  return Boolean(accessKeyId && secretAccessKey);
}

function configFingerprint(cfg) {
  return `${cfg.region}|${cfg.bucket}|${cfg.accessKeyId}|${cfg.secretAccessKey.slice(0, 4)}`;
}

function getClient() {
  if (!isConfigured()) {
    throw new Error('AWS credentials are not configured');
  }
  const cfg = getConfig();
  const fp = configFingerprint(cfg);
  if (!client || clientFingerprint !== fp) {
    client = new S3Client({
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      maxAttempts: MAX_ATTEMPTS,
      requestHandler: new NodeHttpHandler({
        requestTimeout: REQUEST_TIMEOUT_MS,
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        throwOnRequestTimeout: true,
        socketAcquisitionWarningTimeout: CONNECTION_TIMEOUT_MS,
      }),
    });
    clientFingerprint = fp;
  }
  return client;
}

function getBucket() {
  return getConfig().bucket;
}

function isRetryableS3Error(err) {
  const msg = String(err?.message || err || '');
  const name = String(err?.name || '');
  const status = err?.$metadata?.httpStatusCode;
  // Wrong AWS_REGION → 301 / PermanentRedirect. Retrying burns minutes and blocks sync.
  if (
    status === 301 ||
    /PermanentRedirect|specified endpoint|AuthorizationHeaderMalformed/i.test(msg) ||
    /PermanentRedirect/i.test(name)
  ) {
    return false;
  }
  return (
    /timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket|networkingerror|unknownerror|throttl/i.test(
      msg,
    ) ||
    /timeout|networkingerror|timeouterror/i.test(name) ||
    status === 503 ||
    status === 500
  );
}

async function withS3Retry(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableS3Error(err) || attempt >= MAX_ATTEMPTS) break;
      // Drop cached client — stale sockets often cause repeated timeouts.
      resetClient();
      const delayMs = Math.min(15000, 1000 * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  const detail = lastErr?.message || String(lastErr);
  throw new Error(`S3 ${label} failed after ${MAX_ATTEMPTS} attempts: ${detail}`);
}

async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Upload a local file to S3.
 * @param {string} localPath
 * @param {string} s3Key
 * @param {string} [contentType]
 */
async function uploadFile(localPath, s3Key, contentType) {
  const bucket = getBucket();
  const body = await fs.promises.readFile(localPath);
  const ext = path.extname(localPath).toLowerCase();
  const type =
    contentType ||
    (ext === '.pdf'
      ? 'application/pdf'
      : ext === '.gz'
        ? 'application/gzip'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.log'
            ? 'text/plain'
            : 'application/octet-stream');

  await withS3Retry(`upload ${s3Key}`, () =>
    getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: body,
        ContentType: type,
      }),
    ),
  );
  return { bucket, key: s3Key };
}

function isMissingObject(err) {
  const status = err?.$metadata?.httpStatusCode;
  const name = err?.name || err?.Code || '';
  return status === 404 || name === 'NotFound' || name === 'NoSuchKey';
}

async function objectExists(s3Key) {
  const key = (s3Key || '').trim();
  if (!key || !isConfigured()) return false;
  try {
    await getClient().send(
      new HeadObjectCommand({ Bucket: getBucket(), Key: key }),
    );
    return true;
  } catch (err) {
    if (isMissingObject(err)) return false;
    throw err;
  }
}

/**
 * Download an S3 object to a local path.
 */
async function downloadFile(s3Key, localPath) {
  const bucket = getBucket();
  const res = await withS3Retry(`download ${s3Key}`, () =>
    getClient().send(
      new GetObjectCommand({ Bucket: bucket, Key: s3Key }),
    ),
  );
  const buf = await streamToBuffer(res.Body);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  await fs.promises.writeFile(localPath, buf);
  return localPath;
}

/**
 * Delete an object from S3.
 */
async function deleteFile(s3Key) {
  const bucket = getBucket();
  await withS3Retry(`delete ${s3Key}`, () =>
    getClient().send(
      new DeleteObjectCommand({ Bucket: bucket, Key: s3Key }),
    ),
  );
  return { ok: true, key: s3Key };
}

/**
 * List object keys under a prefix, stopping once maxKeys is reached.
 */
async function listKeys(prefix, maxKeys = 200) {
  if (!maxKeys) return listAllKeys(prefix);
  const bucket = getBucket();
  const keys = [];
  let token;
  do {
    // eslint-disable-next-line no-await-in-loop
    const res = await getClient().send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: Math.min(1000, maxKeys - keys.length),
      }),
    );
    for (const obj of res.Contents || []) {
      if (obj.Key && !obj.Key.endsWith('/')) keys.push(obj.Key);
      if (keys.length >= maxKeys) return keys;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** List every object key under a prefix (paginated). */
async function listAllKeys(prefix) {
  const bucket = getBucket();
  const keys = [];
  let token;
  do {
    // eslint-disable-next-line no-await-in-loop
    const res = await withS3Retry(`list ${prefix}`, () =>
      getClient().send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
      ),
    );
    for (const obj of res.Contents || []) {
      if (obj.Key && !obj.Key.endsWith('/')) keys.push(obj.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

function resetClient() {
  if (client) {
    try {
      client.destroy?.();
    } catch (_e) {
      /* ignore */
    }
  }
  client = null;
  clientFingerprint = '';
}

function mirrorPhotoKey(siteId, slip, slot, pass = 'departure') {
  return `sites/${siteId}/mirror/${slip}/${pass}_cam-${slot}.jpg`;
}

function mirrorReportKey(siteId, slip) {
  return `sites/${siteId}/mirror/${slip}/report.pdf`;
}

module.exports = {
  getConfig,
  isConfigured,
  uploadFile,
  downloadFile,
  objectExists,
  isMissingObject,
  deleteFile,
  listKeys,
  listAllKeys,
  resetClient,
  mirrorPhotoKey,
  mirrorReportKey,
};
