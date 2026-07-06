'use strict';

const fs = require('fs');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');

const SettingsService = require('./SettingsService');

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const CONNECTION_TIMEOUT_MS = 30 * 1000;

let client = null;

function getConfig() {
  return {
    accessKeyId: (SettingsService.get('AWS_ACCESS_KEY_ID') || '').trim(),
    secretAccessKey: (SettingsService.get('AWS_SECRET_ACCESS_KEY') || '').trim(),
    region: (SettingsService.get('AWS_REGION') || 'ap-south-1').trim(),
    bucket: (SettingsService.get('AWS_S3_BUCKET') || 'weighbridge-management-system').trim(),
  };
}

function isConfigured() {
  const { accessKeyId, secretAccessKey } = getConfig();
  return Boolean(accessKeyId && secretAccessKey);
}

function getClient() {
  if (!isConfigured()) {
    throw new Error('AWS credentials are not configured');
  }
  if (!client) {
    const { accessKeyId, secretAccessKey, region } = getConfig();
    client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
      requestHandler: new NodeHttpHandler({
        requestTimeout: REQUEST_TIMEOUT_MS,
        connectionTimeout: CONNECTION_TIMEOUT_MS,
      }),
    });
  }
  return client;
}

function getBucket() {
  return getConfig().bucket;
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

  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: body,
      ContentType: type,
    }),
  );
  return { bucket, key: s3Key };
}

/**
 * Download an S3 object to a local path.
 */
async function downloadFile(s3Key, localPath) {
  const bucket = getBucket();
  const res = await getClient().send(
    new GetObjectCommand({ Bucket: bucket, Key: s3Key }),
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
  await getClient().send(
    new DeleteObjectCommand({ Bucket: bucket, Key: s3Key }),
  );
  return { ok: true, key: s3Key };
}

/**
 * List object keys under a prefix (e.g. db-backups/).
 */
async function listKeys(prefix, maxKeys = 200) {
  const all = await listAllKeys(prefix);
  return maxKeys ? all.slice(0, maxKeys) : all;
}

/** List every object key under a prefix (paginated). */
async function listAllKeys(prefix) {
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
        MaxKeys: 1000,
      }),
    );
    for (const obj of res.Contents || []) {
      if (obj.Key && !obj.Key.endsWith('/')) keys.push(obj.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

function resetClient() {
  client = null;
}

module.exports = {
  getConfig,
  isConfigured,
  uploadFile,
  downloadFile,
  deleteFile,
  listKeys,
  listAllKeys,
  resetClient,
};
