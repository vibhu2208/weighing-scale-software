'use strict';

const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function getConfig() {
  return {
    accessKeyId: (process.env.AWS_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: (process.env.AWS_SECRET_ACCESS_KEY || '').trim(),
    region: (process.env.AWS_REGION || 'ap-south-1').trim(),
    bucket: (process.env.AWS_S3_BUCKET || 'weighbridge-management-system').trim(),
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

module.exports = {
  isConfigured,
  presignGet,
  presignPut,
  mirrorPhotoKey,
  mirrorReportKey,
  remoteTripPhotoKey,
  getBucket,
};
