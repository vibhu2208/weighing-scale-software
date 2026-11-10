'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test-secret-key';
process.env.AWS_REGION = process.env.AWS_REGION || 'eu-north-1';
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || 'k1-k2';

const s3PresignPath = require.resolve('./s3Presign');
delete require.cache[s3PresignPath];
const { getClient, isConfigured, presignGet } = require('./s3Presign');

test('isConfigured is true with test credentials', () => {
  assert.equal(isConfigured(), true);
});

test('getClient returns the same S3Client instance for identical config', () => {
  const a = getClient();
  const b = getClient();
  assert.equal(a, b);
});

test('presignGet still works with the cached client', async () => {
  const url = await presignGet('sites/WB-03/mirror/TEST/report.pdf');
  assert.ok(typeof url === 'string' && url.includes('X-Amz-'));
});
