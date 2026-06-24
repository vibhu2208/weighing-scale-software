'use strict';

const logger = require('../utils/logger');
const ts = require('../utils/timestamp');
const { TRANSACTION_STATUS } = require('../utils/constants');
const VehicleService = require('../services/VehicleService');
const TransactionService = require('../services/TransactionService');
const PrintService = require('../services/PrintService');
const DeviceMonitorService = require('../services/DeviceMonitorService');
const SyncQueue = require('./SyncQueue');
const RfidTagSelector = require('../services/RfidTagSelector');

const STATES = Object.freeze({
  IDLE: 'IDLE',
  RFID_DETECTED: 'RFID_DETECTED',
  VEHICLE_IDENTIFIED: 'VEHICLE_IDENTIFIED',
  AWAITING_WEIGHT: 'AWAITING_WEIGHT',
  WEIGHT_STABLE: 'WEIGHT_STABLE',
  IMAGE_CAPTURING: 'IMAGE_CAPTURING',
  TRANSACTION_COMPLETE: 'TRANSACTION_COMPLETE',
  PRINTING: 'PRINTING',
  SYNC_QUEUED: 'SYNC_QUEUED',
  ERROR: 'ERROR',
});

const MIN_WEIGHT_KG =
  parseInt(process.env.MIN_WEIGHT_KG || '1000', 10) || 1000;
const WEIGHMENT_TIMEOUT_MS = 5 * 60 * 1000;

/** Manual Save only — stable weight never auto-captures to DB. */
function useManualWeighment() {
  return true;
}
const ZERO_IGNORE_MS = 5000;
const ERROR_RESET_MS = 3000;
const IMAGE_CAPTURE_TIMEOUT_MS = 15000;

let getMainWindow = () => null;
let initialized = false;

const engine = {
  state: STATES.IDLE,
  context: {},
  weightLocked: false,
  isProcessingWeight: false,
  awaitingWeightSince: null,
  weighmentTimeout: null,
  errorResetTimeout: null,
  imageCaptureTimeout: null,
  printRetried: false,
};

function emit(event, payload = {}) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(event, payload);
  }
  logger.debug(`workflow emit ${event}`, payload);
}

function transition(to) {
  const from = engine.state;
  if (from === to) return;
  engine.state = to;
  emit('workflow:stateChange', { from, to, timestamp: ts.now() });
  logger.info('Workflow transition', { from, to });
}

function clearTimers() {
  if (engine.weighmentTimeout) {
    clearTimeout(engine.weighmentTimeout);
    engine.weighmentTimeout = null;
  }
  if (engine.errorResetTimeout) {
    clearTimeout(engine.errorResetTimeout);
    engine.errorResetTimeout = null;
  }
  if (engine.imageCaptureTimeout) {
    clearTimeout(engine.imageCaptureTimeout);
    engine.imageCaptureTimeout = null;
  }
}

function resetToIdle(options = {}) {
  const { releaseSelectorLock = false, clearRfid = false } = options;
  clearTimers();
  engine.context = {};
  engine.weightLocked = false;
  engine.isProcessingWeight = false;
  engine.awaitingWeightSince = null;
  engine.printRetried = false;
  if (releaseSelectorLock) {
    RfidTagSelector.unlock();
  }
  transition(STATES.IDLE);
  emit('workflow:reset', { clearRfid });
}

function goError(error, extra = {}) {
  const message = error && error.message ? error.message : String(error);
  logger.logDevice('workflow', 'error', message, extra);
  transition(STATES.ERROR);
  emit('workflow:error', {
    error: message,
    state: STATES.ERROR,
    transactionId: engine.context.transaction?.id || null,
    ...extra,
  });
  clearTimers();
  engine.errorResetTimeout = setTimeout(() => {
    engine.errorResetTimeout = null;
    resetToIdle();
  }, ERROR_RESET_MS);
  if (engine.errorResetTimeout.unref) engine.errorResetTimeout.unref();
}

function isActiveWeighment() {
  return [
    STATES.AWAITING_WEIGHT,
    STATES.WEIGHT_STABLE,
    STATES.IMAGE_CAPTURING,
    STATES.TRANSACTION_COMPLETE,
    STATES.PRINTING,
    STATES.SYNC_QUEUED,
  ].includes(engine.state);
}

