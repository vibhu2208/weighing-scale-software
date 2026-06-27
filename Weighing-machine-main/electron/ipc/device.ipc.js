'use strict';

const DeviceMonitorService = require('../../backend/services/DeviceMonitorService');
const { saveTripCapture } = require('../../backend/services/TripCaptureService');
const { toPublicTransaction } = require('../../backend/utils/transactionPublic');
const logger = require('../../backend/utils/logger');
const NAMESPACE = 'devices';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:getStatus`, async () => {
    const cached = DeviceMonitorService.getLatestCachedStatus();
    if (cached) return cached;
    return DeviceMonitorService.getCurrentStatus();
  });

  ipcMain.handle(`${NAMESPACE}:setWeighmentContext`, async (_e, payload) => {
    if (payload?.truckNumber || payload?.rfidTag) {
      DeviceMonitorService.setWeighmentContext(payload);
    } else {
      DeviceMonitorService.clearWeighmentContext();
    }
    return { ok: true };
  });

  ipcMain.handle(`${NAMESPACE}:testConnection`, async (_e, deviceType) => {
    const type = String(deviceType || '').toLowerCase();
    const adapters = DeviceMonitorService.getAdapters();
    const SyncService = require('../../backend/services/SyncService');

    if (type === 'cloud') {
      const ok = await SyncService.testConnection();
      return { ok, deviceType: type };
    }

    if (type === 'externaldisplay') {
      const ExternalDisplayService = require('../../backend/services/ExternalDisplayService');
      try {
        const result = await ExternalDisplayService.sendTestWeight(1234);
        return {
          ok: !!result?.ok,
          deviceType: type,
          error: result?.ok ? null : result?.error || 'Display test failed',
          hex: result?.hex || null,
        };
      } catch (err) {
        return { ok: false, deviceType: type, error: err.message };
      }
    }

    const adapter = adapters[type];
    if (!adapter) {
      return { ok: false, error: `Unknown device: ${deviceType}` };
    }

    try {
      if (!adapter.isConnected() && typeof adapter.connect === 'function') {
        await adapter.connect();
      }

      if (type === 'weighbridge') {
        await new Promise((r) => setTimeout(r, 3000));
        const status = typeof adapter.getStatus === 'function' ? adapter.getStatus() : {};
        const diagnostics =
          typeof adapter.getDiagnostics === 'function' ? adapter.getDiagnostics() : null;
        const bytes = diagnostics?.totalBytesReceived ?? 0;
        const portOpen = adapter.isConnected();
        if (bytes > 0) {
          return {
            ok: true,
            deviceType: type,
            diagnostics,
            bytesReceived: bytes,
            message: `Receiving ${bytes} bytes on ${diagnostics?.port || '?'}`,
          };
        }
        return {
          ok: false,
          deviceType: type,
          diagnostics,
          bytesReceived: bytes,
          error: portOpen
            ? `Port ${diagnostics?.port || '?'} is open but no serial data received. Check the scale RS232 cable is plugged into that USB adapter (not the display adapter).`
            : status.lastError || 'Weighbridge port not connected',
        };
      }

      const ok = adapter.isConnected();
      const status = typeof adapter.getStatus === 'function' ? adapter.getStatus() : {};
      const diagnostics =
        typeof adapter.getDiagnostics === 'function' ? adapter.getDiagnostics() : null;
      return {
        ok,
        deviceType: type,
        error: ok ? null : status.lastError || null,
        diagnostics,
        bytesReceived: diagnostics?.totalBytesReceived ?? 0,
      };
    } catch (err) {
      const status =
        adapter && typeof adapter.getStatus === 'function' ? adapter.getStatus() : {};
      return {
        ok: false,
        deviceType: type,
        error: status.lastError || err.message,
      };
    }
  });

  ipcMain.handle(`${NAMESPACE}:testExternalDisplay`, async (_e, testKg) => {
    const ExternalDisplayService = require('../../backend/services/ExternalDisplayService');
    try {
      const result = await ExternalDisplayService.sendTestWeight(
        testKg != null ? Number(testKg) : 1234,
      );
      setTimeout(() => {
        try {
          DeviceMonitorService.syncExternalDisplay();
        } catch (_e) {
          /* optional */
        }
      }, 800);
      return result;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle(`${NAMESPACE}:listSerialPorts`, async () => {
    const { SerialPort } = require('serialport');
    try {
      const ports = await SerialPort.list();
      return { ok: true, ports };
    } catch (err) {
      return { ok: false, error: err.message, ports: [] };
    }
  });

  ipcMain.handle(`${NAMESPACE}:probeWeighbridgePorts`, async () => {
    const { probeAvailablePorts } = require('../../backend/services/WeightBridgeService');
    const { weighbridge } = DeviceMonitorService.getAdapters();

    if (weighbridge && typeof weighbridge.scanBaudRates === 'function') {
      const diag = weighbridge.getDiagnostics();
      if (diag?.connected) {
        if (diag.totalBytesReceived > 0) {
          return {
            ok: true,
            live: true,
            active: [
              {
                path: diag.port,
                baudRate: diag.baudRate,
                dataBits: diag.dataBits,
                parity: diag.parity,
                stopBits: diag.stopBits,
                bytes: diag.totalBytesReceived,
                sampleHex: diag.lastSampleHex,
                sampleText: diag.lastSampleText,
              },
            ],
            diagnostics: diag,
            message: `Receiving data on ${diag.port} (${diag.totalBytesReceived} bytes)`,
          };
        }

        const scan = await weighbridge.scanBaudRates(2500);
        const active = (scan.results || []).filter((r) => r.bytes > 0);
        if (scan.found && scan.match) {
          return {
            ok: true,
            live: true,
            scanned: true,
            active: [scan.match],
            scan,
            diagnostics: weighbridge.getDiagnostics(),
            message: `Found scale on ${scan.match.path} @ ${scan.match.baudRate} ${scan.match.dataBits}N${scan.match.stopBits}`,
          };
        }
        return {
          ok: false,
          live: true,
          scanned: true,
          active: [],
          scan,
          diagnostics: weighbridge.getDiagnostics(),
          message: `Port ${diag.port} is open but no bytes received on any baud rate (2400–19200, 7/8 bit, none/even/odd parity). The scale RS232 cable may be on the wrong USB adapter — try swapping COM3/COM4 in Settings, or test with Docklight on each port.`,
        };
      }
    }

    try {
      const result = await probeAvailablePorts(2500);
      const active = (result.probes || []).filter((p) => p.bytes > 0);
      const denied = (result.probes || []).filter(
        (p) => p.error && /access denied/i.test(String(p.error)),
      );
      if (!active.length && denied.length) {
        return {
          ok: false,
          ...result,
          active,
          message:
            'COM4 is in use by the app. Restart is not required — use Detect again while the weigh screen shows NO SIGNAL; the app will auto-scan baud rates after 6 seconds.',
        };
      }
      return {
        ok: active.length > 0,
        ...result,
        active,
        message: active.length
          ? null
          : 'No serial data on COM4. Verify the scale cable is on the COM4 USB adapter (not COM3).',
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle(`${NAMESPACE}:getRfidDisplayState`, async () =>
    DeviceMonitorService.getRfidDisplayState(),
  );

  ipcMain.handle(`${NAMESPACE}:syncRfid`, async () => {
    DeviceMonitorService.syncRfidToRenderer();
    return { ok: true, ...DeviceMonitorService.getRfidDisplayState() };
  });

  ipcMain.handle(`${NAMESPACE}:startRfidScan`, async () => {
    await DeviceMonitorService.startRfidScan();
    return { ok: true, scanning: true };
  });

  ipcMain.handle(`${NAMESPACE}:stopRfidScan`, async () => {
    await DeviceMonitorService.stopRfidScan();
    return { ok: true, scanning: false };
  });

  ipcMain.handle(`${NAMESPACE}:getTestConfig`, async () =>
    DeviceMonitorService.getTestConfig(),
  );

  ipcMain.handle(`${NAMESPACE}:getCameraList`, async () => {
    const MultiCameraPreviewService = require('../../backend/services/MultiCameraPreviewService');
    const cameras = MultiCameraPreviewService.getCamerasFromConfig(
      DeviceMonitorService.getCameraConfig(),
    );
    return cameras.map((c) => ({ id: c.id, label: c.label, disabled: !!c.disabled }));
  });

  ipcMain.handle(`${NAMESPACE}:getCameraPreviewStatus`, async () => {
    const MultiCameraPreviewService = require('../../backend/services/MultiCameraPreviewService');
    const cameraConfig = DeviceMonitorService.getCameraConfig();
    return MultiCameraPreviewService.getPreviewStatus({ config: cameraConfig });
  });

  ipcMain.handle(`${NAMESPACE}:captureManualPhotos`, async (_e, payload) => {
    try {
      const ManualPhotoCaptureService = require('../../backend/services/ManualPhotoCaptureService');
      const result = await ManualPhotoCaptureService.captureManualSession(payload || {});
      return { ok: true, ...result };
    } catch (err) {
      logger.warn('captureManualPhotos failed', { message: err.message });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle(`${NAMESPACE}:retryManualPhoto`, async (_e, payload) => {
    try {
      const ManualPhotoCaptureService = require('../../backend/services/ManualPhotoCaptureService');
      const result = await ManualPhotoCaptureService.retryManualSessionPhoto(payload || {});
      return { ok: true, ...result };
    } catch (err) {
      logger.warn('retryManualPhoto failed', { message: err.message });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle(`${NAMESPACE}:startCameraPreview`, async (_e, cameraId) => {
    const testConfig = DeviceMonitorService.getTestConfig();
    if (!testConfig.useRtspCamera) {
      return { ok: false, error: 'RTSP preview requires USE_WEBCAM_CAMERA=false' };
    }

    const MultiCameraPreviewService = require('../../backend/services/MultiCameraPreviewService');
    const cameraConfig = DeviceMonitorService.getCameraConfig();
    const cameras = MultiCameraPreviewService.getCamerasFromConfig(cameraConfig);
    const emitFrame = (id, frame, meta = {}) => {
      DeviceMonitorService.emitToRenderer('device:cameraFrame', {
        cameraId: id,
        frame,
        blank: !!meta.blank,
      });
    };

    if (cameras.length > 1) {
      try {
        if (cameraId) {
          const cam = MultiCameraPreviewService.startCamera(
            cameraId,
            cameraConfig,
            emitFrame,
          );
          return {
            ok: true,
            cameras: [{ id: cam.id, label: cam.label }],
          };
        }
        const started = MultiCameraPreviewService.start(cameraConfig, emitFrame);
        return {
          ok: true,
          cameras: started.map((c) => ({ id: c.id, label: c.label })),
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    const { camera } = DeviceMonitorService.getAdapters();
    if (!camera || typeof camera.startPreview !== 'function') {
      return { ok: false, error: 'RTSP preview is not available for this camera mode' };
    }
    if (!camera.isConnected()) {
      try {
        await camera.connect();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    const primaryId = cameras[0]?.id || 'cam-primary';
    camera.startPreview((frame) => {
      DeviceMonitorService.emitToRenderer('device:cameraFrame', {
        cameraId: primaryId,
        frame,
      });
    });
    return {
      ok: true,
      cameras: cameras.length
        ? cameras.map((c) => ({ id: c.id, label: c.label }))
        : [{ id: primaryId, label: 'Camera' }],
    };
  });

  ipcMain.handle(`${NAMESPACE}:stopCameraPreview`, async (_e, cameraId) => {
    const MultiCameraPreviewService = require('../../backend/services/MultiCameraPreviewService');
    if (cameraId) {
      MultiCameraPreviewService.stopCamera(cameraId);
    } else {
      MultiCameraPreviewService.stop();
      const { camera } = DeviceMonitorService.getAdapters();
      if (camera && typeof camera.stopPreview === 'function') {
        camera.stopPreview();
      }
    }
    return { ok: true };
  });

  ipcMain.handle(`${NAMESPACE}:saveTestCapture`, async (_e, payload) => {
    try {
      const result = await saveTripCapture(payload || {});
      DeviceMonitorService.emitToRenderer('device:cameraCapture', {
        imagePath: result.imagePath,
        transactionId: result.transaction?.id,
      });
      return { ok: true, ...result };
    } catch (err) {
      logger.warn('saveTestCapture failed', { message: err.message });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle(`${NAMESPACE}:saveTripCapture`, async (_e, payload) => {
    try {
      const result = await saveTripCapture(payload || {});

      DeviceMonitorService.emitToRenderer('device:cameraCapture', {
        imagePath: result.imagePath,
        transactionId: result.transaction?.id,
      });

      return {
        ok: true,
        ...result,
        transaction: toPublicTransaction(result.transaction),
      };
    } catch (err) {
      logger.warn('saveTripCapture failed', { message: err.message });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle(`${NAMESPACE}:getRfidPower`, async () => {
    const SettingsService = require('../../backend/services/SettingsService');
    const { rfid } = DeviceMonitorService.getAdapters();
    const savedPower = Number(SettingsService.get('RFID_ANTENNA_POWER')) || 20;

    if (!rfid || typeof rfid.getPowerInfo !== 'function') {
      return {
        minPower: 5,
        maxPower: 30,
        currentPower: savedPower,
        connected: false,
        savedPower,
      };
    }

    try {
      const info = await rfid.getPowerInfo();
      return {
        ...info,
        savedPower,
        mock: !!info.mock,
      };
    } catch (err) {
      logger.warn('getRfidPower failed', { message: err.message });
      return {
        minPower: 5,
        maxPower: 30,
        currentPower: savedPower,
        connected: rfid.isConnected ? rfid.isConnected() : false,
        savedPower,
        error: err.message,
      };
    }
  });

  ipcMain.handle(`${NAMESPACE}:setRfidPower`, async (_e, powerDb) => {
    const SettingsService = require('../../backend/services/SettingsService');
    const power = Math.round(Number(powerDb));
    if (!Number.isFinite(power)) {
      throw new Error('Invalid RFID power value');
    }

    SettingsService.set('RFID_ANTENNA_POWER', String(power));

    const { rfid } = DeviceMonitorService.getAdapters();
    if (!rfid || typeof rfid.setAntennaPower !== 'function') {
      return { ok: true, saved: true, applied: false, power };
    }

    try {
      const result = await rfid.setAntennaPower(power);
      if (rfid.config) rfid.config.antennaPower = power;
      return result;
    } catch (err) {
      logger.warn('setRfidPower failed', { message: err.message, power });
      return { ok: false, saved: true, applied: false, power, error: err.message };
    }
  });
}

module.exports = { register, NAMESPACE };
