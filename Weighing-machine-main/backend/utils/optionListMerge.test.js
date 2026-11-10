'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeOptionListValues, parseOptionListValue } = require('./optionListMerge');

test('parseOptionListValue reads JSON arrays', () => {
  assert.deepEqual(parseOptionListValue('["MEERUT","PALI"]'), ['MEERUT', 'PALI']);
});

test('mergeOptionListValues keeps PC destinations when cloud list is shorter', () => {
  const local = JSON.stringify(['MEERUT', 'GWAL PAHARI', 'BADKHAL']);
  const remote = JSON.stringify(['MUZAFFAR NAGAR']);
  assert.equal(
    mergeOptionListValues(local, remote),
    JSON.stringify(['MEERUT', 'GWAL PAHARI', 'BADKHAL', 'MUZAFFAR NAGAR']),
  );
});

test('mergeOptionListValues adds cloud-only names without dropping local', () => {
  const local = JSON.stringify(['MEERUT']);
  const remote = JSON.stringify(['MEERUT', 'PALI']);
  assert.equal(mergeOptionListValues(local, remote), JSON.stringify(['MEERUT', 'PALI']));
});

test('mergeOptionListValues is case-insensitive for duplicates', () => {
  const local = JSON.stringify(['Meerut']);
  const remote = JSON.stringify(['MEERUT', 'Pali']);
  assert.equal(mergeOptionListValues(local, remote), JSON.stringify(['Meerut', 'Pali']));
});
