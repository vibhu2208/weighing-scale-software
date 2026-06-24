'use strict';

const fs = require('fs');
const TransactionService = require('./TransactionService');
const VehicleService = require('./VehicleService');
const RfidTagSelector = require('./RfidTagSelector');
const CameraCaptureService = require('./CameraCaptureService');
const { saveImage } = require('../utils/fileStorage');
const { TICKET_STATUS, TRANSACTION_STATUS } = require('../utils/constants');
const { photoColumnFields } = require('../utils/tripPhotos');
const {
  isCameraRequired,
  getRequiredPhotoCount,
  getMinPhotoCountToSave,
  useOnDemandCameraPreview,
  useManualPhotoConfirm,
} = require('../utils/cameraCaptureConfig');
const ManualPhotoCaptureService = require('./ManualPhotoCaptureService');
const ts = require('../utils/timestamp');
const { normalizePath } = require('../utils/fileStorage');
const logger = require('../utils/logger');
const {
  isHywa,
  resolveAdjustmentPass,
  openTicketHasFirstWeigh,
  resolveVehicleType,
} = require('../utils/vehicleTypes');

const MIN_JPEG_BYTES = parseInt(process.env.CAMERA_MIN_JPEG_BYTES || '2048', 10);

function verifyPhotoFields(fields, kind) {
  const minCount = getMinPhotoCountToSave();
  const configured = getRequiredPhotoCount();
  const prefix = kind === 'departure' ? 'departure' : 'arrival';
  let validCount = 0;

  for (let slot = 1; slot <= configured; slot += 1) {
    const path = fields[`${prefix}_photo_${slot}`];
    if (!path) continue;
    const resolved = normalizePath(path);
    if (!resolved || !fs.existsSync(resolved)) {
      throw new Error(`Photo file missing on disk for Camera ${slot}`);
    }
    const size = fs.statSync(resolved).size;
    if (size < MIN_JPEG_BYTES) {
      throw new Error(`Photo file too small for Camera ${slot} (${size} bytes)`);
    }
    validCount += 1;
  }

  if (validCount < minCount) {
    throw new Error(
      `At least ${minCount} ${kind} photo(s) required — only ${validCount} valid on disk.`,
    );
  }
}

function parseImageBase64(imageBase64) {
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    throw new Error('Camera image is required');
  }
  const match = imageBase64.match(/^data:image\/\w+;base64,(.+)$/);
  const raw = match ? match[1] : imageBase64;
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) {
    throw new Error('Invalid camera image data');
  }
  return buffer;
}

function parseCameraSnapshots(raw) {
  if (!raw) return { tare: [], gross: [] };
  if (typeof raw === 'object') {
    return { tare: raw.tare || [], gross: raw.gross || [] };
  }
  try {
    const parsed = JSON.parse(raw);
    return { tare: parsed.tare || [], gross: parsed.gross || [] };
  } catch {
    return { tare: [], gross: [] };
  }
}

function mergeCameraSnapshots(existing, passKey, newSnapshots) {
  const data = parseCameraSnapshots(existing);
  data[passKey] = newSnapshots;
  return JSON.stringify(data);
}

function pickPrimaryPath(snapshots) {
  if (!snapshots?.length) return null;
  return (
    snapshots.find((s) => s.id === 'webcam')?.path ||
    snapshots.find((s) => s.id === 'uploaded')?.path ||
    snapshots[0].path
  );
}

function assertCamerasReadyForSave() {
  if (!isCameraRequired()) return;
  if (useOnDemandCameraPreview()) return;

  const DeviceMonitorService = require('./DeviceMonitorService');
  const MultiCameraPreviewService = require('./MultiCameraPreviewService');
  const cameraConfig = DeviceMonitorService.getCameraConfig();
  const cameras = MultiCameraPreviewService.getCamerasFromConfig(cameraConfig);
  if (!cameras.length) return;

  const status = MultiCameraPreviewService.getPreviewStatus({
    requiredCount: getRequiredPhotoCount(),
    config: cameraConfig,
  });

  if (!status.previewStarted) {
    throw new Error('Camera preview is not running — wait for live feeds before saving.');
  }

  const blocked = status.cameras.slice(0, getRequiredPhotoCount()).filter((cam) => !cam.usable);
  if (!blocked.length) return;

  const blankOnes = blocked.filter((cam) => cam.blank).map((cam) => cam.label);
  if (blankOnes.length) {
    throw new Error(
      `Camera feed is blank (${blankOnes.join(', ')}) — wait for a clear image before saving.`,
    );
  }

  const waitingOnes = blocked.map((cam) => cam.label);
  throw new Error(
    `Camera not ready (${waitingOnes.join(', ')}) — wait for LIVE feed before saving.`,
  );
}

