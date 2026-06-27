import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useDeviceStore from '../store/deviceStore.js';
import useTransactionStore from '../store/transactionStore.js';
import useStableLiveWeight from '../hooks/useStableLiveWeight.js';
import ConfirmModal from '../components/shared/ConfirmModal.jsx';
import Badge from '../components/shared/Badge.jsx';
import StatusDot from '../components/shared/StatusDot.jsx';
import WebcamPreview from '../components/device/WebcamPreview.jsx';
import { useLocation } from 'react-router-dom';
import {
  deviceAPI,
  settingsAPI,
  ticketAPI,
  vehicleAPI,
  workflowAPI,
  transactionAPI,
} from '../api/ipc.js';
import LocalImage from '../components/shared/LocalImage.jsx';
import { isStuckOpenTicket } from '../lib/ticketStatus.js';
import {
  VEHICLE_TYPES,
  isHywa,
  liveWeightLabel,
  openTicketFirstWeighKg,
  openTicketFirstWeighLabel,
  resolveVehicleType,
} from '../lib/vehicleTypes.js';

const EMPTY_MANUAL_VEHICLE = {
  vehicle_number: '',
  rfid_tag: '',
  owner_name: '',
  transporter: '',
  vehicle_type: 'truck',
  max_capacity: '',
};

