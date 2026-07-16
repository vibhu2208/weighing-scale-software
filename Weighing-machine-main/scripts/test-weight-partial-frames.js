'use strict';

/**
 * Unit-style checks for weighbridge partial-frame rejection (no serial port).
 */
const WeightBridgeService = require('../backend/services/WeightBridgeService');

const bridge = new WeightBridgeService({ port: 'COM_TEST' });
let accepted = [];

bridge.onWeightChanged((p) => {
  accepted.push({ weight: p.weight, stable: p.stableWeight, isStable: p.isStable });
});

function feed(chunks) {
  accepted = [];
  bridge.latestWeight = 0;
  bridge.latestStableWeight = 0;
  bridge.latestRawWeight = 0;
  bridge.buffer = [];
  bridge.isStable = false;
  bridge.textBuffer = '';
  bridge.lastEmittedWeight = null;
  bridge.lastEmittedIsStable = false;
  for (const chunk of chunks) {
    bridge._handleData(Buffer.from(chunk, 'utf8'));
  }
  return accepted.map((a) => a.weight);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Full frames with newlines
{
  const weights = feed(['011160\r\n', '011160\r\n', '011160\r\n', '011160\r\n', '011160\r\n']);
  assert(weights.includes(11160), `expected 11160, got ${weights}`);
  assert(!weights.includes(60), `should not accept fragment 60, got ${weights}`);
}

// Interleaved fragments while full weight is present
{
  const weights = feed([
    '011160\r\n',
    '011160\r\n',
    '011160\r\n',
    '011160\r\n',
    '011160\r\n',
    '60\r\n',
    '160\r\n',
    '0111\r\n',
    '011160\r\n',
  ]);
  assert(weights.every((w) => w === 11160 || w === 0), `unexpected weights ${weights}`);
  assert(bridge.latestStableWeight === 11160, `stable should stay 11160, got ${bridge.latestStableWeight}`);
}

// Undelimited stream split across chunks (the real bug)
{
  accepted = [];
  bridge.latestWeight = 0;
  bridge.latestStableWeight = 0;
  bridge.buffer = [];
  bridge.isStable = false;
  bridge.textBuffer = '';
  bridge.lastEmittedWeight = null;
  bridge.lastEmittedIsStable = false;
  bridge._handleData(Buffer.from('0111', 'utf8'));
  bridge._handleData(Buffer.from('60', 'utf8'));
  bridge._handleData(Buffer.from('011160', 'utf8'));
  const weights = accepted.map((a) => a.weight);
  assert(weights.includes(11160), `undelimited should parse 11160, got ${weights}`);
  assert(!weights.includes(60) || bridge.latestWeight === 11160, `should end at 11160, got ${weights}`);
}

// Idle near-zero full frames still accepted
{
  const weights = feed(['-000100\r\n', '-000100\r\n', '-000100\r\n', '-000100\r\n', '-000100\r\n']);
  assert(weights.includes(100), `expected idle 100, got ${weights}`);
}

console.log('WeightBridge partial-frame tests OK');