function startWeighmentTimeout() {
  if (engine.weighmentTimeout) clearTimeout(engine.weighmentTimeout);
  engine.weighmentTimeout = setTimeout(() => {
    if (engine.state !== STATES.AWAITING_WEIGHT || engine.isProcessingWeight) {
      return;
    }
    const txnId = engine.context.transaction?.id;
    emit('workflow:weighmentTimeout', { transactionId: txnId });
    goError(new Error('Weighment timeout after 5 minutes'), {
      transactionId: txnId,
    });
  }, WEIGHMENT_TIMEOUT_MS);
  if (engine.weighmentTimeout.unref) engine.weighmentTimeout.unref();
}

function beginAwaitingWeight(transaction, vehicle, pass) {
  engine.context.transaction = transaction;
  engine.context.vehicle = vehicle;
  engine.context.truckNumber = transaction.truck_number;
  engine.context.rfidTag = transaction.rfid_tag;
  engine.context.pass = pass;
  engine.weightLocked = false;
  engine.awaitingWeightSince = Date.now();

  TransactionService.updateStatus(transaction.id, TRANSACTION_STATUS.WEIGHING);
  transition(STATES.AWAITING_WEIGHT);
  startWeighmentTimeout();
}

/** First RFID — empty truck: open slip and capture tare. */
async function startTarePass(truckNumber, rfidTag, vehicle) {
  transition(STATES.VEHICLE_IDENTIFIED);
  engine.context.vehicle = vehicle;
  engine.context.truckNumber = truckNumber;
  engine.context.rfidTag = rfidTag;
  engine.context.pass = 'TARE';

  const result = TransactionService.create({
    truck_number: truckNumber,
    rfid_tag: rfidTag,
    status: TRANSACTION_STATUS.PENDING,
    timestamp_in: ts.now(),
  });

  if (result.isDuplicate) {
    const existing = result.transaction || TransactionService.getById(result.existingId);
    if (existing) {
      if (existing.ticket_status === 'OPEN' && existing.tare_weight == null) {
        return resumeTarePass(existing, vehicle);
      }
      if (existing.ticket_status === 'OPEN' && existing.tare_weight != null) {
        return startGrossPass(existing, vehicle);
      }
    }
    emit('workflow:duplicateTransaction', { existingId: result.existingId });
    return;
  }

  beginAwaitingWeight(result.transaction, vehicle, 'TARE');

  emit('workflow:transactionStarted', {
    transaction: result.transaction,
    vehicle: vehicle || null,
    pass: 'TARE',
    message: 'Empty truck — capture tare weight',
  });
}

/** Resume open slip — tare not yet captured. */
async function resumeTarePass(openTxn, vehicle) {
  transition(STATES.VEHICLE_IDENTIFIED);
  beginAwaitingWeight(openTxn, vehicle, 'TARE');

  emit('workflow:transactionResumed', {
    transaction: openTxn,
    vehicle: vehicle || null,
    pass: 'TARE',
    message: 'Resume — capture tare weight (empty truck)',
  });
}

/** Second RFID — loaded truck: complete open slip with gross. */
async function startGrossPass(openTxn, vehicle) {
  transition(STATES.VEHICLE_IDENTIFIED);
  beginAwaitingWeight(openTxn, vehicle, 'GROSS');

  emit('workflow:transactionResumed', {
    transaction: openTxn,
    vehicle: vehicle || null,
    pass: 'GROSS',
    message: 'Loaded truck — capture gross weight',
  });
}

async function proceedFromVehicle(truckNumber, rfidTag, vehicle) {
  const open = TransactionService.findOpenTicket(truckNumber, rfidTag);

  if (open) {
    if (open.ticket_status === 'OPEN' && open.tare_weight != null) {
      return startGrossPass(open, vehicle);
    }
    if (open.tare_weight == null) {
      return resumeTarePass(open, vehicle);
    }
    emit('workflow:duplicateTransaction', {
      existingId: open.id,
      message: 'Open ticket already exists for this vehicle',
    });
    return;
  }

  return startTarePass(truckNumber, rfidTag, vehicle);
}

