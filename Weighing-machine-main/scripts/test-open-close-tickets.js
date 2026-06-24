'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { initDatabase, closeDatabase } = require('../backend/database/db');
const TransactionService = require('../backend/services/TransactionService');
const TripCaptureService = require('../backend/services/TripCaptureService');
const VehicleService = require('../backend/services/VehicleService');
const { TICKET_STATUS } = require('../backend/utils/constants');

process.env.MANUAL_WEIGHMENT = 'true';
process.env.REQUIRE_CAMERA_CAPTURE = 'false';
process.env.REQUIRED_PHOTOS = '1';

function fakePhoto() {
  const filePath = path.join(os.tmpdir(), `wb-test-${Date.now()}-${Math.random()}.jpg`);
  fs.writeFileSync(filePath, Buffer.alloc(3000, 0xff));
  return filePath;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

async function runTicketFieldValidationTests() {
  const tempFiles = [];
  const track = (p) => {
    tempFiles.push(p);
    return p;
  };

  const openPhoto = track(fakePhoto());
  const openResult = await TripCaptureService.openTicketSave({
    weightKg: 1000,
    rawWeightKg: 1000,
    weightOffsetKg: 0,
    imagePath: openPhoto,
    truckNumber: 'TESTOPEN001',
    rfidTag: 'RFID-OPEN',
    material: null,
    driver: null,
    customer_name: null,
    destination: null,
    operator_name: null,
  });
  assert(openResult.pass === 'OPEN', 'Expected OPEN pass');
  assert(openResult.transaction.material == null, 'Material should be null on open');
  assert(openResult.transaction.customer_name == null, 'Customer should be null on open');
  assert(openResult.transaction.destination == null, 'Destination should be null on open');
  assert(openResult.transaction.operator_name == null, 'Operator should be null on open');
  console.log('Open without ticket details:', openResult.transaction.slip_number);

  const openTicket = TransactionService.findOpenTicket('TESTOPEN001', 'RFID-OPEN');
  assert(openTicket, 'Open ticket should exist');

  let closeValidationFailed = false;
  try {
    await TripCaptureService.closeTicket({
      openTicket,
      weightKg: 5000,
      rawWeightKg: 5000,
      weightOffsetKg: 0,
      imagePath: track(fakePhoto()),
      truckNumber: 'TESTOPEN001',
      rfidTag: 'RFID-OPEN',
      material: null,
      customer_name: null,
      destination: null,
      operator_name: null,
    });
  } catch (err) {
    closeValidationFailed = /Material is required before closing the ticket/.test(err.message);
    console.log('Close without details rejected:', err.message);
  }
  assert(closeValidationFailed, 'Close should require material');

  const closePhoto = track(fakePhoto());
  const closeResult = await TripCaptureService.closeTicket({
    openTicket,
    weightKg: 5000,
    rawWeightKg: 5000,
    weightOffsetKg: 0,
    imagePath: closePhoto,
    truckNumber: 'TESTOPEN001',
    rfidTag: 'RFID-OPEN',
    material: 'Coal',
    customer_name: 'MCG',
    destination: 'MEERUT',
    operator_name: 'Operator1',
  });
  assert(closeResult.pass === 'CLOSE', 'Expected CLOSE pass');
  assert(closeResult.transaction.material === 'Coal', 'Material should persist on close');
  assert(closeResult.transaction.customer_name === 'MCG', 'Customer should persist on close');
  assert(closeResult.transaction.destination === 'MEERUT', 'Destination should persist on close');
  assert(closeResult.transaction.operator_name === 'Operator1', 'Operator should persist on close');
  console.log('Close with details:', closeResult.transaction.slip_number);

  for (const filePath of tempFiles) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}

async function runHywaTicketTests() {
  const tempFiles = [];
  const track = (p) => {
    tempFiles.push(p);
    return p;
  };

  try {
    VehicleService.create({
      vehicle_number: 'HYWA001',
      rfid_tag: 'RFID-HYWA',
      owner_name: 'HYWA Owner',
      vehicle_type: 'hywa',
    });
  } catch (err) {
    if (!/already exists/.test(err.message)) throw err;
  }

  const openResult = await TripCaptureService.openTicketSave({
    weightKg: 8000,
    rawWeightKg: 8000,
    weightOffsetKg: 0,
    imagePath: track(fakePhoto()),
    truckNumber: 'HYWA001',
    rfidTag: 'RFID-HYWA',
    vehicleType: 'hywa',
  });
  assert(openResult.pass === 'OPEN', 'HYWA open expected OPEN pass');
  assert(openResult.transaction.gross_weight === 8000, 'HYWA open should set gross_weight');
  assert(openResult.transaction.tare_weight == null, 'HYWA open should not set tare_weight');
  console.log('HYWA open ticket:', openResult.transaction.slip_number);

  const openTicket = TransactionService.findOpenTicket('HYWA001', 'RFID-HYWA');
  assert(openTicket, 'HYWA open ticket should exist');

  const info = TransactionService.getVehicleWeighmentInfo('HYWA001', 'RFID-HYWA');
  assert(info.mode === 'CLOSE', 'HYWA return visit should be CLOSE mode');
  assert(info.isHywa === true, 'Weighment info should flag isHywa');

  const closeResult = await TripCaptureService.closeTicket({
    openTicket,
    weightKg: 3000,
    rawWeightKg: 3000,
    weightOffsetKg: 0,
    imagePath: track(fakePhoto()),
    truckNumber: 'HYWA001',
    rfidTag: 'RFID-HYWA',
    vehicleType: 'hywa',
    material: 'Coal',
    customer_name: 'MCG',
    destination: 'MEERUT',
    operator_name: 'Operator1',
  });
  assert(closeResult.pass === 'CLOSE', 'HYWA close expected CLOSE pass');
  assert(closeResult.transaction.tare_weight === 3000, 'HYWA close should set tare_weight');
  assert(closeResult.transaction.ticket_status === TICKET_STATUS.CLOSED, 'HYWA ticket should close');
  assert(closeResult.transaction.net_weight === 5000, 'HYWA net should be gross - tare');
  console.log('HYWA closed ticket net:', closeResult.transaction.net_weight);

  for (const filePath of tempFiles) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}

initDatabase();

const slipSample = TransactionService.generateSlipNumber();
console.log('Slip format sample:', slipSample);

const createA = TransactionService.create({
  truck_number: 'TESTA001',
  rfid_tag: 'RFID-A',
  tare_weight: 1000,
  status: 'weighing',
  ticket_status: TICKET_STATUS.OPEN,
  material: 'Coal',
  arrival_photo_1: '/fake/1.jpg',
});
console.log('Created A:', createA.transaction.slip_number, createA.transaction.ticket_status);

const openA = TransactionService.findOpenTicket('TESTA001', 'RFID-A');
console.log('Find open A:', openA?.slip_number);

const infoB = TransactionService.getVehicleWeighmentInfo('TESTB002', 'RFID-B');
console.log('Vehicle B mode:', infoB.mode);

TransactionService.create({
  truck_number: 'TESTB002',
  rfid_tag: 'RFID-B',
  tare_weight: 2000,
  ticket_status: TICKET_STATUS.OPEN,
  material: 'Sand',
});

const openList = TransactionService.listOpenTickets();
console.log('Open count (includes demo):', openList.filter((t) => t.truck_number.startsWith('TEST')).length);

const infoReturnA = TransactionService.getVehicleWeighmentInfo('TESTA001', 'RFID-A');
console.log('Return A mode:', infoReturnA.mode, 'ticket:', infoReturnA.openTicket?.slip_number);

TransactionService.cancelTicket(createA.transaction.id);
console.log('Cancelled A');

(async () => {
  try {
    await runTicketFieldValidationTests();
    console.log('Ticket field validation tests passed');
    await runHywaTicketTests();
    console.log('HYWA ticket tests passed');
  } catch (err) {
    console.error('Ticket field validation tests failed:', err.message);
    process.exitCode = 1;
  } finally {
    closeDatabase();
    console.log('Integration test passed');
  }
})();