export default function WeighmentScreen() {
  const location = useLocation();
  const displayWeight = useDeviceStore((s) => s.displayWeight);
  const rfid = useDeviceStore((s) => s.rfid);
  const rfidLocked = useDeviceStore((s) => s.rfid.locked);
  const workflowState = useTransactionStore((s) => s.workflowState);
  const timeline = useTransactionStore((s) => s.timeline);
  const lastEvent = useTransactionStore((s) => s.lastEvent);

  const [vehicle, setVehicle] = useState(null);
  const [manualTruck, setManualTruck] = useState('');
  const [abortOpen, setAbortOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [manualVehicleForm, setManualVehicleForm] = useState(EMPTY_MANUAL_VEHICLE);
  const [manualVehicleErrors, setManualVehicleErrors] = useState({});
  const [creatingVehicle, setCreatingVehicle] = useState(false);
  const [manualEntryOpen, setManualEntryOpen] = useState(false);
  const [enteredManually, setEnteredManually] = useState(false);
  const [unknownTagLocked, setUnknownTagLocked] = useState(null);
  const [testConfig, setTestConfig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedCaptureUrl, setSavedCaptureUrl] = useState(null);
  const [webcamReady, setWebcamReady] = useState(false);
  const [weighmentInfo, setWeighmentInfo] = useState(null);
  const [saveMessage, setSaveMessage] = useState(null);
  const [identifiedTruck, setIdentifiedTruck] = useState(null);
  const [material, setMaterial] = useState('');
  const [driver, setDriver] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [destination, setDestination] = useState('');
  const [operatorName, setOperatorName] = useState('');
  const [materialsList, setMaterialsList] = useState([]);
  const [customersList, setCustomersList] = useState([]);
  const [destinationsList, setDestinationsList] = useState([]);
  const [operatorsList, setOperatorsList] = useState([]);
  const [openTickets, setOpenTickets] = useState([]);
  const [selectedOpenTicket, setSelectedOpenTicket] = useState(null);
  const [manualPhotos, setManualPhotos] = useState(null);
  const [capturingPhotos, setCapturingPhotos] = useState(false);
  const [retryingCameraId, setRetryingCameraId] = useState(null);
  const webcamRef = useRef(null);

  const unknownTag =
    unknownTagLocked ||
    (lastEvent?.channel === 'workflow:unknownRFID' ? lastEvent.tag : null);
  const inProgress = workflowState !== 'IDLE' && workflowState !== 'ERROR';

  const displayTag = rfidLocked
    ? rfid.lockedTag
    : rfid.scanning
      ? rfid.lastTag
      : null;

  const truckForSave =
    vehicle?.vehicle_number || identifiedTruck || selectedOpenTicket?.truck_number || null;

  const openTicket = selectedOpenTicket || weighmentInfo?.openTicket || null;

  const weighMode = openTicket ? 'CLOSE' : weighmentInfo?.mode || (truckForSave ? 'OPEN' : null);

  const vehicleType = resolveVehicleType(vehicle, openTicket) || weighmentInfo?.vehicleType || null;
  const hywaVehicle = isHywa(vehicleType) || weighmentInfo?.isHywa === true;

  const kg = useStableLiveWeight(displayWeight, { throttleMs: 300, zeroHoldMs: 2000 });

  const effectiveWeight = kg;

  const netPreview = useMemo(() => {
    if (weighMode !== 'CLOSE') return null;
    const firstWeigh = openTicketFirstWeighKg(openTicket, vehicleType);
    if (firstWeigh == null) return null;
    const first = Number(firstWeigh);
    const live = Math.round(Number(kg));
    if (!live || live <= 0) return null;
    return hywaVehicle ? first - live : live - first;
  }, [weighMode, openTicket, vehicleType, hywaVehicle, kg]);

  const testMode = testConfig?.useWebcamCamera;
  const requiredPhotos = testConfig?.enabledPhotos ?? testConfig?.requiredPhotos ?? 1;
  const configuredCameras = testConfig?.cameras || [];
  const minPhotosToSave = testConfig?.minPhotosToSave ?? 1;
  const useRtspCameras = testConfig?.useRtspCamera && !testConfig?.useWebcamCamera;
  const cameraPreviewOnDemand = testConfig?.cameraPreviewOnDemand !== false;
  const manualPhotoCapture =
    useRtspCameras && testConfig?.manualPhotoCapture !== false;
  const photoPassKey = weighMode === 'CLOSE' ? 'departure' : 'arrival';
  const manualPhotosForPass =
    manualPhotos?.passKey === photoPassKey ? manualPhotos : null;
  const manualPhotosReady =
    !manualPhotoCapture ||
    (manualPhotosForPass?.snapshots?.length ?? 0) >= minPhotosToSave;

  const ticketDetailsComplete =
    !!material && !!customerName && !!destination && !!operatorName.trim();

  const canSaveTrip =
    effectiveWeight > 0 &&
    !!truckForSave &&
    !!weighMode &&
    (weighMode !== 'CLOSE' || ticketDetailsComplete) &&
    (!testConfig?.useWebcamCamera || webcamReady) &&
    manualPhotosReady;

  const saveBlockedReason = !truckForSave && !selectedOpenTicket
    ? 'Scan RFID, enter vehicle number, or select an open ticket below'
    : manualPhotoCapture && !manualPhotosReady
      ? `Press Capture images first (at least ${minPhotosToSave} photo${minPhotosToSave === 1 ? '' : 's'} required)`
      : weighMode === 'CLOSE' && !material
        ? 'Select material before closing'
        : weighMode === 'CLOSE' && !customerName
          ? 'Select customer before closing'
          : weighMode === 'CLOSE' && !destination
            ? 'Select destination before closing'
            : weighMode === 'CLOSE' && !operatorName.trim()
              ? 'Enter operator name before closing'
              : effectiveWeight <= 0
                ? 'Waiting for live weight from scale'
                : testConfig?.useWebcamCamera && !webcamReady
                  ? 'Allow webcam access first'
                  : null;

  const canAbort =
    rfidLocked ||
    rfid.scanning ||
    workflowState === 'RFID_DETECTED' ||
    inProgress ||
    !!truckForSave ||
    !!selectedOpenTicket;

  const applyOpenTicketFields = useCallback((ticket) => {
    if (!ticket) return;
    setMaterial(ticket.material || '');
    setDriver(ticket.driver || '');
    setCustomerName(ticket.customer_name || '');
    setDestination(ticket.destination || '');
    setOperatorName(ticket.operator_name || '');
  }, []);

  const handleSelectOpenTicket = useCallback(
    async (ticket) => {
      if (!ticket?.id) return;
      setSelectedOpenTicket(ticket);
      setIdentifiedTruck(String(ticket.truck_number || '').trim().toUpperCase());
      applyOpenTicketFields(ticket);
      setSaveMessage(null);
      setManualPhotos(null);
      setUnknownTagLocked(null);
      setEnteredManually(true);
      try {
        const existing = await vehicleAPI.findByNumber(ticket.truck_number);
        setVehicle(existing || null);
      } catch {
        setVehicle(null);
      }
    },
    [applyOpenTicketFields],
  );

  const clearSelectedOpenTicket = useCallback(() => {
    setSelectedOpenTicket(null);
    setMaterial('');
    setDriver('');
    setCustomerName('');
    setDestination('');
    setOperatorName('');
    if (!rfidLocked && !displayTag) {
      setIdentifiedTruck(null);
      setVehicle(null);
      setEnteredManually(false);
    }
  }, [rfidLocked, displayTag]);

  const refreshOpenTickets = useCallback(() => {
    ticketAPI
      .listOpen()
      .then(setOpenTickets)
      .catch(() => setOpenTickets([]));
  }, []);

  useEffect(() => {
    const routeOpenTicketId =
      location?.state?.openTicketId ||
      new URLSearchParams(location?.search || '').get('openTicketId');

    if (!routeOpenTicketId) return;

    (async () => {
      try {
        const txn = await transactionAPI.getById(routeOpenTicketId);
        if (!txn || txn.ticket_status !== 'OPEN') {
          alert('Selected ticket is not open anymore');
          return;
        }
        await handleSelectOpenTicket(txn);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(e);
        alert('Failed to load selected ticket');
      }
    })();
  }, [location, handleSelectOpenTicket]);

  const resetWeighScreen = useCallback((options = {}) => {
    const { keepMessage = false } = options;
    useTransactionStore.getState().resetActive();
    useDeviceStore.getState().clearRfidScan();
    useDeviceStore.getState().setRfidScanning(false);
    setVehicle(null);
    setWeighmentInfo(null);
    setIdentifiedTruck(null);
    setManualTruck('');
    setManualEntryOpen(false);
    setEnteredManually(false);
    setUnknownTagLocked(null);
    setSavedCaptureUrl(null);
    if (!keepMessage) {
      setSaveMessage(null);
    }
    setMaterial('');
    setDriver('');
    setCustomerName('');
    setDestination('');
    setOperatorName('');
    setManualPhotos(null);
    setCapturingPhotos(false);
    setRetryingCameraId(null);
    setSelectedOpenTicket(null);
    refreshOpenTickets();
    deviceAPI.setWeighmentContext({}).catch(() => {});
    workflowAPI.clearSessionAfterSave().catch(() => {});
    deviceAPI.stopRfidScan().catch(() => {});
  }, [refreshOpenTickets]);

  useEffect(() => {
    let cancelled = false;

    deviceAPI.getTestConfig().then(setTestConfig).catch(() => {});
    settingsAPI.getMaterials().then(setMaterialsList).catch(() => setMaterialsList([]));
    settingsAPI.getCustomers().then(setCustomersList).catch(() => setCustomersList([]));
    settingsAPI.getDestinations().then(setDestinationsList).catch(() => setDestinationsList([]));
    settingsAPI.getOperators().then(setOperatorsList).catch(() => setOperatorsList([]));
    refreshOpenTickets();

    (async () => {
      try {
        const rfidState = await deviceAPI.syncRfid();
        if (cancelled) return;

        const dev = useDeviceStore.getState();
        const hasActiveSession = dev.rfid.locked || dev.rfid.scanning;

        if (!hasActiveSession) {
          setVehicle(null);
          setWeighmentInfo(null);
          setIdentifiedTruck(null);
          setManualTruck('');
          setEnteredManually(false);
          setUnknownTagLocked(null);
          setSavedCaptureUrl(null);
          setSaveMessage(null);
          setMaterial('');
          setDriver('');
          setCustomerName('');
          setDestination('');
          setOperatorName('');
          dev.clearRfidScan();
          useTransactionStore.getState().resetActive();
          return;
        }

        if (rfidState?.tag) {
          if (rfidState.scanning != null) {
            dev.setRfidScanning(!!rfidState.scanning);
          }
          dev.setLastRfidScan({
            tag: rfidState.tag,
            tid: rfidState.tid ?? null,
            rssi: rfidState.rssi ?? null,
            antenna: rfidState.antenna ?? null,
            readerName: rfidState.readerName ?? null,
            timestamp: rfidState.timestamp ?? new Date().toISOString(),
            locked: !!rfidState.locked,
          });
        }

        const wf = await workflowAPI.getState();
        if (cancelled) return;

        if (wf?.context?.rfidTag && wf.state === 'RFID_DETECTED') {
          dev.lockRfid(wf.context.rfidTag);
        }
        if (wf?.context?.truckNumber) {
          setIdentifiedTruck(String(wf.context.truckNumber).trim().toUpperCase());
        } else if (wf?.state === 'RFID_DETECTED' && wf?.context?.rfidTag) {
          setUnknownTagLocked(wf.context.rfidTag);
        }
      } catch (_e) {
        /* ignore */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshOpenTickets]);

  useEffect(() => {
    setManualPhotos(null);
    setCapturingPhotos(false);
    setRetryingCameraId(null);
  }, [weighMode, photoPassKey]);

  async function handleCaptureImages() {
    if (!weighMode) {
      alert('Scan RFID or enter truck number before capturing photos.');
      return;
    }
    setCapturingPhotos(true);
    setSaveMessage(null);
    try {
      const result = await deviceAPI.captureManualPhotos({
        sessionId: manualPhotosForPass?.sessionId,
        passKey: photoPassKey,
      });
      if (!result?.ok) {
        throw new Error(result?.error || 'Capture failed');
      }
      setManualPhotos({
        sessionId: result.sessionId,
        passKey: result.passKey,
        snapshots: result.snapshots || [],
        failedCameras: result.failedCameras || [],
      });
      const capturedLabels = (result.snapshots || []).map((s) => s.label).join(', ');
      const failed = result.failedCameras || [];
      if (failed.length) {
        const failedDetail = failed
          .map((f) => `${f.label}: ${String(f.error || 'capture failed').split(';')[0]}`)
          .join('\n');
        alert(
          `Some cameras could not be captured:\n\n${failedDetail}\n\nCaptured: ${capturedLabels || 'none'}\n\nYou can Retry failed cameras or Save with available photos.`,
        );
        setSaveMessage(
          `Captured ${result.snapshots?.length || 0} photo(s). Missing: ${failed.map((f) => f.label).join(', ')} — Retry or Save with available photos.`,
        );
      } else {
        setSaveMessage(
          `Captured ${result.snapshots?.length || 0} photo(s). Review below — use Retry if any look grey or distorted, then Save.`,
        );
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setCapturingPhotos(false);
    }
  }

  async function handleRetryPhoto(cameraId) {
    if (!manualPhotosForPass?.sessionId) return;
    setRetryingCameraId(cameraId);
    try {
      const result = await deviceAPI.retryManualPhoto({
        sessionId: manualPhotosForPass.sessionId,
        cameraId,
        passKey: manualPhotosForPass.passKey,
      });
      if (!result?.ok) {
        throw new Error(result?.error || 'Retry failed');
      }
      setManualPhotos((prev) => {
        if (!prev || prev.passKey !== photoPassKey) return prev;
        const others = prev.snapshots.filter((s) => s.id !== result.snapshot.id);
        const updated = {
          ...result.snapshot,
          capturedAt: result.snapshot.capturedAt || Date.now(),
        };
        return {
          ...prev,
          snapshots: [...others, updated],
          failedCameras: (prev.failedCameras || []).filter((f) => f.id !== cameraId),
        };
      });
    } catch (err) {
      alert(err.message);
    } finally {
      setRetryingCameraId(null);
    }
  }

  useEffect(() => {
    if (!rfidLocked) return;
    if (lastEvent?.channel === 'workflow:unknownRFID' && lastEvent.tag) {
      setUnknownTagLocked(lastEvent.tag);
    }
  }, [lastEvent, rfidLocked]);

  useEffect(() => {
    if (!rfidLocked) return;
    if (lastEvent?.channel === 'workflow:rfidReady' && lastEvent.truckNumber) {
      setIdentifiedTruck(String(lastEvent.truckNumber).trim().toUpperCase());
      if (lastEvent.manualEntry) {
        setEnteredManually(true);
      }
      if (lastEvent.vehicle) {
        setVehicle(lastEvent.vehicle);
      }
    }
  }, [lastEvent, rfidLocked]);

  useEffect(() => {
    if (vehicle?.vehicle_number) {
      setIdentifiedTruck(vehicle.vehicle_number);
    }
  }, [vehicle?.vehicle_number]);

  useEffect(() => {
    if (workflowState === 'VEHICLE_IDENTIFIED' || workflowState === 'AWAITING_WEIGHT') {
      setUnknownTagLocked(null);
    }
    if (workflowState === 'IDLE' && !rfidLocked) {
      setUnknownTagLocked(null);
    }
  }, [workflowState, rfidLocked]);

  useEffect(() => {
    if (!displayTag) {
      if (!identifiedTruck) {
        setVehicle(null);
      }
      return;
    }
    vehicleAPI
      .findByRFID(displayTag)
      .then((v) => setVehicle(v))
      .catch(() => setVehicle(null));
  }, [displayTag, identifiedTruck]);

  useEffect(() => {
    const truck = vehicle?.vehicle_number || identifiedTruck || null;
    if (!truck || selectedOpenTicket) {
      if (!truck && !selectedOpenTicket) {
        setWeighmentInfo(null);
      }
      return;
    }
    setWeighmentInfo(null);
    vehicleAPI
      .getWeighmentInfo(truck, displayTag || vehicle?.rfid_tag || null)
      .then((info) => {
        setWeighmentInfo(info);
        if (info?.mode === 'CLOSE' && info.openTicket) {
          applyOpenTicketFields(info.openTicket);
        }
      })
      .catch(() => setWeighmentInfo(null));
  }, [
    vehicle?.vehicle_number,
    vehicle?.rfid_tag,
    vehicle?.vehicle_type,
    identifiedTruck,
    displayTag,
    selectedOpenTicket,
    applyOpenTicketFields,
  ]);

  useEffect(() => {
    const truck = truckForSave;
    if (!truck) {
      deviceAPI.setWeighmentContext({}).catch(() => {});
      return;
    }
    deviceAPI
      .setWeighmentContext({
        truckNumber: truck,
        rfidTag: displayTag || vehicle?.rfid_tag || null,
      })
      .catch(() => {});
  }, [truckForSave, displayTag, vehicle?.rfid_tag]);

  useEffect(() => {
    const truck = identifiedTruck?.trim().toUpperCase();
    if (!truck || vehicle?.vehicle_number === truck) return;
    vehicleAPI
      .findByNumber(truck)
      .then((v) => {
        if (v) setVehicle(v);
      })
      .catch(() => {});
  }, [identifiedTruck, vehicle?.vehicle_number]);

  useEffect(() => {
    if (!rfidLocked || !identifiedTruck || !selectedOpenTicket) return;
    const selectedTruck = String(selectedOpenTicket.truck_number || '')
      .trim()
      .toUpperCase();
    if (selectedTruck && identifiedTruck !== selectedTruck) {
      setSelectedOpenTicket(null);
    }
  }, [rfidLocked, identifiedTruck, selectedOpenTicket]);

  function openManualVehicleForm(truckNumber) {
    const truck = String(truckNumber || manualTruck).trim().toUpperCase();
    setManualEntryOpen(false);
    setManualVehicleForm({
      ...EMPTY_MANUAL_VEHICLE,
      vehicle_number: truck,
      rfid_tag: unknownTag || rfid.lastTag || '',
    });
    setManualVehicleErrors({});
    setCreateOpen(true);
  }

  function validateManualVehicleForm() {
    const e = {};
    if (!manualVehicleForm.vehicle_number.trim()) e.vehicle_number = 'Required';
    if (!manualVehicleForm.owner_name.trim()) e.owner_name = 'Required';
    if (!manualVehicleForm.vehicle_type) e.vehicle_type = 'Required';
    if (
      manualVehicleForm.max_capacity !== '' &&
      Number(manualVehicleForm.max_capacity) <= 0
    ) {
      e.max_capacity = 'Must be positive';
    }
    setManualVehicleErrors(e);
    return Object.keys(e).length === 0;
  }

  async function proceedWithManualVehicle(existing) {
    const truck = (existing?.vehicle_number || manualTruck).trim().toUpperCase();
    if (!truck) return;

    await deviceAPI.stopRfidScan().catch(() => {});
    useDeviceStore.getState().setRfidScanning(false);

    await workflowAPI.acceptManualEntry(truck);
    setVehicle(existing || null);
    setIdentifiedTruck(truck);
    setEnteredManually(true);
    setManualTruck('');
    setManualEntryOpen(false);
    setUnknownTagLocked(null);
  }

  async function handleManualSubmit() {
    const truck = manualTruck.trim().toUpperCase();
    if (!truck) return;
    try {
      const existing = await vehicleAPI.findByNumber(truck);
      if (!existing) {
        openManualVehicleForm(truck);
        return;
      }
      await proceedWithManualVehicle(existing);
    } catch (err) {
      alert(err.message);
    }
  }

  function openManualEntryDialog() {
    setManualTruck('');
    setManualEntryOpen(true);
  }

  async function confirmCreateVehicle() {
    if (!validateManualVehicleForm()) return;
    setCreatingVehicle(true);
    setManualVehicleErrors({});
    try {
      const payload = {
        vehicle_number: manualVehicleForm.vehicle_number.trim().toUpperCase(),
        rfid_tag: manualVehicleForm.rfid_tag.trim().toUpperCase() || null,
        owner_name: manualVehicleForm.owner_name.trim(),
        transporter: manualVehicleForm.transporter.trim() || null,
        vehicle_type: manualVehicleForm.vehicle_type || 'truck',
        max_capacity:
          manualVehicleForm.max_capacity === ''
            ? null
            : Number(manualVehicleForm.max_capacity),
      };
      const created = await vehicleAPI.create(payload);
      await proceedWithManualVehicle(created);
      setCreateOpen(false);
      setManualVehicleForm(EMPTY_MANUAL_VEHICLE);
    } catch (err) {
      const msg = err.message || 'Save failed';
      if (msg.includes('rfid_tag')) {
        setManualVehicleErrors({ rfid_tag: 'RFID tag already assigned to another vehicle' });
      } else if (msg.includes('vehicle_number')) {
        setManualVehicleErrors({ vehicle_number: 'Vehicle number already exists' });
      } else {
        setManualVehicleErrors({ form: msg });
      }
    } finally {
      setCreatingVehicle(false);
    }
  }

  async function handleStartRfidScan() {
    try {
      useDeviceStore.getState().clearRfidScan();
      setVehicle(null);
      setIdentifiedTruck(null);
      setWeighmentInfo(null);
      setSelectedOpenTicket(null);
      setUnknownTagLocked(null);
      setEnteredManually(false);
      setManualTruck('');
      setMaterial('');
      setDriver('');
      setCustomerName('');
      setDestination('');
      setOperatorName('');
      await deviceAPI.startRfidScan();
    } catch (err) {
      alert(err.message || 'Failed to start RFID scan');
    }
  }

  async function handleSaveTripCapture() {
    if (!truckForSave) {
      alert('Scan an RFID tag first (or enter truck number for unknown tags).');
      return;
    }
    if (weighMode === 'CLOSE' && !material) {
      alert('Select a material before closing.');
      return;
    }
    if (weighMode === 'CLOSE' && !customerName) {
      alert('Select a customer before closing.');
      return;
    }
    if (weighMode === 'CLOSE' && !destination) {
      alert('Select a destination before closing.');
      return;
    }
    if (weighMode === 'CLOSE' && !operatorName.trim()) {
      alert('Enter operator name before closing.');
      return;
    }
    const weightAtSave = Math.round(Number(effectiveWeight));
    if (!weightAtSave || weightAtSave <= 0) {
      alert('No weight reading available.');
      return;
    }
    setSaving(true);
    if (useRtspCameras && cameraPreviewOnDemand && !manualPhotoCapture) {
      setSaveMessage(`Capturing ${requiredPhotos} photo${requiredPhotos === 1 ? '' : 's'} for report…`);
    }
    try {
      let payload = {
        weightKg: weightAtSave,
        truckNumber: truckForSave,
        rfidTag: displayTag || vehicle?.rfid_tag || null,
        material: material || null,
        driver: driver.trim() || null,
        customer_name: customerName || null,
        destination: destination || null,
        operator_name: operatorName.trim() || null,
      };

      if (testConfig?.useWebcamCamera) {
        if (!webcamRef.current?.isReady?.()) {
          throw new Error('Webcam is not ready yet — allow camera access when prompted');
        }
        payload.imageBase64 = webcamRef.current.capture();
      }

      if (manualPhotoCapture && manualPhotosForPass?.snapshots?.length) {
        payload.confirmedSnapshots = manualPhotosForPass.snapshots;
      }

      if (openTicket?.id) {
        payload.openTicketId = openTicket.id;
      }

      const result = await deviceAPI.saveTripCapture(payload);
      if (!result?.ok) {
        throw new Error(result?.error || 'Save failed');
      }

      const store = useTransactionStore.getState();
      if (result.transaction) {
        store.addTransaction(result.transaction);
        const stepLabel =
          result.pass === 'OPEN'
            ? 'Open ticket saved'
            : result.pass === 'CLOSE'
              ? 'Ticket closed'
              : 'Saved';
        store.pushTimeline({ step: stepLabel, detail: `${weightAtSave} kg` });
      }

      if (result.pass === 'OPEN') {
        resetWeighScreen({ keepMessage: true });
        setSaveMessage(
          `Open ticket ${result.tripNumber || result.transaction?.slip_number} saved. Ready for next vehicle.`,
        );
        setTimeout(() => setSaveMessage(null), 4000);
      } else if (result.pass === 'CLOSE') {
        setSaveMessage(
          `Ticket ${result.tripNumber || result.transaction?.slip_number} closed.${
            result.reportPath ? ' Report generated.' : ''
          }`,
        );
        setTimeout(() => resetWeighScreen(), 1500);
      } else {
        setTimeout(() => resetWeighScreen(), 1500);
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  const arrivalPhotoPaths = openTicket
    ? ['arrival_photo_1', 'arrival_photo_2', 'arrival_photo_3']
        .map((col) => openTicket[col])
        .filter(Boolean)
    : [];

  return (
    <div className="flex flex-col gap-4 pb-8">
      <header>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold text-white">Weighment</h1>
          {openTickets.length > 0 && (
            <Badge label={`${openTickets.length} open ticket(s)`} variant="warning" />
          )}
        </div>
        <p className="mt-1 text-sm text-slate-400">
          Scan RFID or enter vehicle manually → capture weight and photos → save open ticket or close existing ticket
        </p>
        {weighMode === 'OPEN' && truckForSave && (
          <p className="mt-2 text-sm text-amber-300">
            Mode: OPEN TICKET — capture {hywaVehicle ? 'gross' : 'tare'} and arrival photos
          </p>
        )}
        {weighMode === 'CLOSE' && openTicket && (
          <p className="mt-2 text-sm text-emerald-300">
            Mode: CLOSE TICKET — {openTicket.slip_number} · {openTicketFirstWeighLabel(vehicleType).toLowerCase()}{' '}
            {fmtKg(openTicketFirstWeighKg(openTicket, vehicleType))}
            {selectedOpenTicket ? ' · manually selected' : ''}
          </p>
        )}
      </header>

      {openTickets.length > 0 && (
        <div className="card p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h2 className="text-xs uppercase tracking-widest text-slate-400">Open tickets</h2>
            {selectedOpenTicket && (
              <button
                type="button"
                className="text-xs text-slate-400 hover:text-white underline"
                onClick={clearSelectedOpenTicket}
              >
                Clear selection
              </button>
            )}
          </div>
          <p className="text-xs text-slate-500 mb-2">
            Select a ticket to close it manually (weigh, capture photos, then Save). Open tickets
            remain visible until closed — including tickets from previous days.
          </p>
          <ul className="text-sm space-y-1 max-h-40 overflow-y-auto">
            {openTickets.map((t) => {
              const isSelected = selectedOpenTicket?.id === t.id;
              const isPreviousDay = !isTicketFromToday(t.timestamp_in || t.created_at);
              const isStuck = isStuckOpenTicket(t);
              const ticketVehicleType = resolveVehicleType(null, t);
              const listWeight = openTicketFirstWeighKg(t, ticketVehicleType);
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => handleSelectOpenTicket(t)}
                    className={`w-full flex flex-wrap items-center justify-between gap-2 rounded-lg border px-2 py-2 text-left transition-colors ${
                      isSelected
                        ? 'border-brand-500 bg-brand-950/40 text-white'
                        : 'border-slate-700/60 bg-slate-900/30 text-slate-300 hover:border-slate-500'
                    }`}
                  >
                    <span className="font-mono text-xs">{t.slip_number}</span>
                    <span className="font-mono text-xs">{t.truck_number}</span>
                    <span className="font-mono text-xs">{fmtKg(listWeight)}</span>
                    <span className="w-full text-[10px] text-slate-500">
                      {fmtTicketDate(t.timestamp_in || t.created_at)}
                      {isPreviousDay ? ' · previous day' : ''}
                      {isStuck ? ' · needs close (stuck)' : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-4">
          <div className="card p-8 flex flex-col items-center">
            <p className="text-xs uppercase tracking-widest text-slate-400">
              {liveWeightLabel({ vehicleType, isClose: weighMode === 'CLOSE' })}
            </p>
            <p
              className={`mt-2 font-mono font-bold leading-none ${kg <= 0 ? 'text-slate-500' : 'text-white'}`}
              style={{ fontSize: 72 }}
            >
              {Number(kg).toLocaleString('en-IN')}
              <span className="text-2xl ml-2 text-slate-500">kg</span>
            </p>
            <Badge label={kg > 0 ? 'LIVE' : 'NO SIGNAL'} variant={kg > 0 ? 'success' : 'warning'} />
            {weighMode === 'CLOSE' && netPreview != null && (
              <p className="mt-3 text-sm text-brand-300">
                Net preview: <strong>{fmtKg(netPreview)}</strong>
              </p>
            )}
          </div>

          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs uppercase tracking-widest text-slate-400">RFID</h2>
              {rfidLocked && <Badge label="Tag locked" variant="warning" />}
            </div>
            {Array.isArray(rfid.readers) && rfid.readers.length > 1 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {rfid.readers.map((reader) => {
                  const status = reader.connected
                    ? 'connected'
                    : reader.reconnecting
                      ? 'waiting'
                      : 'disconnected';
                  return (
                    <div
                      key={reader.ip || reader.readerId}
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-700/60 bg-slate-900/40 px-2 py-1 text-[10px]"
                      title={reader.lastError || undefined}
                    >
                      <StatusDot status={status} showLabel={false} />
                      <span className="font-mono text-slate-400">
                        {reader.ip || reader.readerId}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {unknownTag ? (
              <div className="rounded-lg border border-red-700/50 bg-red-950/30 p-3">
                <p className="text-sm text-red-200">Unknown RFID tag</p>
                <p className="font-mono text-xs text-red-300 mt-1">{unknownTag}</p>
                <p className="mt-2 text-xs text-red-200/80">
                  Enter the vehicle number manually. If it exists in the database, its RFID will be loaded automatically.
                </p>
                <button
                  type="button"
                  className="btn-primary mt-3 w-full"
                  onClick={openManualEntryDialog}
                >
                  Enter vehicle number
                </button>
              </div>
            ) : displayTag || truckForSave ? (
              <div className="rounded-lg bg-slate-800/60 p-3 text-sm space-y-2">
                {enteredManually && (
                  <Badge label="Manual entry" variant="warning" />
                )}
                {displayTag && (
                  <>
                    {!rfidLocked && rfid.scanning && (
                      <p className="text-[10px] text-amber-400/90 uppercase tracking-widest">Scanning…</p>
                    )}
                    <div className="space-y-1">
                      <p className="text-[10px] uppercase tracking-widest text-slate-500">EPC</p>
                      <p className="font-mono text-brand-200 break-all">{displayTag}</p>
                    </div>
                  </>
                )}
                {(vehicle || truckForSave) && (
                  <>
                    <p className="text-white font-medium pt-1 border-t border-slate-700/50">
                      {vehicle?.vehicle_number || truckForSave}
                    </p>
                    {vehicle && (
                      <>
                        <p className="text-slate-400">Owner: {vehicle.owner_name || '—'}</p>
                        <p className="text-slate-400">Transporter: {vehicle.transporter || '—'}</p>
                        {vehicle.rfid_tag && !displayTag && (
                          <p className="text-slate-400">
                            RFID (from DB): <span className="font-mono text-xs">{vehicle.rfid_tag}</span>
                          </p>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {rfid.scanning ? (
                  <p className="text-slate-500 text-sm">Scanning for RFID tag…</p>
                ) : (
                  <p className="text-slate-500 text-sm">
                    Press <span className="text-slate-300 font-medium">Start RFID Scan</span> to read a tag.
                  </p>
                )}
                <div className="flex flex-col gap-2 sm:flex-row">
                  {rfid.connected && !rfidLocked && !rfid.scanning && (
                    <button type="button" className="btn-primary flex-1" onClick={handleStartRfidScan}>
                      Start RFID Scan
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-ghost flex-1 border border-slate-600"
                    onClick={openManualEntryDialog}
                  >
                    Enter vehicle manually
                  </button>
                </div>
                {!rfid.connected && (
                  <p className="text-xs text-amber-300/90">
                    RFID reader not connected
                    {rfid.readerCount > 1
                      ? ` (${rfid.connectedReaders ?? 0}/${rfid.readerCount} online).`
                      : '.'}
                  </p>
                )}
              </div>
            )}
          </div>

          {weighMode === 'OPEN' && truckForSave && (
            <div className="card p-4 space-y-3">
              <h2 className="text-xs uppercase tracking-widest text-slate-400">Ticket details</h2>
              <label className="block text-sm">
                <span className="text-slate-400">Material (optional)</span>
                <select
                  className="field-input mt-1 w-full"
                  value={material}
                  onChange={(e) => setMaterial(e.target.value)}
                >
                  <option value="">Select material…</option>
                  {materialsList.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-slate-400">Customer (optional)</span>
                <select
                  className="field-input mt-1 w-full"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                >
                  <option value="">Select customer…</option>
                  {customersList.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-slate-400">Destination (optional)</span>
                <select
                  className="field-input mt-1 w-full"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                >
                  <option value="">Select destination…</option>
                  {destinationsList.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-slate-400">Operator (optional)</span>
                <input
                  type="text"
                  className="field-input mt-1 w-full"
                  value={operatorName}
                  onChange={(e) => setOperatorName(e.target.value)}
                  placeholder="Operator name"
                  list="operator-suggestions"
                />
                <datalist id="operator-suggestions">
                  {operatorsList.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </label>
              <label className="block text-sm">
                <span className="text-slate-400">Driver (optional)</span>
                <input
                  type="text"
                  className="field-input mt-1 w-full"
                  value={driver}
                  onChange={(e) => setDriver(e.target.value)}
                  placeholder="Driver name"
                />
              </label>
            </div>
          )}

          {weighMode === 'CLOSE' && openTicket && (
            <div className="card p-4 space-y-3 text-sm">
              <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-2">Open ticket</h2>
              <Row label="Ticket" value={openTicket.slip_number} mono />
              <Row
                label={openTicketFirstWeighLabel(vehicleType)}
                value={fmtKg(openTicketFirstWeighKg(openTicket, vehicleType))}
                bold
              />
              <Row label="Arrival" value={openTicket.timestamp_in || '—'} />
              <Row label="Driver" value={openTicket.driver || '—'} />
              <div className="border-t border-slate-700 pt-3 space-y-3">
                <h3 className="text-xs uppercase tracking-widest text-slate-400">Ticket details</h3>
                <label className="block text-sm">
                  <span className="text-slate-400">Material *</span>
                  <select
                    className="field-input mt-1 w-full"
                    value={material}
                    onChange={(e) => setMaterial(e.target.value)}
                  >
                    <option value="">Select material…</option>
                    {materialsList.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="text-slate-400">Customer *</span>
                  <select
                    className="field-input mt-1 w-full"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                  >
                    <option value="">Select customer…</option>
                    {customersList.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="text-slate-400">Destination *</span>
                  <select
                    className="field-input mt-1 w-full"
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                  >
                    <option value="">Select destination…</option>
                    {destinationsList.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="text-slate-400">Operator *</span>
                  <input
                    type="text"
                    className="field-input mt-1 w-full"
                    value={operatorName}
                    onChange={(e) => setOperatorName(e.target.value)}
                    placeholder="Operator name"
                    list="operator-suggestions-close"
                  />
                  <datalist id="operator-suggestions-close">
                    {operatorsList.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </label>
              </div>
            </div>
          )}

          <div className="card p-4">
            <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-3">Progress</h2>
            <ul className="space-y-2">
              {timeline.map((entry, i) => (
                <li key={`${entry.step}-${i}`} className="flex justify-between text-sm">
                  <span className="text-emerald-300">{entry.step}</span>
                  <span className="text-xs font-mono text-slate-500">
                    {entry.at ? new Date(entry.at).toLocaleTimeString('en-IN') : '—'}
                  </span>
                </li>
              ))}
              {timeline.length === 0 && (
                <li className="text-slate-500 text-sm">Waiting for save events…</li>
              )}
            </ul>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="card p-3">
            <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-2">
              {weighMode === 'CLOSE' ? 'Departure photos (3)' : 'Arrival photos (3)'}
            </h2>
            <div
              className={`rounded-lg bg-slate-800 flex items-center justify-center overflow-hidden ${
                testConfig?.useRtspCamera && testConfig?.cameras?.length > 1 && !savedCaptureUrl
                  ? 'p-2'
                  : 'aspect-video'
              }`}
            >
              {testConfig?.useWebcamCamera ? (
                savedCaptureUrl ? (
                  <img src={savedCaptureUrl} alt="Saved capture" className="h-full w-full object-cover" />
                ) : (
                  <WebcamPreview
                    ref={webcamRef}
                    className="h-full w-full object-cover"
                    onReady={() => setWebcamReady(true)}
                  />
                )
              ) : testConfig?.useRtspCamera && !savedCaptureUrl ? (
                manualPhotoCapture && manualPhotosForPass?.snapshots?.length ? (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 w-full p-1">
                    {(configuredCameras.length ? configuredCameras : [{ id: 'cam-1', label: 'Camera 1' }])
                      .map((cam) => {
                        const snap = manualPhotosForPass.snapshots.find((s) => s.id === cam.id);
                        const failed = manualPhotosForPass.failedCameras?.find(
                          (f) => f.id === cam.id,
                        );
                        return (
                          <div key={cam.id} className="flex flex-col gap-1">
                            <div className="relative rounded-lg overflow-hidden aspect-video bg-slate-900">
                              {cam.disabled ? (
                                <div className="h-full w-full flex flex-col items-center justify-center px-2 text-center">
                                  <span className="text-xs font-semibold text-slate-500">
                                    Disabled
                                  </span>
                                  <span className="text-[9px] text-slate-600 mt-1">
                                    Not used for capture
                                  </span>
                                </div>
                              ) : snap?.path ? (
                                <LocalImage
                                  path={snap.path}
                                  cacheKey={snap.capturedAt}
                                  alt={cam.label}
                                  className="h-full w-full object-cover"
                                />
                              ) : failed ? (
                                <div className="h-full w-full flex flex-col items-center justify-center px-2 text-center">
                                  <span className="text-xs font-semibold text-red-400">
                                    Capture failed
                                  </span>
                                  <span className="text-[9px] text-slate-500 mt-1 line-clamp-3">
                                    {String(failed.error || '').split(';')[0]}
                                  </span>
                                </div>
                              ) : (
                                <div className="h-full w-full flex items-center justify-center text-xs text-slate-600">
                                  No photo
                                </div>
                              )}
                            </div>
                            <p className="text-[10px] text-slate-500 text-center truncate">
                              {cam.label}
                            </p>
                            <button
                              type="button"
                              className="btn-ghost text-xs py-1 disabled:opacity-40"
                              disabled={
                                cam.disabled || capturingPhotos || retryingCameraId === cam.id
                              }
                              onClick={() => handleRetryPhoto(cam.id)}
                            >
                              {retryingCameraId === cam.id ? 'Retrying…' : 'Retry'}
                            </button>
                          </div>
                        );
                      })}
                  </div>
                ) : manualPhotoCapture ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center">
                    <span className="text-3xl">📷</span>
                    <p className="text-slate-400 text-sm">
                      Press Capture images to take photos from all cameras.
                    </p>
                    <p className="text-slate-500 text-xs">
                      Review each photo — use Retry if grey or distorted — then Save.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center">
                    <span className="text-3xl">📷</span>
                    <p className="text-slate-400 text-sm">
                      Photos are captured from all cameras when you press Save.
                    </p>
                    <p className="text-slate-500 text-xs">
                      Use the Live Cameras tab to check feeds before saving.
                    </p>
                  </div>
                )
              ) : savedCaptureUrl ? (
                <img src={savedCaptureUrl} alt="Vehicle" className="h-full w-full object-cover" />
              ) : (
                <span className="text-slate-500 text-sm flex flex-col items-center gap-1">
                  <span className="text-2xl">📷</span> Live cameras on save
                </span>
              )}
            </div>
            {weighMode === 'CLOSE' && arrivalPhotoPaths.length > 0 && (
              <div className="mt-2 grid grid-cols-3 gap-1">
                {arrivalPhotoPaths.map((photoPath, i) => (
                  <LocalImage
                    key={photoPath}
                    path={photoPath}
                    alt={`Arrival ${i + 1}`}
                    className="rounded aspect-video object-cover bg-slate-900 w-full h-full"
                  />
                ))}
              </div>
            )}
            {testMode && (
              <p className="mt-2 text-xs text-slate-500">
                Test mode — save uses webcam snapshot if configured (set REQUIRED_PHOTOS=1).
              </p>
            )}
            {manualPhotoCapture && (
              <button
                type="button"
                className="btn-ghost mt-2 w-full text-sm disabled:opacity-40 border border-brand-600/40"
                disabled={capturingPhotos || saving || !weighMode}
                onClick={handleCaptureImages}
              >
                {capturingPhotos
                  ? `Capturing ${requiredPhotos} photo${requiredPhotos === 1 ? '' : 's'}…`
                  : manualPhotosForPass?.snapshots?.length
                    ? 'Capture images again'
                    : 'Capture images'}
              </button>
            )}
            {!testConfig?.useWebcamCamera && (
              <p className="mt-2 text-xs text-slate-500">
                {manualPhotoCapture
                  ? `Capture up to ${requiredPhotos} photo${requiredPhotos === 1 ? '' : 's'} (at least ${minPhotosToSave} required), review and retry if needed, then Save.`
                  : `Save captures ${requiredPhotos} fresh snapshot${requiredPhotos === 1 ? '' : 's'} for the report.`}
              </p>
            )}
            {saveBlockedReason && !saving && (
              <p className="mt-2 text-xs text-amber-300">{saveBlockedReason}</p>
            )}
            {saveMessage && <p className="mt-2 text-xs text-brand-300">{saveMessage}</p>}
            {rfid.scanning && (
              <p className="mt-2 text-xs text-slate-500">Scanning will stop after save.</p>
            )}
            <button
              type="button"
              className="btn-primary mt-3 w-full disabled:opacity-40"
              disabled={!canSaveTrip || saving || !weighMode}
              onClick={handleSaveTripCapture}
            >
              {saving
                ? useRtspCameras && cameraPreviewOnDemand && !manualPhotoCapture
                  ? 'Capturing photos…'
                  : 'Saving…'
                : weighMode === 'CLOSE'
                  ? 'Save & close ticket'
                  : weighMode === 'OPEN'
                    ? 'Save open ticket'
                    : 'Save'}
            </button>
          </div>

          <div className="card p-4 text-sm space-y-2">
            <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-2">Session</h2>
            <Row label="Mode" value={weighMode || '—'} />
            <Row label="Vehicle" value={truckForSave || '—'} />
            {openTicket && (
              <>
                <Row label="Ticket" value={openTicket.slip_number} mono />
                <Row
                  label={openTicketFirstWeighLabel(vehicleType)}
                  value={fmtKg(openTicketFirstWeighKg(openTicket, vehicleType))}
                />
              </>
            )}
            {weighMode === 'CLOSE' && netPreview != null && (
              <Row label="Net preview" value={fmtKg(netPreview)} bold />
            )}
          </div>

          {canAbort && (
            <button type="button" className="btn-danger w-full" onClick={() => setAbortOpen(true)}>
              {enteredManually && !rfidLocked && !displayTag
                ? 'Clear manual entry'
                : 'Cancel RFID scan'}
            </button>
          )}

        </div>
      </div>

      <ConfirmModal
        open={abortOpen}
        title={
          enteredManually && !rfidLocked && !displayTag
            ? 'Cancel manual entry?'
            : 'Cancel RFID scan?'
        }
        message={
          enteredManually && !rfidLocked && !displayTag
            ? 'This will clear the manually entered vehicle and allow a new scan or entry.'
            : weighMode === 'CLOSE' && openTicket
              ? `This will unlock the RFID tag and clear the screen. Open ticket ${openTicket.slip_number} will stay open.`
              : 'This will unlock the scanned RFID tag and allow a new scan.'
        }
        confirmLabel={
          enteredManually && !rfidLocked && !displayTag ? 'Clear entry' : 'Cancel scan'
        }
        dangerous
        onCancel={() => setAbortOpen(false)}
        onConfirm={async () => {
          try {
            await deviceAPI.stopRfidScan();
          } catch (_e) {
            /* ignore */
          }
          resetWeighScreen();
          setAbortOpen(false);
        }}
      />

      {manualEntryOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="card w-full max-w-sm p-5" role="dialog" aria-labelledby="manual-entry-title">
            <h2 id="manual-entry-title" className="text-lg font-semibold text-white">
              Enter vehicle number
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Type the full vehicle number, then press Continue.
            </p>
            <form
              className="mt-4 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                handleManualSubmit();
              }}
            >
              <input
                type="text"
                autoFocus
                value={manualTruck}
                onChange={(e) => setManualTruck(e.target.value)}
                placeholder="e.g. HR38AB1234"
                className="field-input w-full"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-ghost flex-1"
                  onClick={() => {
                    setManualEntryOpen(false);
                    setManualTruck('');
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary flex-1">
                  Continue
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            className="card w-full max-w-md max-h-[90vh] overflow-y-auto p-5"
            role="dialog"
            aria-labelledby="manual-vehicle-title"
          >
            <h2 id="manual-vehicle-title" className="text-lg font-semibold text-white">
              Register vehicle manually
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Vehicle not found in database. Enter details to continue weighment.
            </p>
            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                confirmCreateVehicle();
              }}
            >
              <ManualVehicleField
                label="Vehicle number *"
                error={manualVehicleErrors.vehicle_number}
              >
                <input
                  type="text"
                  className="field-input w-full"
                  value={manualVehicleForm.vehicle_number}
                  onChange={(e) =>
                    setManualVehicleForm((f) => ({
                      ...f,
                      vehicle_number: e.target.value,
                    }))
                  }
                />
              </ManualVehicleField>
              <ManualVehicleField label="RFID tag (optional)" error={manualVehicleErrors.rfid_tag}>
                <input
                  type="text"
                  className="field-input w-full font-mono text-sm"
                  value={manualVehicleForm.rfid_tag}
                  onChange={(e) =>
                    setManualVehicleForm((f) => ({
                      ...f,
                      rfid_tag: e.target.value,
                    }))
                  }
                  placeholder="Leave blank if unknown"
                />
              </ManualVehicleField>
              <ManualVehicleField label="Owner name *" error={manualVehicleErrors.owner_name}>
                <input
                  type="text"
                  className="field-input w-full"
                  value={manualVehicleForm.owner_name}
                  onChange={(e) =>
                    setManualVehicleForm((f) => ({ ...f, owner_name: e.target.value }))
                  }
                />
              </ManualVehicleField>
              <ManualVehicleField label="Transporter">
                <input
                  type="text"
                  className="field-input w-full"
                  value={manualVehicleForm.transporter}
                  onChange={(e) =>
                    setManualVehicleForm((f) => ({ ...f, transporter: e.target.value }))
                  }
                />
              </ManualVehicleField>
              <ManualVehicleField label="Vehicle type *" error={manualVehicleErrors.vehicle_type}>
                <select
                  className="field-input w-full"
                  value={manualVehicleForm.vehicle_type}
                  onChange={(e) =>
                    setManualVehicleForm((f) => ({ ...f, vehicle_type: e.target.value }))
                  }
                >
                  {VEHICLE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </ManualVehicleField>
              <ManualVehicleField label="Max capacity (kg)" error={manualVehicleErrors.max_capacity}>
                <input
                  type="number"
                  min="0"
                  className="field-input w-full"
                  value={manualVehicleForm.max_capacity}
                  onChange={(e) =>
                    setManualVehicleForm((f) => ({ ...f, max_capacity: e.target.value }))
                  }
                />
              </ManualVehicleField>
              {manualVehicleErrors.form && (
                <p className="text-sm text-red-400">{manualVehicleErrors.form}</p>
              )}
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  className="btn-ghost flex-1"
                  disabled={creatingVehicle}
                  onClick={() => {
                    setCreateOpen(false);
                    setManualVehicleErrors({});
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary flex-1" disabled={creatingVehicle}>
                  {creatingVehicle ? 'Saving…' : 'Save & continue'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function ManualVehicleField({ label, error, children }) {
  return (
    <label className="block text-sm">
      <span className="text-slate-400">{label}</span>
      <div className="mt-1">{children}</div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </label>
  );
}

function Row({ label, value, mono, bold }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span
        className={`${mono ? 'font-mono text-xs' : ''} ${bold ? 'text-white font-semibold' : 'text-slate-200'}`}
      >
        {value}
      </span>
    </div>
  );
}

function fmtKg(v) {
  if (v == null || Number.isNaN(v)) return '—';
  return `${Number(v).toLocaleString('en-IN')} kg`;
}

function fmtTicketDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isTicketFromToday(iso) {
  if (!iso) return true;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return true;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}