function mapPhotoPaths(snapshots, prefix) {
  const kind = prefix === 'departure' ? 'departure' : 'arrival';
  const fields = photoColumnFields(snapshots, kind);
  const configured = getRequiredPhotoCount();
  const colPrefix = kind === 'departure' ? 'departure' : 'arrival';
  const missing = [];

  for (let slot = 1; slot <= configured; slot += 1) {
    if (!fields[`${colPrefix}_photo_${slot}`]) {
      missing.push(`Camera ${slot}`);
    }
  }

  if (missing.length) {
    const captured = (snapshots || []).filter((s) => s?.path).length;
    logger.warn(`Partial ${prefix} photos — missing ${missing.join(', ')}`, {
      captured,
      missing,
    });
  }

  return fields;
}

/**
 * Capture all configured cameras; merge with optional webcam/upload image.
 * @returns {Promise<{ primaryPath: string|null, snapshots: Array }>}
 */
async function resolveTripCaptures({ imageBase64, imagePath, transactionId, passKey = 'capture' }) {
  const snapshots = [];

  if (imagePath && typeof imagePath === 'string') {
    snapshots.push({ id: 'uploaded', label: 'Capture', path: imagePath });
  } else if (imageBase64) {
    const imageBuffer = parseImageBase64(imageBase64);
    const savedPath = saveImage(imageBuffer, transactionId, passKey);
    snapshots.push({ id: 'webcam', label: 'Webcam', path: savedPath });
  }

  const { snapshots: rtspSnapshots, failures: rtspFailures } =
    await CameraCaptureService.captureAllSnapshots(transactionId, passKey);
  if (rtspFailures?.length) {
    logger.warn('Some cameras failed during trip capture', {
      transactionId,
      passKey,
      failed: rtspFailures.map((f) => f.label),
    });
  }
  for (const snap of rtspSnapshots) {
    if (!snapshots.some((s) => s.path === snap.path)) {
      snapshots.push(snap);
    }
  }

  const minCount = getMinPhotoCountToSave();
  if (!snapshots.length) {
    try {
      const DeviceMonitorService = require('./DeviceMonitorService');
      const { camera } = DeviceMonitorService.getAdapters();
      if (camera && typeof camera.captureImage === 'function') {
        if (!camera.isConnected() && typeof camera.connect === 'function') {
          await camera.connect();
        }
        const legacyPath = await camera.captureImage(transactionId);
        if (legacyPath) {
          const fs = require('fs');
          const buffer = fs.readFileSync(legacyPath);
          const savedPath = saveImage(buffer, transactionId, passKey);
          snapshots.push({ id: 'cam-primary', label: 'Camera', path: savedPath });
        }
      }
    } catch (err) {
      logger.warn('Fallback camera capture failed', { message: err.message });
    }
  }

  if (!snapshots.length && (imageBase64 || imagePath)) {
    throw new Error('Camera image is required');
  }

  if (isCameraRequired() && snapshots.length < minCount) {
    throw new Error(
      `At least ${minCount} camera photo(s) required — captured ${snapshots.length}. Check camera network and retry.`,
    );
  }

  return {
    primaryPath: pickPrimaryPath(snapshots),
    snapshots,
  };
}

function resolveConfirmedSnapshots({ confirmedSnapshots, transactionId, passKey }) {
  const finalized = ManualPhotoCaptureService.finalizeSnapshotsForTransaction(
    confirmedSnapshots,
    transactionId,
    passKey,
  );
  return {
    primaryPath: pickPrimaryPath(finalized),
    snapshots: finalized,
  };
}

async function resolveCapturesForSave({
  imageBase64,
  imagePath,
  transactionId,
  passKey,
  confirmedSnapshots,
}) {
  if (confirmedSnapshots?.length) {
    return resolveConfirmedSnapshots({ confirmedSnapshots, transactionId, passKey });
  }
  return resolveTripCaptures({ imageBase64, imagePath, transactionId, passKey });
}

/**
 * Open/Close ticket save:
 * - No OPEN ticket → open ticket (tare + arrival photos)
 * - OPEN ticket exists → close ticket (gross + departure photos + report)
 */
