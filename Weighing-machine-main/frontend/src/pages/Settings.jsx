import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  authAPI,
  backupAPI,
  deviceAPI,
  reportAPI,
  settingsAPI,
  storageAPI,
  syncAPI,
  mcgAPI,
  transactionAPI,
  subscribe,
} from '../api/ipc.js';
import RfidPowerControl from '../components/settings/RfidPowerControl.jsx';
import CameraSlotsEditor from '../components/settings/CameraSlotsEditor.jsx';
import ManualHywaClosePanel from '../components/settings/ManualHywaClosePanel.jsx';

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?!$)|$)){4}$/;

function validateKey(key, value) {
  if (key === 'RFID_IP' && value && !IPV4.test(value)) {
    return 'Enter a valid IPv4 address';
  }
  if (key === 'RFID_PORT' && value) {
    const p = Number(value);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Port must be 1–65535';
  }
  if (key === 'CAMERA_RTSP_URL' && value && !value.startsWith('rtsp://')) {
    return 'URL must start with rtsp://';
  }
  return null;
}

const AWS_SETTING_KEYS = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'AWS_S3_BUCKET',
  'CLOUD_BACKUP_INTERVAL_MINUTES',
  'CLOUD_BACKUP_ENABLED',
  'CLOUD_LOG_UPLOAD_ENABLED',
  'CLOUD_LOG_UPLOAD_INTERVAL_MINUTES',
]);