async function handleStableWeight(payload) {
  if (useManualWeighment()) return;
  if (engine.weightLocked) return;
  if (engine.state !== STATES.AWAITING_WEIGHT) return;

  const weight = Number(payload.weight);
  if (Number.isNaN(weight)) return;

  engine.isProcessingWeight = true;
  if (engine.weighmentTimeout) {
    clearTimeout(engine.weighmentTimeout);
    engine.weighmentTimeout = null;
  }

  if (weight <= MIN_WEIGHT_KG) {
    engine.isProcessingWeight = false;
    emit('workflow:weightBelowThreshold', {
      weight,
      threshold: MIN_WEIGHT_KG,
      transactionId: engine.context.transaction?.id,
    });
    startWeighmentTimeout();
    return;
  }

  engine.weightLocked = true;
  engine.context.lockedWeight = weight;
  transition(STATES.WEIGHT_STABLE);

  const txnId = engine.context.transaction.id;
  const pass = engine.context.pass || 'GROSS';

  if (pass === 'TARE') {
    TransactionService.updateFields(txnId, { tare_weight: weight });
  } else {
    TransactionService.updateFields(txnId, {
      gross_weight: weight,
      timestamp_out: ts.now(),
    });
  }
  engine.context.transaction = TransactionService.getById(txnId);

  emit('workflow:weightUpdate', {
    weight,
    isStable: true,
    transactionId: txnId,
    pass,
  });

  transition(STATES.IMAGE_CAPTURING);
  await captureImage(txnId, pass);
}

async function captureImage(txnId, pass) {
  const { resolveTripCaptures, mergeCameraSnapshots } = require('../services/TripCaptureService');

  const finishCapture = async (captureResult) => {
    if (engine.imageCaptureTimeout) {
      clearTimeout(engine.imageCaptureTimeout);
      engine.imageCaptureTimeout = null;
    }

    const imagePath = captureResult?.primaryPath || null;
    const snapshots = captureResult?.snapshots || [];
    const passKey = pass === 'TARE' ? 'tare' : 'gross';
    const existing = TransactionService.getById(txnId);

    const imageFields =
      pass === 'TARE'
        ? { tare_image_path: imagePath, image_path: imagePath }
        : { image_path: imagePath };

    if (snapshots.length) {
      imageFields.camera_snapshots = mergeCameraSnapshots(
        existing?.camera_snapshots,
        passKey,
        snapshots,
      );
    }

    TransactionService.updateFields(txnId, imageFields);
    engine.context.transaction = TransactionService.getById(txnId);

    if (!imagePath) {
      emit('workflow:imageMissing', { transactionId: txnId, pass });
    } else {
      emit('workflow:imageCaptured', { imagePath, transactionId: txnId, pass });
    }

    if (pass === 'TARE') {
      await completeTarePass(txnId);
    } else {
      await completeTransaction();
    }
  };

  engine.imageCaptureTimeout = setTimeout(() => {
    logger.warn('Camera capture timeout — continuing without image');
    finishCapture(null).catch((e) => goError(e));
  }, IMAGE_CAPTURE_TIMEOUT_MS);

  try {
    const captureResult = await resolveTripCaptures({ transactionId: txnId });
    await finishCapture(captureResult);
  } catch (err) {
    logger.warn('Camera capture failed — continuing', { message: err.message });
    await finishCapture(null);
  }
}

/** Tare pass done — ticket stays open until same RFID returns loaded. */
async function completeTarePass(txnId) {
  const txn = TransactionService.getById(txnId);
  transition(STATES.TRANSACTION_COMPLETE);

  engine.context.transaction = TransactionService.updateStatus(
    txnId,
    TRANSACTION_STATUS.WEIGHING,
  );

  emit('workflow:tareComplete', {
    transaction: engine.context.transaction,
    message: 'Tare recorded — send truck to load, scan RFID again when loaded',
  });

  engine.isProcessingWeight = false;
  RfidTagSelector.unlock();
  resetToIdle({ releaseSelectorLock: false });
}

async function completeTransaction() {
  const txnId = engine.context.transaction.id;
  transition(STATES.TRANSACTION_COMPLETE);

  engine.context.transaction = TransactionService.updateStatus(
    txnId,
    TRANSACTION_STATUS.CAPTURED,
  );

  transition(STATES.PRINTING);
  await runPrint(txnId);
}