async function saveTripCapture(data = {}) {
  let truckNumber = String(data.truckNumber || '').trim().toUpperCase();

  let openTicket = null;
  if (data.openTicketId) {
    openTicket = TransactionService.findOpenTicketById(data.openTicketId);
    if (!openTicket) {
      throw new Error('Selected open ticket was not found or is no longer open');
    }
    const ticketTruck = String(openTicket.truck_number || '').trim().toUpperCase();
    if (!truckNumber) {
      truckNumber = ticketTruck;
    } else if (ticketTruck && truckNumber !== ticketTruck) {
      throw new Error(
        `Selected ticket ${openTicket.slip_number} belongs to ${ticketTruck}, not ${truckNumber}`,
      );
    } else {
      truckNumber = ticketTruck;
    }
  }

  if (!truckNumber) {
    throw new Error('Scan an RFID tag, select an open ticket, or enter a truck number before saving');
  }

  let rfidTag = data.rfidTag ? String(data.rfidTag).trim().toUpperCase() : null;
  if (!rfidTag) {
    const vehicle = VehicleService.findByNumber(truckNumber);
    if (vehicle?.rfid_tag) {
      rfidTag = String(vehicle.rfid_tag).trim().toUpperCase();
    }
  }
  if (!openTicket) {
    openTicket = TransactionService.findOpenTicket(truckNumber, rfidTag);
  }

  const DeviceMonitorService = require('./DeviceMonitorService');
  const WeightAdjustmentService = require('./WeightAdjustmentService');

  const vehicle = VehicleService.findByNumber(truckNumber);
  const vehicleType = resolveVehicleType(vehicle, openTicket);
  const isClose = !!openTicket;
  const pass = resolveAdjustmentPass({ vehicleType, isClose });
  let rawKg = DeviceMonitorService.getCurrentRawWeight();
  if (!Number.isFinite(rawKg) || rawKg <= 0) {
    rawKg = Math.round(Number(data.weightKg));
  }

  const WeightReleaseService = require('./WeightReleaseService');
  if (!openTicket) {
    WeightReleaseService.clear();
  }

  const split = WeightAdjustmentService.split(rawKg, { pass });
  const weightKg = split.adjustedKg;

  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    throw new Error('Valid weight is required');
  }

  assertCamerasReadyForSave();

  const manualPhoto = useManualPhotoConfirm();
  if (
    manualPhoto &&
    isCameraRequired() &&
    !data.imageBase64 &&
    !data.imagePath &&
    !(data.confirmedSnapshots?.length)
  ) {
    throw new Error(
      'Press Capture images, review photos, then Save. Use Retry if a photo looks grey or distorted.',
    );
  }

  try {
    if (typeof DeviceMonitorService.stopRfidScan === 'function') {
      await DeviceMonitorService.stopRfidScan();
    }
  } catch (err) {
    logger.warn('stopRfidScan after save failed', { message: err.message });
  }

  let result;
  if (openTicket) {
    result = await closeTicket({
      openTicket,
      weightKg,
      rawWeightKg: split.rawKg,
      weightOffsetKg: split.offsetKg,
      imageBase64: data.imageBase64,
      imagePath: data.imagePath || null,
      confirmedSnapshots: data.confirmedSnapshots || null,
      truckNumber,
      rfidTag,
      vehicleType,
      material: data.material,
      customer_name: data.customer_name,
      destination: data.destination,
      operator_name: data.operator_name,
    });
  } else {
    result = await openTicketSave({
      weightKg,
      rawWeightKg: split.rawKg,
      weightOffsetKg: split.offsetKg,
      imageBase64: data.imageBase64,
      imagePath: data.imagePath || null,
      confirmedSnapshots: data.confirmedSnapshots || null,
      truckNumber,
      rfidTag,
      vehicleType,
      material: data.material || null,
      driver: data.driver || null,
      customer_name: data.customer_name || null,
      destination: data.destination || null,
      operator_name: data.operator_name || null,
      operatorId: data.operatorId || null,
    });
  }

  try {
    if (typeof DeviceMonitorService.invalidateStatusCountCache === 'function') {
      DeviceMonitorService.invalidateStatusCountCache();
    }
  } catch (_e) {
    /* ignore */
  }

  try {
    const WorkflowEngine = require('../engine/WorkflowEngine');
    if (typeof WorkflowEngine.clearSessionAfterSave === 'function') {
      WorkflowEngine.clearSessionAfterSave();
    }
  } catch (_e) {
    /* optional */
  }

  const offsetOnClose = openTicket && split.offsetKg > 0;
  const offsetOnHywaOpen = !openTicket && isHywa(vehicleType) && split.offsetKg > 0;
  if (offsetOnClose || offsetOnHywaOpen) {
    WeightReleaseService.activate({
      peakRawKg: split.rawKg,
      offsetKg: split.offsetKg,
    });
    try {
      if (typeof DeviceMonitorService.broadcastLiveWeight === 'function') {
        DeviceMonitorService.broadcastLiveWeight();
      }
    } catch (_e) {
      /* optional */
    }
  }

  return result;
}