const FIELDS = {
  hardware: [
    { key: 'RFID_IP', label: 'RFID IP (single reader fallback)', type: 'text', test: 'rfid' },
    {
      key: 'RFID_IPS',
      label: 'RFID IPs (comma-separated, ETS-IR readers)',
      type: 'text',
    },
    { key: 'RFID_PORT', label: 'RFID Port (ETS-IR default 9090)', type: 'text', test: 'rfid' },
    {
      key: 'RFID_EPC_PREFIX',
      label: 'Accepted RFID EPC prefix (tag series)',
      type: 'text',
      hint: 'Only tags starting with this prefix are used (default E200). Other tags on the truck are ignored for scan, lock, and weighment.',
    },
    {
      key: 'RFID_BLOCKED_TAGS',
      label: 'Blocked RFID tags (comma-separated EPCs)',
      type: 'text',
      hint: 'Ignored for live scan, lock, and weighment. Restart the app after changing. The reader may still beep if the tag is in range — move the tag or lower antenna power.',
    },
    { key: 'WEIGHBRIDGE_COM_PORT', label: 'Weighbridge COM Port', type: 'text', test: 'weighbridge' },
    {
      key: 'WEIGHBRIDGE_BAUD_RATE',
      label: 'Baud rate',
      type: 'select',
      options: ['2400', '4800', '9600', '19200', '38400'],
      test: 'weighbridge',
    },
    {
      key: 'WEIGHBRIDGE_DATA_BITS',
      label: 'Data bits',
      type: 'select',
      options: ['7', '8'],
      test: 'weighbridge',
    },
    {
      key: 'WEIGHBRIDGE_PARITY',
      label: 'Parity',
      type: 'select',
      options: ['none', 'even', 'odd'],
      test: 'weighbridge',
    },
    {
      key: 'WEIGHBRIDGE_STOP_BITS',
      label: 'Stop bits',
      type: 'select',
      options: ['1', '2'],
      test: 'weighbridge',
    },
    {
      key: 'EXTERNAL_DISPLAY_ENABLED',
      label: 'Enable external LED display',
      type: 'toggle',
    },
    {
      key: 'EXTERNAL_DISPLAY_COM_PORT',
      label: 'External display COM port',
      type: 'text',
      test: 'externalDisplay',
    },
    {
      key: 'EXTERNAL_DISPLAY_BAUD_RATE',
      label: 'External display baud rate',
      type: 'select',
      options: ['1200', '2400', '4800', '9600', '19200'],
      test: 'externalDisplay',
    },
    {
      key: 'EXTERNAL_DISPLAY_DATA_BITS',
      label: 'External display data bits',
      type: 'select',
      options: ['7', '8'],
      test: 'externalDisplay',
    },
    {
      key: 'EXTERNAL_DISPLAY_PARITY',
      label: 'External display parity',
      type: 'select',
      options: ['none', 'even', 'odd'],
      test: 'externalDisplay',
    },
    {
      key: 'EXTERNAL_DISPLAY_STOP_BITS',
      label: 'External display stop bits',
      type: 'select',
      options: ['1', '2'],
      test: 'externalDisplay',
    },
    {
      key: 'EXTERNAL_DISPLAY_CHANNEL',
      label: 'Display channel (1–9)',
      type: 'number',
    },
    { key: 'EXTERNAL_DISPLAY_COMMAND', label: 'Display write command (ws1 only)', type: 'text' },
    {
      key: 'EXTERNAL_DISPLAY_PROTOCOL',
      label: 'Display protocol',
      type: 'select',
      options: [
        { v: 'signed', l: 'TW5+150KD signed (+000060)' },
        { v: 'ws1', l: 'Legacy WS1 (other boards)' },
      ],
    },
    {
      key: 'EXTERNAL_DISPLAY_CHECKSUM_MODE',
      label: 'Display checksum (signed only)',
      type: 'select',
      options: [
        { v: 'none', l: 'None (00 00 00)' },
        { v: 'xor', l: 'XOR byte' },
      ],
    },
    {
      key: 'EXTERNAL_DISPLAY_DECIMAL_PLACES',
      label: 'Display decimal places',
      type: 'select',
      options: ['0', '1', '2', '3', '4'],
    },
    { key: 'CAMERA_RTSP_URL', label: 'Primary camera RTSP URL', type: 'text', test: 'camera' },
  ],
  cloud: [
    { key: 'CLOUD_SYNC_URL', label: 'Cloud API URL', type: 'text' },
    { key: 'CLOUD_SYNC_TOKEN', label: 'API Token', type: 'password' },
    {
      key: 'SYNC_INTERVAL_SECONDS',
      label: 'Sync interval',
      type: 'select',
      options: [
        { v: '30', l: '30 seconds' },
        { v: '60', l: '1 minute' },
        { v: '300', l: '5 minutes' },
      ],
    },
  ],
  mcg: [
    { key: 'MCG_PORTAL_ENABLED', label: 'Enable MCG portal POST on ticket close', type: 'toggle' },
    { key: 'MCG_PORTAL_URL', label: 'MCG API URL', type: 'text' },
    { key: 'MCG_PORTAL_API_KEY', label: 'MCG API Key (X-API-Key)', type: 'password' },
    { key: 'MCG_PORTAL_TEST_MODE', label: 'Test mode (send TESTING for all string fields)', type: 'toggle' },
  ],
  app: [
    {
      key: 'LOG_LEVEL',
      label: 'Log level',
      type: 'select',
      options: ['info', 'warn', 'error', 'debug'],
    },
    { key: 'AUTO_BACKUP', label: 'Auto local backup', type: 'toggle' },
    { key: 'CLOUD_BACKUP_ENABLED', label: 'Auto cloud backup (S3)', type: 'toggle' },
    { key: 'CLOUD_LOG_UPLOAD_ENABLED', label: 'Auto log upload to S3', type: 'toggle' },
    {
      key: 'BACKUP_INTERVAL_HOURS',
      label: 'Backup interval',
      type: 'select',
      options: [
        { v: '2', l: '2 hours' },
        { v: '4', l: '4 hours' },
        { v: '8', l: '8 hours' },
        { v: '24', l: '24 hours' },
      ],
    },
    { key: 'IMAGE_AUTO_CLEANUP', label: 'Auto image cleanup', type: 'toggle' },
    { key: 'IMAGE_RETENTION_DAYS', label: 'Delete images older than (days)', type: 'number' },
  ],
  s3: [
    { key: 'AWS_ACCESS_KEY_ID', label: 'AWS Access Key ID', type: 'text' },
    { key: 'AWS_SECRET_ACCESS_KEY', label: 'AWS Secret Access Key', type: 'password' },
    { key: 'AWS_REGION', label: 'AWS Region', type: 'text' },
    { key: 'AWS_S3_BUCKET', label: 'S3 Bucket name', type: 'text' },
    {
      key: 'CLOUD_BACKUP_INTERVAL_MINUTES',
      label: 'Cloud backup interval',
      type: 'select',
      options: [
        { v: '15', l: '15 minutes' },
        { v: '30', l: '30 minutes' },
        { v: '60', l: '1 hour' },
        { v: '120', l: '2 hours' },
        { v: '240', l: '4 hours' },
      ],
    },
    {
      key: 'CLOUD_LOG_UPLOAD_INTERVAL_MINUTES',
      label: 'Log upload interval',
      type: 'select',
      options: [
        { v: '15', l: '15 minutes' },
        { v: '30', l: '30 minutes' },
        { v: '60', l: '1 hour' },
        { v: '120', l: '2 hours' },
      ],
    },
  ],
  advance: [
    { key: 'WEIGHT_ADJUSTMENT_ENABLED', label: 'Enable weight increase', type: 'toggle' },
    { key: 'WEIGHT_OFFSET_KG', label: 'Increase loaded truck weight by (kg)', type: 'number' },
  ],
  printer: [
    { key: 'PRINTER_NAME', label: 'Default printer', type: 'text' },
    {
      key: 'PAPER_SIZE',
      label: 'Paper size',
      type: 'select',
      options: ['A4', 'Thermal 80mm'],
    },
  ],
};

