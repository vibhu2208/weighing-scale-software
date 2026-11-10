'use strict';

const {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function getConfig() {
  return {
    accessKeyId: (process.env.AWS_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: (process.env.AWS_SECRET_ACCESS_KEY || '').trim(),
    region: (process.env.AWS_REGION || 'eu-north-1').trim(),
    bucket: (process.env.AWS_S3_BUCKET || 'k1-k2').trim(),
  };
}

function isConfigured() {
  const { accessKeyId, secretAccessKey } = getConfig();
  return Boolean(accessKeyId && secretAccessKey);
}

let cachedClient = null;
let cachedClientKey = '';

function getClient() {
  const { accessKeyId, secretAccessKey, region } = getConfig();
  const key = `${region}\0${accessKeyId}\0${secretAccessKey}`;
  if (!cachedClient || cachedClientKey !== key) {
    cachedClient = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });
    cachedClientKey = key;
  }
  return cachedClient;
}

function getBucket() {
  return getConfig().bucket;
}

async function presignGet(key, expiresIn = 3600) {
  if (!isConfigured()) throw new Error('S3 not configured');
  const command = new GetObjectCommand({ Bucket: getBucket(), Key: key });
  return getSignedUrl(getClient(), command, { expiresIn });
}

async function presignPut(key, contentType = 'image/jpeg', expiresIn = 3600) {
  if (!isConfigured()) throw new Error('S3 not configured');
  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(getClient(), command, { expiresIn });
}

async function objectExists(key) {
  if (!isConfigured() || !key) return false;
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: getBucket(), Key: key }));
    return true;
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') return false;
    throw err;
  }
}

async function putObject(key, body, contentType = 'image/jpeg') {
  if (!isConfigured()) throw new Error('S3 not configured');
  await getClient().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return key;
}

async function getObjectBuffer(key) {
  if (!isConfigured() || !key) return null;
  try {
    const res = await getClient().send(
      new GetObjectCommand({ Bucket: getBucket(), Key: key }),
    );
    const chunks = [];
    for await (const chunk of res.Body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') return null;
    throw err;
  }
}

function mirrorPhotoKey(siteId, slip, slot, pass = 'departure') {
  return `sites/${siteId}/mirror/${slip}/${pass}_cam-${slot}.jpg`;
}

function mirrorReportKey(siteId, slip) {
  return `sites/${siteId}/mirror/${slip}/report.pdf`;
}

/** Gross-print-date PDF used by ZIP downloads — never overwrites report.pdf. */
function mirrorReportGrossKey(siteId, slip) {
  return `sites/${siteId}/mirror/${slip}/report_gross.pdf`;
}

function encodeCopySource(bucket, key) {
  return `${bucket}/${String(key)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

async function copyObject(sourceKey, destKey) {
  if (!isConfigured()) throw new Error('S3 not configured');
  if (!sourceKey || !destKey) throw new Error('sourceKey and destKey required');
  if (sourceKey === destKey) return destKey;
  const bucket = getBucket();
  await getClient().send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: encodeCopySource(bucket, sourceKey),
      Key: destKey,
      ContentType: 'image/jpeg',
      MetadataDirective: 'REPLACE',
    }),
  );
  return destKey;
}

function remoteTripPhotoKey(slip, slot, pass = 'departure') {
  const tag = pass === 'arrival' ? 'arrival' : 'departure';
  return `remote-trips/${slip}/${tag}_cam-${slot}.jpg`;
}

function remoteTripPhotoThumbKey(slip, slot, pass = 'departure') {
  const tag = pass === 'arrival' ? 'arrival' : 'departure';
  return `remote-trips/${slip}/${tag}_cam-${slot}.thumb.jpg`;
}

function mirrorPhotoThumbKey(siteId, slip, slot, pass = 'departure') {
  return `sites/${siteId}/mirror/${slip}/${pass}_cam-${slot}.thumb.jpg`;
}

function fillVehicleStillKey(plate, pass = 'departure', slot = 1) {
  const safe = String(plate || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const tag = pass === 'arrival' ? 'arrival' : 'departure';
  const slotNum = Number(slot) === 2 ? 2 : 1;
  return `fill-vehicles/${safe}/${tag}_cam-${slotNum}.jpg`;
}

async function listKeys(prefix, maxKeys = 40) {
  if (!isConfigured() || !prefix) return [];
  try {
    const res = await getClient().send(
      new ListObjectsV2Command({
        Bucket: getBucket(),
        Prefix: prefix,
        MaxKeys: maxKeys,
      }),
    );
    return (res.Contents || []).map((obj) => obj.Key).filter(Boolean);
  } catch (_err) {
    return [];
  }
}

function inferPhotoFieldFromKey(s3Key) {
  const base = String(s3Key || '')
    .split('/')
    .pop()
    .toLowerCase();
  if (!base) return null;
  const arrivalCam = base.match(/arrival[-_]?cam[-_]?(\d)/);
  if (arrivalCam) return `arrival_photo_${arrivalCam[1]}`;
  const departureCam = base.match(/departure[-_]?cam[-_]?(\d)/);
  if (departureCam) return `departure_photo_${departureCam[1]}`;
  const ac = base.match(/(?:^|[-_])ac(\d)/);
  if (ac) return `arrival_photo_${ac[1]}`;
  const dc = base.match(/(?:^|[-_])dc(\d)/);
  if (dc) return `departure_photo_${dc[1]}`;
  return null;
}

module.exports = {
  isConfigured,
  getClient,
  presignGet,
  presignPut,
  objectExists,
  listKeys,
  inferPhotoFieldFromKey,
  putObject,
  copyObject,
  getObjectBuffer,
  mirrorPhotoKey,
  mirrorReportKey,
  mirrorReportGrossKey,
  remoteTripPhotoKey,
  remoteTripPhotoThumbKey,
  mirrorPhotoThumbKey,
  fillVehicleStillKey,
  getBucket,
};