async function openTicketSave({
  weightKg,
  rawWeightKg,
  weightOffsetKg,
  imageBase64,
  imagePath,
  confirmedSnapshots,
  truckNumber,
  rfidTag,
  vehicleType: vehicleTypeIn,
  material,
  driver,
  customer_name,
  destination,
  operator_name,
  operatorId,
}) {
  const vehicle = VehicleService.findByNumber(truckNumber);
  const vehicleType = vehicleTypeIn || vehicle?.vehicle_type || null;
  const hywa = isHywa(vehicleType);
  const existingOpen = TransactionService.findOpenTicket(truckNumber, rfidTag);
  if (existingOpen) {
    throw new Error(
      `Open ticket ${existingOpen.slip_number} already exists for this vehicle`,
    );
  }

  const createResult = TransactionService.create({
    truck_number: truckNumber,
    rfid_tag: rfidTag,
    status: TRANSACTION_STATUS.PENDING,
    ticket_status: TICKET_STATUS.OPEN,
    timestamp_in: ts.now(),
    material: material || null,
    driver: driver || null,
    customer_name: customer_name || null,
    destination: destination || null,
    operator_name: operator_name || null,
    operator_id: operatorId || null,
  });

  if (createResult.isDuplicate) {
    throw new Error(
      `Open ticket ${createResult.transaction.slip_number} already exists for this vehicle`,
    );
  }

  const txnId = createResult.transaction.id;
  const { primaryPath, snapshots } = await resolveCapturesForSave({
    imageBase64,
    imagePath,
    confirmedSnapshots,
    transactionId: txnId,
    passKey: 'arrival',
  });

  if (!primaryPath && isCameraRequired()) {
    throw new Error('Could not capture images from any camera');
  }

  const arrivalPhotos = mapPhotoPaths(snapshots, 'arrival');
  verifyPhotoFields(arrivalPhotos, 'arrival');
  const capturedAt = ts.now();

  const weightFields = hywa
    ? {
        gross_weight: weightKg,
        raw_gross_weight: rawWeightKg,
        camera_snapshots: mergeCameraSnapshots(null, 'gross', snapshots),
      }
    : {
        tare_weight: weightKg,
        raw_tare_weight: rawWeightKg,
        tare_image_path: primaryPath || null,
        camera_snapshots: mergeCameraSnapshots(null, 'tare', snapshots),
      };

  const transaction = TransactionService.updateFields(txnId, {
    ...weightFields,
    weight_offset_kg: weightOffsetKg,
    image_path: primaryPath || null,
    timestamp_in: capturedAt,
    status: TRANSACTION_STATUS.WEIGHING,
    ticket_status: TICKET_STATUS.OPEN,
    material: material || null,
    driver: driver || null,
    customer_name: customer_name || null,
    destination: destination || null,
    operator_name: operator_name || null,
    ...arrivalPhotos,
  });

  RfidTagSelector.unlock();

  logger.info('Open ticket saved', {
    transactionId: txnId,
    slip: transaction.slip_number,
    weightKg,
    cameras: snapshots.length,
  });

  return {
    transaction,
    imagePath: primaryPath,
    cameraSnapshots: snapshots,
    pass: 'OPEN',
    mode: 'OPEN',
    ticketStatus: 'open',
    tripNumber: transaction.slip_number,
    created: true,
  };
}