export default function Settings() {
  const [values, setValues] = useState({});
  const [errors, setErrors] = useState({});
  const [saved, setSaved] = useState(false);
  const [tests, setTests] = useState({});
  const [testErrors, setTestErrors] = useState({});
  const [portProbe, setPortProbe] = useState(null);
  const [portProbeBusy, setPortProbeBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [showMcgKey, setShowMcgKey] = useState(false);
  const [mcgBusy, setMcgBusy] = useState(false);
  const [mcgMessage, setMcgMessage] = useState(null);
  const [showAwsSecret, setShowAwsSecret] = useState(false);
  const [queue, setQueue] = useState({ pending: 0 });
  const [backups, setBackups] = useState([]);
  const [lastBackup, setLastBackup] = useState(null);
  const [storage, setStorage] = useState(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [cloudStatus, setCloudStatus] = useState(null);
  const [cloudProgress, setCloudProgress] = useState(null);
  const [cloudMessage, setCloudMessage] = useState(null);
  const [remoteBackups, setRemoteBackups] = useState([]);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [thermalQueue, setThermalQueue] = useState([]);
  const [advanceUnlocked, setAdvanceUnlocked] = useState(false);
  const [adminPin, setAdminPin] = useState('');
  const [advanceError, setAdvanceError] = useState('');
  const [advanceMessage, setAdvanceMessage] = useState('');
  const timers = useRef({});

  const refreshBackup = useCallback(async () => {
    const [list, last, cloud] = await Promise.all([
      backupAPI.getList(),
      backupAPI.getLastBackupTime(),
      backupAPI.getCloudStatus().catch(() => null),
    ]);
    setBackups(Array.isArray(list) ? list : []);
    setLastBackup(last);
    setCloudStatus(cloud);
  }, []);

  const refreshRemoteBackups = useCallback(async () => {
    const list = await backupAPI.listRemoteBackups();
    setRemoteBackups(Array.isArray(list) ? list : []);
  }, []);

  const refreshStorage = useCallback(async () => {
    const stats = await storageAPI.getStorageStats();
    setStorage(stats);
    const tq = await storageAPI.listThermalQueue();
    setThermalQueue(Array.isArray(tq) ? tq : []);
  }, []);

  useEffect(() => {
    settingsAPI.getAll().then((all) => setValues(all || {})).catch(console.error);
    syncAPI.getQueueStatus().then(setQueue).catch(() => {});
    refreshBackup().catch(console.error);
    refreshStorage().catch(console.error);
  }, [refreshBackup, refreshStorage]);

  useEffect(() => {
    const off = [
      subscribe('cloudBackup:progress', (p) => setCloudProgress(p?.detail || p?.step || '')),
      subscribe('cloudBackup:complete', (p) => {
        setCloudProgress(null);
        setCloudMessage(
          p?.skipped
            ? 'No internet — backup queued for next cycle'
            : 'Cloud backup completed successfully',
        );
        refreshBackup();
      }),
      subscribe('cloudBackup:failed', (p) => {
        setCloudProgress(null);
        setCloudMessage(p?.message || 'Cloud backup failed — see logs/backup.log');
      }),
    ];
    return () => off.forEach((fn) => fn && fn());
  }, [refreshBackup]);

  const scheduleSave = useCallback((key, value) => {
    const err = validateKey(key, value);
    if (err) {
      setErrors((e) => ({ ...e, [key]: err }));
      return;
    }
    setErrors((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });

    if (timers.current[key]) clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(async () => {
      try {
        await settingsAPI.set(key, value);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        if (AWS_SETTING_KEYS.has(key)) {
          refreshBackup().catch(console.error);
        }
      } catch (e) {
        setErrors((er) => ({ ...er, [key]: e.message }));
      }
    }, 500);
  }, [refreshBackup]);

  function update(key, value) {
    setValues((v) => ({ ...v, [key]: value }));
    scheduleSave(key, value);
    if (key === 'WEIGHT_ADJUSTMENT_ENABLED') {
      setAdvanceMessage(
        value === 'true'
          ? 'Weight increase enabled — applies on next scale reading'
          : 'Weight increase disabled — using live scale weight',
      );
      setTimeout(() => setAdvanceMessage(''), 4000);
    }
  }

  async function unlockAdvanceSetting() {
    setAdvanceError('');
    try {
      const result = await authAPI.verifyPin(adminPin);
      if (!result?.ok) {
        setAdvanceError(result?.error || 'Invalid admin PIN');
        return;
      }
      setAdvanceUnlocked(true);
      setAdminPin('');
      const keys = FIELDS.advance.map((f) => f.key);
      const loaded = {};
      await Promise.all(
        keys.map(async (key) => {
          loaded[key] = await settingsAPI.get(key);
        }),
      );
      setValues((v) => ({ ...v, ...loaded }));
    } catch (e) {
      setAdvanceError(e.message || 'Unlock failed');
    }
  }

  async function lockAdvanceSetting() {
    try {
      await authAPI.lockAdvanced();
      await authAPI.lockManualHywaClose();
    } catch (_e) {
      /* ignore */
    }
    setAdvanceUnlocked(false);
    setAdminPin('');
    setAdvanceError('');
    setValues((v) => {
      const next = { ...v };
      for (const f of FIELDS.advance) {
        delete next[f.key];
      }
      return next;
    });
  }

  async function testDevice(type) {
    setTests((t) => ({ ...t, [type]: 'loading' }));
    setTestErrors((e) => ({ ...e, [type]: '' }));
    try {
      const r = await deviceAPI.testConnection(type);
      setTests((t) => ({ ...t, [type]: r?.ok ? 'ok' : 'fail' }));
      if (r?.message) {
        setTestErrors((e) => ({ ...e, [type]: r.message }));
      } else if (!r?.ok && r?.error) {
        setTestErrors((e) => ({ ...e, [type]: r.error }));
      } else if (r?.ok && r?.bytesReceived != null) {
        setTestErrors((e) => ({ ...e, [type]: `${r.bytesReceived} bytes received` }));
      }
    } catch (err) {
      setTests((t) => ({ ...t, [type]: 'fail' }));
      setTestErrors((e) => ({ ...e, [type]: err?.message || 'Connection test failed' }));
    }
  }

  async function probeScalePorts() {
    setPortProbeBusy(true);
    setPortProbe(null);
    try {
      const r = await deviceAPI.probeWeighbridgePorts();
      setPortProbe(r);
    } catch (err) {
      setPortProbe({ ok: false, error: err?.message || 'Port probe failed' });
    } finally {
      setPortProbeBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Settings</h1>
          <p className="mt-1 text-sm text-slate-400">Hardware, cloud, and application preferences</p>
        </div>
        {saved && (
          <span className="text-xs text-emerald-400 border border-emerald-700/40 rounded-full px-3 py-1">
            Saved
          </span>
        )}
      </header>

      <Card title="Hardware configuration">
        <p className="text-xs text-slate-500 mb-3 font-mono">
          Scale: {values.WEIGHBRIDGE_COM_PORT || '—'} @ {values.WEIGHBRIDGE_BAUD_RATE || '—'}{' '}
          {values.WEIGHBRIDGE_DATA_BITS || '8'}
          {values.WEIGHBRIDGE_PARITY === 'none' ? 'N' : values.WEIGHBRIDGE_PARITY?.[0]?.toUpperCase() || 'N'}
          {values.WEIGHBRIDGE_STOP_BITS || '1'}
          {' · '}
          Display: {values.EXTERNAL_DISPLAY_COM_PORT || '—'} @{' '}
          {values.EXTERNAL_DISPLAY_BAUD_RATE || '—'}{' '}
          {values.EXTERNAL_DISPLAY_DATA_BITS || '8'}
          {values.EXTERNAL_DISPLAY_PARITY === 'none'
            ? 'N'
            : values.EXTERNAL_DISPLAY_PARITY?.[0]?.toUpperCase() || 'N'}
          {values.EXTERNAL_DISPLAY_STOP_BITS || '1'}
        </p>
        {FIELDS.hardware.map((f) => (
          <React.Fragment key={f.key}>
            {f.key === 'CAMERA_RTSP_URL' && (
              <div className="mb-4 rounded-lg border border-slate-700/40 p-3">
                <p className="text-sm text-slate-300 font-medium mb-2">Cameras (photo capture)</p>
                <CameraSlotsEditor
                  urlsValue={values.CAMERA_RTSP_URLS ?? ''}
                  onChange={(v) => update('CAMERA_RTSP_URLS', v)}
                />
              </div>
            )}
            <SettingRow
              field={f}
              value={values[f.key] ?? ''}
              error={errors[f.key]}
              onChange={(v) => update(f.key, v)}
              testState={tests[f.test]}
              testError={f.test ? testErrors[f.test] : ''}
              onTest={() => testDevice(f.test)}
              showTest={
                f.key === 'RFID_IP' ||
                f.key === 'WEIGHBRIDGE_COM_PORT' ||
                f.key === 'EXTERNAL_DISPLAY_COM_PORT' ||
                f.key === 'CAMERA_RTSP_URL'
              }
            />
            {f.key === 'WEIGHBRIDGE_STOP_BITS' && (
              <div className="mb-4 rounded-lg border border-slate-700/60 p-3">
                <p className="text-xs text-slate-400 mb-2">
                  Scale: {values.WEIGHBRIDGE_COM_PORT || '—'} · Display:{' '}
                  {values.EXTERNAL_DISPLAY_COM_PORT || '—'}. Put weight on the bridge, then
                  detect (scans baud rates on the open port) or use Test on the weighbridge
                  field above.
                </p>
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  disabled={portProbeBusy}
                  onClick={probeScalePorts}
                >
                  {portProbeBusy ? 'Listening…' : 'Detect scale port (scans baud rates)'}
                </button>
                {portProbe?.active?.length > 0 && (
                  <ul className="mt-2 text-xs text-emerald-400 font-mono space-y-1">
                    {portProbe.active.map((row) => (
                      <li key={`${row.path}-${row.baudRate}-${row.dataBits}`}>
                        {row.path} @ {row.baudRate} {row.dataBits}
                        {row.parity === 'none' ? 'N' : row.parity?.[0] || 'N'}
                        {row.stopBits} — {row.bytes} bytes
                        {row.sampleText ? ` · "${row.sampleText.trim()}"` : ''}
                      </li>
                    ))}
                  </ul>
                )}
                {portProbe?.message && (
                  <p
                    className={`mt-2 text-xs ${portProbe.active?.length ? 'text-slate-400' : 'text-amber-400'}`}
                  >
                    {portProbe.message}
                  </p>
                )}
                {portProbe && !portProbeBusy && !portProbe.active?.length && !portProbe.message && (
                  <p className="mt-2 text-xs text-amber-400">
                    {portProbe.error ||
                      `No serial data on ${values.WEIGHBRIDGE_COM_PORT || 'weighbridge port'}. If both COM3 and COM4 show zero bytes, the scale RS232 output may not be connected to either USB adapter — check the indicator's serial/printer port cable.`}
                  </p>
                )}
              </div>
            )}
            {f.key === 'WEIGHBRIDGE_STOP_BITS' && (
              <div className="mb-4 rounded-lg border border-amber-700/40 bg-amber-950/20 p-3">
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <div>
                    <p className="text-sm text-slate-200">Weighbridge test mode</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Use dummy scale weight instead of the serial port. Save settings and restart
                      devices to apply.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-brand-500"
                    checked={
                      values.USE_MOCK_WEIGHBRIDGE === 'true' ||
                      values.USE_MOCK_WEIGHBRIDGE === true
                    }
                    onChange={(e) => update('USE_MOCK_WEIGHBRIDGE', e.target.checked ? 'true' : 'false')}
                  />
                </label>
                {(values.USE_MOCK_WEIGHBRIDGE === 'true' || values.USE_MOCK_WEIGHBRIDGE === true) && (
                  <label className="mt-3 block text-sm">
                    <span className="text-slate-400">Test weight (kg)</span>
                    <input
                      type="number"
                      min={0}
                      step={100}
                      className="field-input mt-1 w-full"
                      value={values.SIMULATE_WEIGHT_KG ?? ''}
                      onChange={(e) => update('SIMULATE_WEIGHT_KG', e.target.value)}
                      placeholder="e.g. 15000"
                    />
                    <p className="text-xs text-slate-500 mt-1">
                      Shown on the weighment screen and external display while test mode is on.
                    </p>
                  </label>
                )}
              </div>
            )}
            {f.key === 'EXTERNAL_DISPLAY_DECIMAL_PLACES' && (
              <div className="mb-3 flex items-center gap-2">
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  disabled={tests.externalDisplay === 'loading'}
                  onClick={async () => {
                    setTests((t) => ({ ...t, externalDisplay: 'loading' }));
                    setTestErrors((e) => ({ ...e, externalDisplay: '' }));
                    try {
                      const r = await deviceAPI.testExternalDisplay(1234);
                      setTests((t) => ({ ...t, externalDisplay: r?.ok ? 'ok' : 'fail' }));
                      if (!r?.ok) {
                        setTestErrors((e) => ({
                          ...e,
                          externalDisplay: r?.error || 'Display test failed',
                        }));
                      }
                    } catch (err) {
                      setTests((t) => ({ ...t, externalDisplay: 'fail' }));
                      setTestErrors((e) => ({
                        ...e,
                        externalDisplay: err?.message || 'Display test failed',
                      }));
                    }
                  }}
                >
                  Test display (1234)
                </button>
                {tests.externalDisplay === 'ok' && (
                  <span className="text-emerald-400 text-xs">Sent to LED</span>
                )}
                {tests.externalDisplay === 'fail' && (
                  <span className="text-red-400 text-xs">Failed</span>
                )}
                {testErrors.externalDisplay && (
                  <span className="text-amber-400 text-xs">{testErrors.externalDisplay}</span>
                )}
              </div>
            )}
            {f.key === 'RFID_PORT' && (
              <RfidPowerControl
                mockMode={false}
                savedPower={values.RFID_ANTENNA_POWER}
                onSaved={(v) => {
                  setValues((prev) => ({ ...prev, RFID_ANTENNA_POWER: v }));
                  setSaved(true);
                  setTimeout(() => setSaved(false), 2000);
                }}
              />
            )}
          </React.Fragment>
        ))}
      </Card>

      <Card title="Materials (open ticket dropdown)">
        <OptionListEditor load={settingsAPI.getMaterials} save={settingsAPI.setMaterials} emptyLabel="No materials configured yet." addPlaceholder="Add material…" />
        <p className="text-xs text-slate-500 mt-3">
          Materials appear on the weigh screen when opening a ticket. Configure cameras above
          (enable Camera 2 and set its IP when needed).
        </p>
      </Card>

      <Card title="Customers (open ticket dropdown)">
        <OptionListEditor load={settingsAPI.getCustomers} save={settingsAPI.setCustomers} emptyLabel="No customers configured yet." addPlaceholder="Add customer…" />
      </Card>

      <Card title="Destinations (open ticket dropdown)">
        <OptionListEditor load={settingsAPI.getDestinations} save={settingsAPI.setDestinations} emptyLabel="No destinations configured yet." addPlaceholder="Add destination…" />
      </Card>

      <Card title="Operators (weigh screen suggestions)">
        <OptionListEditor load={settingsAPI.getOperators} save={settingsAPI.setOperators} emptyLabel="No operators configured yet." addPlaceholder="Add operator…" />
        <p className="text-xs text-slate-500 mt-3">
          Operator names appear as suggestions on the weigh screen. The operator can also type a name manually.
        </p>
      </Card>

      <Card title="Cloud sync">
        {FIELDS.cloud.map((f) => {
          if (f.key === 'CLOUD_SYNC_TOKEN') {
            return (
              <label key={f.key} className="block text-sm mb-3">
                <span className="text-slate-400">{f.label}</span>
                <div className="mt-1 flex gap-2">
                  <input
                    type={showToken ? 'text' : 'password'}
                    className="field-input flex-1"
                    value={values[f.key] ?? ''}
                    onChange={(e) => update(f.key, e.target.value)}
                  />
                  <button type="button" className="btn-ghost text-xs" onClick={() => setShowToken((s) => !s)}>
                    {showToken ? 'Hide' : 'Show'}
                  </button>
                </div>
                {errors[f.key] && <p className="text-xs text-red-400 mt-1">{errors[f.key]}</p>}
              </label>
            );
          }
          return (
            <SettingRow
              key={f.key}
              field={f}
              value={values[f.key] ?? ''}
              error={errors[f.key]}
              onChange={(v) => update(f.key, v)}
            />
          );
        })}
        <div className="flex items-center gap-3 mt-2 text-sm text-slate-400">
          <button type="button" className="btn-primary" onClick={() => syncAPI.triggerManualSync()}>
            Manual sync now
          </button>
          <span>Pending: {queue.pending ?? 0}</span>
        </div>
      </Card>

      <Card title="MCG Portal">
        <p className="text-xs text-slate-500 mb-3">
          Posts closed-ticket data to the Austere WeightBridge API when a vehicle goes out (gross
          weighment). Does not run on open/tare tickets.
        </p>
        {FIELDS.mcg.map((f) => {
          if (f.key === 'MCG_PORTAL_API_KEY') {
            return (
              <label key={f.key} className="block text-sm mb-3">
                <span className="text-slate-400">{f.label}</span>
                <div className="mt-1 flex gap-2">
                  <input
                    type={showMcgKey ? 'text' : 'password'}
                    className="field-input flex-1"
                    value={values[f.key] ?? ''}
                    onChange={(e) => update(f.key, e.target.value)}
                  />
                  <button type="button" className="btn-ghost text-xs" onClick={() => setShowMcgKey((s) => !s)}>
                    {showMcgKey ? 'Hide' : 'Show'}
                  </button>
                </div>
                {errors[f.key] && <p className="text-xs text-red-400 mt-1">{errors[f.key]}</p>}
              </label>
            );
          }
          return (
            <SettingRow
              key={f.key}
              field={f}
              value={values[f.key] ?? ''}
              error={errors[f.key]}
              onChange={(v) => update(f.key, v)}
            />
          );
        })}
        <div className="flex flex-wrap items-center gap-3 mt-2 text-sm text-slate-400">
          <button
            type="button"
            className="btn-primary"
            disabled={
              mcgBusy ||
              values.MCG_PORTAL_ENABLED !== 'true' ||
              !values.MCG_PORTAL_URL ||
              !values.MCG_PORTAL_API_KEY
            }
            onClick={async () => {
              setMcgBusy(true);
              setMcgMessage(null);
              try {
                const r = await mcgAPI.testPost();
                if (r?.ok) {
                  setMcgMessage(r.data?.message || 'MCG test POST succeeded');
                } else {
                  setMcgMessage(r?.error || `MCG test POST failed (${r?.status || 'error'})`);
                }
              } catch (e) {
                setMcgMessage(e.message || 'MCG test POST failed');
              } finally {
                setMcgBusy(false);
              }
            }}
          >
            {mcgBusy ? 'Posting…' : 'Test MCG POST'}
          </button>
          <span>
            Status:{' '}
            <span
              className={
                values.MCG_PORTAL_ENABLED === 'true' && values.MCG_PORTAL_URL && values.MCG_PORTAL_API_KEY
                  ? 'text-emerald-400'
                  : 'text-amber-400'
              }
            >
              {values.MCG_PORTAL_ENABLED === 'true' && values.MCG_PORTAL_URL && values.MCG_PORTAL_API_KEY
                ? 'Ready'
                : 'Not configured'}
            </span>
          </span>
        </div>
        {mcgMessage && <p className="text-xs text-slate-300 mt-2">{mcgMessage}</p>}
      </Card>

      <Card title="Application">
        {FIELDS.app.map((f) => (
          <SettingRow
            key={f.key}
            field={f}
            value={values[f.key] ?? ''}
            error={errors[f.key]}
            onChange={(v) => update(f.key, v)}
          />
        ))}

        <div className="mt-4 pt-4 border-t border-slate-800 space-y-3 text-sm">
          <h3 className="text-slate-300 font-medium">Local database backup</h3>
          <p className="text-slate-400">
            Last local backup:{' '}
            <span className="text-slate-200">
              {lastBackup ? new Date(lastBackup).toLocaleString('en-IN') : 'Never'}
            </span>
          </p>
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={backupBusy}
            onClick={async () => {
              setBackupBusy(true);
              try {
                await backupAPI.manualLocalBackup();
                await refreshBackup();
                setCloudMessage('Local backup saved');
              } catch (e) {
                alert(e.message);
              } finally {
                setBackupBusy(false);
              }
            }}
          >
            {backupBusy ? 'Working…' : 'Local backup now'}
          </button>
          {backups.length > 0 && (
            <ul className="max-h-32 overflow-auto rounded border border-slate-800 divide-y divide-slate-800">
              {backups.slice(0, 8).map((b) => (
                <li key={b.filename} className="flex justify-between px-3 py-2 text-xs">
                  <span className="font-mono text-slate-300">{b.filename}</span>
                  <span className="text-slate-500">
                    {formatBytes(b.size)} · {new Date(b.created_at).toLocaleDateString('en-IN')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-slate-800 space-y-3 text-sm">
          <h3 className="text-slate-300 font-medium">Cloud backup (AWS S3)</h3>
          <p className="text-slate-400 text-xs">
            Uploads database (gzip), reports, and images when internet is available. Enter your AWS
            credentials below — settings are saved on this computer.
          </p>
          {FIELDS.s3.map((f) => {
            if (f.key === 'AWS_SECRET_ACCESS_KEY') {
              return (
                <label key={f.key} className="block text-sm mb-3">
                  <span className="text-slate-400">{f.label}</span>
                  <div className="mt-1 flex gap-2">
                    <input
                      type={showAwsSecret ? 'text' : 'password'}
                      className="field-input flex-1"
                      value={values[f.key] ?? ''}
                      onChange={(e) => update(f.key, e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={() => setShowAwsSecret((s) => !s)}
                    >
                      {showAwsSecret ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  {errors[f.key] && <p className="text-xs text-red-400 mt-1">{errors[f.key]}</p>}
                </label>
              );
            }
            return (
              <SettingRow
                key={f.key}
                field={f}
                value={values[f.key] ?? ''}
                error={errors[f.key]}
                onChange={(v) => update(f.key, v)}
              />
            );
          })}
          {cloudStatus && (
            <p className="text-slate-400">
              S3:{' '}
              <span className={cloudStatus.configured ? 'text-emerald-400' : 'text-amber-400'}>
                {cloudStatus.configured ? 'Configured' : 'Not configured'}
              </span>
              {cloudStatus.configured && (
                <>
                  {' '}
                  · Pending uploads: <span className="text-slate-200">{cloudStatus.pending ?? 0}</span>
                  {cloudStatus.lastCloudBackup && (
                    <>
                      {' '}
                      · Last cloud backup:{' '}
                      <span className="text-slate-200">
                        {new Date(cloudStatus.lastCloudBackup).toLocaleString('en-IN')}
                      </span>
                    </>
                  )}
                </>
              )}
            </p>
          )}
          {cloudProgress && (
            <p className="text-xs text-brand-300 animate-pulse">{cloudProgress}</p>
          )}
          {cloudMessage && !cloudProgress && (
            <p className="text-xs text-slate-300">{cloudMessage}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={backupBusy || !cloudStatus?.configured}
              onClick={async () => {
                setBackupBusy(true);
                setCloudMessage(null);
                setCloudProgress('Starting cloud backup…');
                try {
                  const r = await backupAPI.manualBackup();
                  if (r?.skipped) {
                    setCloudMessage('No internet — will retry automatically');
                  } else if (r?.ok === false) {
                    setCloudMessage(r.error || r.reason || 'Backup failed');
                  }
                  await refreshBackup();
                } catch (e) {
                  setCloudMessage(e.message);
                } finally {
                  setBackupBusy(false);
                  setCloudProgress(null);
                }
              }}
            >
              {backupBusy ? 'Backing up…' : 'Backup now'}
            </button>
            <button
              type="button"
              className="btn-ghost text-xs"
              disabled={restoreBusy || !cloudStatus?.configured}
              onClick={async () => {
                setShowRestore(true);
                setRestoreBusy(true);
                try {
                  await refreshRemoteBackups();
                } catch (e) {
                  alert(e.message);
                } finally {
                  setRestoreBusy(false);
                }
              }}
            >
              Restore backup
            </button>
          </div>
          {showRestore && (
            <div className="rounded border border-slate-700 bg-slate-900/50 p-3 space-y-2">
              <p className="text-xs text-slate-400">
                Select a database backup from S3. The app will restart after restore.
              </p>
              {remoteBackups.length === 0 ? (
                <p className="text-xs text-slate-500">No remote backups found (check internet / AWS).</p>
              ) : (
                <ul className="max-h-40 overflow-auto divide-y divide-slate-800">
                  {remoteBackups.map((b) => (
                    <li key={b.key} className="flex justify-between items-center gap-2 py-2 text-xs">
                      <span className="font-mono text-slate-300 truncate">{b.filename}</span>
                      <button
                        type="button"
                        className="text-brand-300 shrink-0"
                        disabled={restoreBusy}
                        onClick={async () => {
                          if (
                            !window.confirm(
                              `Restore ${b.filename}? Current database will be replaced and the app will restart.`,
                            )
                          ) {
                            return;
                          }
                          setRestoreBusy(true);
                          try {
                            await backupAPI.restoreBackup(b.key);
                          } catch (e) {
                            alert(e.message);
                            setRestoreBusy(false);
                          }
                        }}
                      >
                        Restore
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => setShowRestore(false)}
              >
                Close
              </button>
            </div>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-slate-800 space-y-2 text-sm">
          <h3 className="text-slate-300 font-medium">Storage</h3>
          {storage && (
            <p className="text-slate-400">
              {storage.totalImages} images · {formatBytes(storage.totalSizeBytes)}
              {storage.oldestDate && (
                <span>
                  {' '}
                  · oldest {new Date(storage.oldestDate).toLocaleDateString('en-IN')}
                </span>
              )}
            </p>
          )}
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={async () => {
              const r = await storageAPI.runCleanup();
              alert(`Removed ${r.deleted} image(s)`);
              refreshStorage();
            }}
          >
            Run cleanup now
          </button>
        </div>

        {thermalQueue.length > 0 && (
          <div className="mt-4 pt-4 border-t border-slate-800">
            <h3 className="text-sm text-slate-300 font-medium mb-2">Thermal print queue</h3>
            <ul className="space-y-1 text-xs">
              {thermalQueue.map((f) => (
                <li key={f.filename} className="flex justify-between gap-2">
                  <span className="font-mono text-slate-400 truncate">{f.filename}</span>
                  <button
                    type="button"
                    className="text-brand-300 shrink-0"
                    onClick={() =>
                      storageAPI.resendThermal(f.filename).catch((e) => alert(e.message))
                    }
                  >
                    Resend
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title="Advance Setting">
        {!advanceUnlocked ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 max-w-xs">
              <input
                type="password"
                className="field-input flex-1 text-sm"
                value={adminPin}
                onChange={(e) => setAdminPin(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && unlockAdvanceSetting()}
                aria-label="Admin PIN"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className="btn-ghost text-xs shrink-0" onClick={unlockAdvanceSetting}>
                Unlock
              </button>
            </div>
            {advanceError && <p className="text-xs text-red-400">{advanceError}</p>}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-emerald-400/90 mb-2">Unlocked — admin session active</p>
            {FIELDS.advance.map((f) => (
              <SettingRow
                key={f.key}
                field={f}
                value={values[f.key] ?? ''}
                error={errors[f.key]}
                onChange={(v) => update(f.key, v)}
              />
            ))}
            
            {advanceMessage && (
              <p className="text-xs text-brand-300 mt-2">{advanceMessage}</p>
            )}
            <ManualHywaClosePanel />
            <button type="button" className="btn-ghost mt-3 text-sm" onClick={lockAdvanceSetting}>
              Lock section
            </button>
          </div>
        )}
      </Card>

      <Card title="Printer">
        {FIELDS.printer.map((f) => (
          <SettingRow
            key={f.key}
            field={f}
            value={values[f.key] ?? ''}
            error={errors[f.key]}
            onChange={(v) => update(f.key, v)}
          />
        ))}
        <button
          type="button"
          className="btn-ghost mt-2"
          onClick={async () => {
            try {
              const rows = await transactionAPI.getAll();
              const latest = rows?.[0];
              if (!latest) {
                alert('No transactions to print');
                return;
              }
              await reportAPI.reprintSlip(latest.id);
              alert('Test slip sent to printer queue');
            } catch (e) {
              alert(e.message);
            }
          }}
        >
          Print test slip
        </button>
      </Card>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-white mb-4">{title}</h2>
      {children}
    </section>
  );
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function OptionListEditor({ load, save, emptyLabel, addPlaceholder }) {
  const [items, setItems] = useState([]);
  const [newItem, setNewItem] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    load().then(setItems).catch(() => setItems([]));
  }, []);

  async function persist(next) {
    setBusy(true);
    try {
      const saved = await save(next);
      setItems(saved);
      setMsg('Saved');
      setTimeout(() => setMsg(''), 2000);
    } catch (e) {
      setMsg(e.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  function addItem() {
    const label = newItem.trim();
    if (!label || items.includes(label)) return;
    const next = [...items, label];
    setNewItem('');
    persist(next);
  }

  function removeItem(label) {
    persist(items.filter((m) => m !== label));
  }

  return (
    <div className="space-y-2">
      <ul className="space-y-1">
        {items.map((m) => (
          <li key={m} className="flex items-center justify-between text-sm text-slate-300">
            <span>{m}</span>
            <button
              type="button"
              className="text-xs text-red-400 hover:text-red-300"
              disabled={busy}
              onClick={() => removeItem(m)}
            >
              Remove
            </button>
          </li>
        ))}
        {items.length === 0 && (
          <li className="text-sm text-slate-500">{emptyLabel}</li>
        )}
      </ul>
      <div className="flex gap-2 mt-2">
        <input
          type="text"
          className="field-input flex-1 text-sm"
          placeholder={addPlaceholder}
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addItem()}
        />
        <button type="button" className="btn-primary text-sm shrink-0" disabled={busy} onClick={addItem}>
          Add
        </button>
      </div>
      {msg && <p className="text-xs text-brand-300">{msg}</p>}
    </div>
  );
}

function SettingRow({ field, value, error, onChange, onTest, testState, testError, showTest }) {
  if (field.type === 'toggle') {
    return (
      <label className="flex items-center justify-between py-2 text-sm">
        <span className="text-slate-300">{field.label}</span>
        <input
          type="checkbox"
          checked={value === 'true' || value === true}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
        />
      </label>
    );
  }

  return (
    <label className="block text-sm mb-3">
      <span className="text-slate-400">{field.label}</span>
      <div className="mt-1 flex gap-2 items-center">
        {field.type === 'select' ? (
          <select className="field-input flex-1" value={value} onChange={(e) => onChange(e.target.value)}>
            {(field.options || []).map((o) => {
              const opt = typeof o === 'string' ? { v: o, l: o } : o;
              return (
                <option key={opt.v} value={opt.v}>
                  {opt.l}
                </option>
              );
            })}
          </select>
        ) : (
          <input
            type={field.type === 'number' ? 'number' : field.type || 'text'}
            className="field-input flex-1"
            value={value}
            min={field.type === 'number' ? 1 : undefined}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {showTest && onTest && (
          <button type="button" className="btn-ghost text-xs shrink-0" onClick={onTest}>
            Test
          </button>
        )}
        {testState === 'ok' && <span className="text-emerald-400">✓</span>}
        {testState === 'fail' && <span className="text-red-400">✕</span>}
      </div>
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      {testError && <p className="text-xs text-amber-400 mt-1">{testError}</p>}
      {field.hint && <p className="text-xs text-slate-500 mt-1">{field.hint}</p>}
    </label>
  );
}
