'use strict';

const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function getConfig() {
  return {
    accessKeyId: (process.env.AWS_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: (process.env.AWS_SECRET_ACCESS_KEY || '').trim(),
    region: (process.env.AWS_REGION || 'ap-south-1').trim(),
    bucket: (process.env.AWS_S3_BUCKET || 'k1-k2').trim(),
  };
}

function isConfigured() {
  const { accessKeyId, secretAccessKey } = getConfig();
  return Boolean(accessKeyId && secretAccessKey);
}

function getClient() {
  const { accessKeyId, secretAccessKey, region } = getConfig();
  return new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
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

function mirrorPhotoKey(siteId, slip, slot, pass = 'departure') {
  return `sites/${siteId}/mirror/${slip}/${pass}_cam-${slot}.jpg`;
}

function mirrorReportKey(siteId, slip) {
  return `sites/${siteId}/mirror/${slip}/report.pdf`;
}

function remoteTripPhotoKey(slip, slot, pass = 'departure') {
  const tag = pass === 'arrival' ? 'arrival' : 'departure';
  return `remote-trips/${slip}/${tag}_cam-${slot}.jpg`;
}

async function objectExists(key) {
  const s3Key = String(key || '').trim();
  if (!s3Key || !isConfigured()) return false;
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: getBucket(), Key: s3Key }));
    return true;
  } catch (_err) {
    return false;
  }
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
  presignGet,
  presignPut,
  objectExists,
  listKeys,
  inferPhotoFieldFromKey,
  mirrorPhotoKey,
  mirrorReportKey,
  remoteTripPhotoKey,
  getBucket,
};
