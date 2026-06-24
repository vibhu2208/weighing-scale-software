'use strict';

/**
 * Standalone MCG Portal API test — posts payload with all string fields "TESTING".
 *
 * Usage:
 *   MCG_PORTAL_ENABLED=true MCG_PORTAL_API_KEY=<key> node scripts/test-mcg-portal-api.js
 *
 * Optional:
 *   MCG_PORTAL_URL=https://sms-be.austere.biz/weightbridge
 */

const McgPortalService = require('../backend/services/McgPortalService');

process.env.MCG_PORTAL_ENABLED = process.env.MCG_PORTAL_ENABLED || 'true';
process.env.MCG_PORTAL_TEST_MODE = process.env.MCG_PORTAL_TEST_MODE || 'true';

if (!process.env.MCG_PORTAL_API_KEY) {
  console.error('Set MCG_PORTAL_API_KEY before running this script.');
  process.exit(1);
}

async function main() {
  const payload = { input: McgPortalService.buildTestInput() };
  console.log('POST payload:', JSON.stringify(payload, null, 2));

  const result = await McgPortalService.testPost();
  console.log('Result:', JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
