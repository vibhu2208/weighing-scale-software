'use strict';

const assert = require('assert');
const { looksLikeCancelPayload } = require('./cancelPayload');

assert.strictEqual(looksLikeCancelPayload({ cancel: true, gross_weight: 0 }), true);
assert.strictEqual(looksLikeCancelPayload({ cancel: 'true', gross_weight: 0 }), true);
assert.strictEqual(looksLikeCancelPayload({ cancel: 1, tare_weight: 0 }), true);
assert.strictEqual(
  looksLikeCancelPayload({ ticket_status: 'CANCELLED', gross_weight: 0, tare_weight: 0 }),
  true,
);
assert.strictEqual(
  looksLikeCancelPayload({ material: 'CANCEL', gross_weight: 0, tare_weight: 0 }),
  true,
);
assert.strictEqual(
  looksLikeCancelPayload({ material: 'Sand', gross_weight: 0, tare_weight: 0 }),
  false,
);
assert.strictEqual(looksLikeCancelPayload({ gross_weight: 12000, tare_weight: 8000 }), false);
assert.strictEqual(looksLikeCancelPayload('{"cancel":true}'), false);
assert.strictEqual(looksLikeCancelPayload(null), false);

console.log('cancelPayload tests passed');
