import { create } from 'zustand';

const defaultDevices = () => ({
  rfid: {
    connected: false,
    scanning: false,
    lastTag: null,
    lastScan: null,
    lastSeen: null,
    locked: false,
    lockedTag: null,
    lastError: null,
    reconnecting: false,
    readerCount: 0,
    connectedReaders: 0,
    readers: [],
  },
  weighbridge: {
    connected: false,
    currentWeight: 0,
    rawWeight: 0,
    isStable: false,
    lastSeen: null,
  },
  camera: { connected: false, lastSeen: null },
  externalDisplay: { connected: false, enabled: false, port: null, lastSentWeight: null, lastRequestedWeight: null, lastWriteOk: true, lastWriteError: null, lastSeen: null },
  cloud: { connected: false, pendingCount: 0, lastSync: null },
});

const useDeviceStore = create((set) => ({
  ...defaultDevices(),
  displayWeight: 0,
  rawDisplayWeight: 0,
  displayStable: false,
  weightReleaseActive: false,

  updateDeviceStatus: (status) =>
    set((s) => {
      const polledWeight =
        status?.weighbridge?.currentWeight ?? s.weighbridge.currentWeight;
      const polledRaw =
        status?.weighbridge?.rawWeight ??
        status?.weighbridge?.currentWeight ??
        s.weighbridge.rawWeight;
      // Status polls can briefly read 0 between serial frames — keep last live reading.
      const keepLive =
        s.displayWeight > 0 &&
        (!Number.isFinite(polledWeight) || polledWeight <= 0);
      const nextWeight = keepLive ? s.displayWeight : polledWeight;
      const nextRawWeight = keepLive ? s.rawDisplayWeight : polledRaw;
      const nextStable =
        status?.weighbridge?.isStable ?? s.weighbridge.isStable;
      const nextReleaseActive =
        status?.weighbridge?.weightReleaseActive ?? s.weightReleaseActive;
      const hasLiveWeight =
        Number.isFinite(nextWeight) && nextWeight > 0;

      return {
        rfid: {
          ...s.rfid,
          connected: !!status?.rfid?.connected,
          scanning: !!status?.rfid?.scanning,
          mode: status?.rfid?.mode || null,
          lastSeen: status?.rfid?.lastSeen || s.rfid.lastSeen,
          lastError: status?.rfid?.lastError ?? s.rfid.lastError ?? null,
          reconnecting: !!status?.rfid?.reconnecting,
          readerCount: status?.rfid?.readerCount ?? s.rfid.readerCount ?? 0,
          connectedReaders: status?.rfid?.connectedReaders ?? s.rfid.connectedReaders ?? 0,
          readers: Array.isArray(status?.rfid?.readers)
            ? status.rfid.readers
            : s.rfid.readers,
        },
        weighbridge: {
          ...s.weighbridge,
          connected: !!status?.weighbridge?.connected,
          mode: status?.weighbridge?.mode || null,
          currentWeight: nextWeight,
          rawWeight: nextRawWeight,
          isStable: nextStable,
          lastSeen: status?.weighbridge?.lastSeen || s.weighbridge.lastSeen,
          weightReleaseActive: nextReleaseActive,
        },
        camera: {
          ...s.camera,
          connected: !!status?.camera?.connected,
          mode: status?.camera?.mode || null,
          lastSeen: status?.camera?.lastSeen || s.camera.lastSeen,
        },
        externalDisplay: {
          ...s.externalDisplay,
          connected: !!status?.externalDisplay?.connected,
          enabled: status?.externalDisplay?.enabled !== false,
          port: status?.externalDisplay?.port ?? s.externalDisplay.port,
          lastSentWeight: status?.externalDisplay?.lastSentWeight ?? s.externalDisplay.lastSentWeight,
          lastRequestedWeight:
            status?.externalDisplay?.lastRequestedWeight ?? s.externalDisplay.lastRequestedWeight,
          lastWriteOk: status?.externalDisplay?.lastWriteOk ?? s.externalDisplay.lastWriteOk,
          lastWriteError: status?.externalDisplay?.lastWriteError ?? s.externalDisplay.lastWriteError,
          lastSeen: status?.externalDisplay?.lastSeen || s.externalDisplay.lastSeen,
        },
        cloud: {
          ...s.cloud,
          connected: !!status?.cloud?.connected,
          pendingCount: status?.cloud?.pendingCount ?? s.cloud.pendingCount,
          lastSync: status?.cloud?.lastSync || s.cloud.lastSync,
        },
        displayWeight: hasLiveWeight ? nextWeight : s.displayWeight,
        rawDisplayWeight: hasLiveWeight ? nextRawWeight : s.rawDisplayWeight,
        displayStable: hasLiveWeight ? nextStable : s.displayStable,
        weightReleaseActive: nextReleaseActive,
      };
    }),

  setLastRfidTag: (tag) =>
    set((s) => ({
      rfid: {
        ...s.rfid,
        lastTag: tag,
        lastSeen: new Date().toISOString(),
      },
    })),

  setLastRfidScan: (scan) =>
    set((s) => {
      if (
        s.rfid.locked &&
        scan?.locked !== true &&
        scan?.tag &&
        scan.tag !== s.rfid.lockedTag
      ) {
        return s;
      }
      const shouldLock = scan?.locked === true;
      return {
        rfid: {
          ...s.rfid,
          lastTag: scan?.tag ?? s.rfid.lastTag,
          lastScan: scan,
          lastSeen: scan?.timestamp || new Date().toISOString(),
          locked: shouldLock ? true : s.rfid.locked,
          lockedTag: shouldLock ? scan?.tag ?? s.rfid.lockedTag : s.rfid.lockedTag,
        },
      };
    }),

  lockRfid: (tag, scan = null) =>
    set((s) => ({
      rfid: {
        ...s.rfid,
        lastTag: tag,
        lastScan: scan || { tag, ...(s.rfid.lastScan?.tag === tag ? s.rfid.lastScan : {}) },
        lastSeen: new Date().toISOString(),
        locked: true,
        lockedTag: tag,
      },
    })),

  unlockRfid: () =>
    set((s) => ({
      rfid: {
        ...s.rfid,
        locked: false,
        lockedTag: null,
      },
    })),

  setRfidScanning: (scanning) =>
    set((s) => ({
      rfid: {
        ...s.rfid,
        scanning: !!scanning,
      },
    })),

  clearRfidScan: () =>
    set((s) => ({
      rfid: {
        ...s.rfid,
        lastTag: null,
        lastScan: null,
        locked: false,
        lockedTag: null,
        scanning: false,
      },
    })),

  updateWeight: (weight, isStable, rawWeight, weightReleaseActive) =>
    set((s) => {
      const raw = rawWeight ?? weight;
      const releaseActive =
        weightReleaseActive != null
          ? !!weightReleaseActive
          : s.weightReleaseActive;
      return {
        displayWeight: weight,
        rawDisplayWeight: raw,
        displayStable: isStable,
        weightReleaseActive: releaseActive,
        weighbridge: {
          ...s.weighbridge,
          currentWeight: weight,
          rawWeight: raw,
          isStable,
          weightReleaseActive: releaseActive,
          lastSeen: new Date().toISOString(),
        },
      };
    }),
}));

export default useDeviceStore;