async function closeTicket({
  openTicket,
  weightKg,
  rawWeightKg,
  weightOffsetKg,
  imageBase64,
  imagePath,
  confirmedSnapshots,
  truckNumber,
  rfidTag,
  vehicleType: vehicleTypeIn,
  material,
  customer_name,
  destination,
  operator_name,
}) {
  if (!openTicket) {
    throw new Error('No open ticket found for this vehicle');
  }
  if (openTicket.ticket_status !== TICKET_STATUS.OPEN) {
    throw new Error('Ticket is not OPEN — cannot close');
  }

  const vehicle = VehicleService.findByNumber(truckNumber);
  const vehicleType = vehicleTypeIn || resolveVehicleType(vehicle, openTicket);
  const hywa = isHywa(vehicleType);

  if (!openTicketHasFirstWeigh(openTicket, vehicleType)) {
    throw new Error(
      hywa ? 'Open ticket has no gross weight' : 'Open ticket has no tare weight',
    );
  }

  const resolveField = (closeValue, ticketValue) => {
    const fromClose = closeValue != null ? String(closeValue).trim() : '';
    if (fromClose) return fromClose;
    const fromTicket = ticketValue != null ? String(ticketValue).trim() : '';
    return fromTicket || '';
  };

  const resolvedMaterial = resolveField(material, openTicket.material);
  const resolvedCustomer = resolveField(customer_name, openTicket.customer_name);
  const resolvedDestination = resolveField(destination, openTicket.destination);
  const resolvedOperator = resolveField(operator_name, openTicket.operator_name);

  if (!resolvedMaterial) {
    throw new Error('Material is required before closing the ticket');
  }
  if (!resolvedCustomer) {
    throw new Error('Customer is required before closing the ticket');
  }
  if (!resolvedDestination) {
    throw new Error('Destination is required before closing the ticket');
  }
  if (!resolvedOperator) {
    throw new Error('Operator is required before closing the ticket');
  }

  const txnId = openTicket.id;
  const { primaryPath, snapshots } = await resolveCapturesForSave({
    imageBase64,
    imagePath,
    confirmedSnapshots,
    transactionId: txnId,
    passKey: 'departure',
  });

  if (!primaryPath && isCameraRequired()) {
    throw new Error('Could not capture images from any camera');
  }

  const departurePhotos = mapPhotoPaths(snapshots, 'departure');
  verifyPhotoFields(departurePhotos, 'departure');
  const capturedAt = ts.now();

  const weightFields = hywa
    ? {
        tare_weight: weightKg,
        raw_tare_weight: rawWeightKg,
        camera_snapshots: mergeCameraSnapshots(openTicket.camera_snapshots, 'tare', snapshots),
      }
    : {
        gross_weight: weightKg,
        raw_gross_weight: rawWeightKg,
        camera_snapshots: mergeCameraSnapshots(openTicket.camera_snapshots, 'gross', snapshots),
      };

  let transaction = TransactionService.updateFields(txnId, {
    ...weightFields,
    weight_offset_kg: weightOffsetKg,
    image_path: primaryPath || null,
    timestamp_out: capturedAt,
    status: TRANSACTION_STATUS.CAPTURED,
    ticket_status: TICKET_STATUS.CLOSED,
    material: resolvedMaterial,
    customer_name: resolvedCustomer,
    destination: resolvedDestination,
    operator_name: resolvedOperator,
    ...departurePhotos,
  });

  RfidTagSelector.unlock();

  logger.info('Ticket closed', {
    transactionId: txnId,
    slip: transaction.slip_number,
    weightKg,
    truckNumber,
    rfidTag,
    cameras: snapshots.length,
  });

  let reportPath = null;
  try {
    const ReportService = require('./ReportService');
    const reportResult = await ReportService.exportTripPDF(txnId);
    if (reportResult.ok && reportResult.path) {
      reportPath = reportResult.path;
      transaction = TransactionService.updateFields(txnId, { report_path: reportPath });
    }
  } catch (err) {
    logger.warn('Auto report generation failed', { transactionId: txnId, message: err.message });
  }

  try {
    const McgPortalService = require('./McgPortalService');
    await McgPortalService.postClosedTicket(txnId);
  } catch (err) {
    logger.warn('MCG portal post failed', { transactionId: txnId, message: err.message });
  }

  try {
    const SyncQueue = require('../engine/SyncQueue');
    SyncQueue.enqueue(txnId);
  } catch (err) {
    logger.warn('Sync queue enqueue failed', { transactionId: txnId, message: err.message });
  }

  return {
    transaction,
    imagePath: primaryPath,
    cameraSnapshots: snapshots,
    pass: 'CLOSE',
    mode: 'CLOSE',
    ticketStatus: 'closed',
    tripNumber: transaction.slip_number,
    reportPath,
    created: false,
  };
}

module.exports = {
  saveTripCapture,
  resolveTripCaptures,
  mergeCameraSnapshots,
  openTicketSave,
  closeTicket,
  isCameraRequired,
  getRequiredPhotoCount,
};