async function runPrint(txnId, isRetry = false) {
  try {
    const txn = TransactionService.getById(txnId);
    const result = await PrintService.generateSlip(txn);
    if (result.pdfPending) {
      logger.warn('Slip PDF pending — queued for reprint', { transactionId: txnId });
    }
    engine.context.transaction = TransactionService.updateStatus(
      txnId,
      TRANSACTION_STATUS.PRINTED,
    );
  } catch (err) {
    logger.error('Print failed', { message: err.message, txnId });
    emit('workflow:printFailed', { transactionId: txnId, error: err.message });

    if (!isRetry && !engine.printRetried) {
      engine.printRetried = true;
      await new Promise((r) => setTimeout(r, 5000));
      return runPrint(txnId, true);
    }
  }

  transition(STATES.SYNC_QUEUED);
  SyncQueue.enqueue(txnId);

  const finalTxn = TransactionService.getById(txnId);
  emit('workflow:complete', { transaction: finalTxn });

  engine.isProcessingWeight = false;
  RfidTagSelector.unlock();
  resetToIdle({ clearRfid: true });
}

const WorkflowEngine = {
  STATES,

  init(windowGetter) {
    if (initialized) return;
    getMainWindow = windowGetter || (() => null);
    initialized = true;
    WorkflowEngine.checkOrphanedTransactions();
    logger.info('WorkflowEngine initialized');
  },

  bindDeviceEvents() {
    logger.debug('WorkflowEngine device hooks registered via DeviceMonitorService');
  },

  onWeightUpdate(payload) {
    if (engine.weightLocked) return;
    if (engine.state === STATES.AWAITING_WEIGHT) {
      emit('workflow:weightUpdate', {
        weight: payload.weight,
        isStable: payload.isStable,
        transactionId: engine.context.transaction?.id,
      });
    }
  },

  onStableWeight(payload) {
    if (useManualWeighment()) return;
    handleStableWeight(payload).catch((err) => goError(err));
  },

  useManualWeighment,

  onWeightZero() {
    if (engine.state !== STATES.AWAITING_WEIGHT) return;
    const elapsed = Date.now() - (engine.awaitingWeightSince || Date.now());
    if (elapsed < ZERO_IGNORE_MS) return;
    logger.debug('Weight zero detected on bridge');
  },

  getCurrentState() {
    return {
      state: engine.state,
      context: {
        rfidTag: engine.context.rfidTag,
        truckNumber: engine.context.truckNumber,
        transactionId: engine.context.transaction?.id,
        lockedWeight: engine.context.lockedWeight,
        pass: engine.context.pass,
      },
      minWeightKg: MIN_WEIGHT_KG,
    };
  },

  handleRfidTag(payload) {
    const tag = payload?.tag || payload?.tagId;
    if (!tag) return;

    const RfidBlocklistService = require('../services/RfidBlocklistService');
    if (RfidBlocklistService.logIfBlocked(tag, 'workflow')) return;

    try {
      const WeightReleaseService = require('../services/WeightReleaseService');
      WeightReleaseService.clear();
      const WeightAdjustmentService = require('../services/WeightAdjustmentService');
      if (typeof WeightAdjustmentService.clearLiveRamp === 'function') {
        WeightAdjustmentService.clearLiveRamp();
      }
    } catch (_e) {
      /* optional */
    }

    if (engine.state === STATES.ERROR) {
      resetToIdle();
    } else if (!useManualWeighment() && isActiveWeighment()) {
      logger.warn('RFID ignored — weighment in progress on bridge', {
        tag,
        state: engine.state,
      });
      return;
    } else if (
      !useManualWeighment() &&
      engine.state !== STATES.IDLE &&
      engine.state !== STATES.RFID_DETECTED
    ) {
      logger.warn('RFID ignored — engine busy', { tag, state: engine.state });
      return;
    }

    if (
      RfidTagSelector.isLocked() &&
      tag !== RfidTagSelector.getLockedTag()
    ) {
      logger.debug('RFID ignored — different tag while locked', {
        tag,
        lockedTag: RfidTagSelector.getLockedTag(),
      });
      return;
    }

    if (
      engine.state === STATES.RFID_DETECTED &&
      engine.context.rfidTag === tag
    ) {
      return;
    }

    if (!RfidTagSelector.isLocked()) {
      RfidTagSelector.lock(tag, payload);
    }
    transition(STATES.RFID_DETECTED);
    engine.context.rfidTag = tag;

    const vehicle = VehicleService.findByRFID(tag);
    if (!vehicle) {
      logger.warn('Unknown RFID tag — operator intervention required', { tag });
      emit('workflow:unknownRFID', { tag });
      return;
    }

    if (useManualWeighment()) {
      engine.context.truckNumber = vehicle.vehicle_number;
      engine.context.vehicle = vehicle;
      emit('workflow:rfidReady', {
        tag,
        vehicle,
        truckNumber: vehicle.vehicle_number,
        message: 'Tag locked — press Save when the weight on the display is correct',
      });
      return;
    }

    proceedFromVehicle(vehicle.vehicle_number, tag, vehicle).catch((err) =>
      goError(err),
    );
  },

  acceptManualEntry(truckNumber) {
    const normalized = String(truckNumber || '')
      .trim()
      .toUpperCase();
    if (!normalized) throw new Error('truck_number is required');

    if (
      engine.state !== STATES.RFID_DETECTED &&
      engine.state !== STATES.IDLE
    ) {
      throw new Error(`Cannot accept manual entry in state ${engine.state}`);
    }

    const vehicle = VehicleService.findByNumber(normalized);
    const rfidTag =
      vehicle?.rfid_tag || engine.context.rfidTag || null;

    engine.context.truckNumber = normalized;
    engine.context.vehicle = vehicle;
    engine.context.rfidTag = rfidTag;

    if (vehicle && rfidTag) {
      if (RfidTagSelector.isLocked()) {
        RfidTagSelector.unlock();
      }
      RfidTagSelector.lock(rfidTag, { tag: rfidTag, source: 'manual' });
    }

    if (useManualWeighment()) {
      transition(STATES.RFID_DETECTED);
      emit('workflow:rfidReady', {
        tag: rfidTag,
        vehicle,
        truckNumber: normalized,
        manualEntry: true,
        message: vehicle
          ? rfidTag
            ? 'Vehicle found — RFID loaded from database. Press Save when weight is correct.'
            : 'Vehicle found — press Save when the weight on the display is correct'
          : 'Truck entered manually — press Save when the weight on the display is correct',
      });
      return;
    }

    proceedFromVehicle(normalized, rfidTag, vehicle).catch((err) =>
      goError(err),
    );
  },

  manualRfid(tag) {
    RfidTagSelector.unlock();
    WorkflowEngine.handleRfidTag({ tag });
  },

  unlockRfid() {
    RfidTagSelector.unlock();
  },

  /** Clear operator session without cancelling tickets (save complete or scan cancelled). */
  clearSessionAfterSave() {
    RfidTagSelector.unlock();
    try {
      const DeviceMonitorService = require('../services/DeviceMonitorService');
      if (typeof DeviceMonitorService.stopRfidScan === 'function') {
        DeviceMonitorService.stopRfidScan();
      }
    } catch (_e) {
      /* optional */
    }
    resetToIdle({ clearRfid: true });
  },

  abort() {
    logger.info('Workflow aborted by operator');
    try {
      const WeightReleaseService = require('../services/WeightReleaseService');
      WeightReleaseService.clear();
      const WeightAdjustmentService = require('../services/WeightAdjustmentService');
      if (typeof WeightAdjustmentService.clearLiveRamp === 'function') {
        WeightAdjustmentService.clearLiveRamp();
      }
    } catch (_e) {
      /* optional */
    }
    const txnId = engine.context.transaction?.id;
    if (txnId) {
      const txn = TransactionService.getById(txnId);
      if (txn?.ticket_status === 'OPEN') {
        try {
          TransactionService.cancelTicket(txnId);
        } catch (err) {
          logger.warn('abort cancelTicket failed', { message: err.message });
        }
      } else {
        TransactionService.updateFields(txnId, {
          status: TRANSACTION_STATUS.CANCELLED,
          notes: 'Aborted by operator',
        });
      }
    }
    RfidTagSelector.unlock();
    try {
      const DeviceMonitorService = require('../services/DeviceMonitorService');
      if (typeof DeviceMonitorService.stopRfidScan === 'function') {
        DeviceMonitorService.stopRfidScan();
      }
    } catch (_e) {
      /* ignore */
    }
    resetToIdle({ clearRfid: true });
  },

  async retryPrint(transactionId) {
    return PrintService.retryPrint(transactionId);
  },

  checkOrphanedTransactions() {
    const orphaned = TransactionService.getOrphanedCaptured();
    if (orphaned.length > 0) {
      emit('workflow:orphanedTransactions', { transactions: orphaned });
      logger.warn('Orphaned captured transactions found', {
        count: orphaned.length,
      });
    }
  },
};

module.exports = WorkflowEngine;
