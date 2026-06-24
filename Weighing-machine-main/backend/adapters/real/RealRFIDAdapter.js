'use strict';

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const RFIDAdapter = require('../base/RFIDAdapter');
const logger = require('../../utils/logger');
const ts = require('../../utils/timestamp');
const {
  findMatchingLocalIp,
  describeSubnetMismatch,
  probeTcp,
  formatRfidConnectError,
} = require('../../utils/networkProbe');

function readBlockedTagsEnv() {
  try {
    const RfidBlocklistService = require('../../services/RfidBlocklistService');
    return RfidBlocklistService.getBlockedTags().join(',');
  } catch (_e) {
    return String(process.env.RFID_BLOCKED_TAGS || '').trim();
  }
}

function readEpcPrefixEnv() {
  try {
    const RfidBlocklistService = require('../../services/RfidBlocklistService');
    return RfidBlocklistService.getEpcPrefix();
  } catch (_e) {
    return String(process.env.RFID_EPC_PREFIX || 'E200').trim();
  }
}

const DEFAULT_ANT_MASK = 1;
const DEFAULT_DEBOUNCE_MS = 2500;
const DEFAULT_ANTENNA_POWER = 20;
const FALLBACK_MIN_POWER = 5;
const FALLBACK_MAX_POWER = 30;
const DEFAULT_CONNECT_TIMEOUT_MS = 20000;
const DEFAULT_TCP_PROBE_MS = 3000;

function connectTimeoutMs() {
  const n = Number(process.env.RFID_CONNECT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONNECT_TIMEOUT_MS;
}

function tcpProbeTimeoutMs() {
  const n = Number(process.env.RFID_TCP_PROBE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TCP_PROBE_MS;
}

function maskToAntennaNumbers(mask) {
  const antennas = [];
  for (let bit = 0; bit < 8; bit += 1) {
    if (mask & (1 << bit)) antennas.push(bit + 1);
  }
  return antennas.length ? antennas : [1];
}

function parsePowerMap(powersStr) {
  const map = {};
  if (!powersStr) return map;
  String(powersStr)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const [ant, pwr] = pair.split(':');
      if (ant && pwr) map[Number(ant)] = Number(pwr);
    });
  return map;
}

function buildPowerMap(antennas, powerDb) {
  return antennas.map((ant) => `${ant}:${powerDb}`).join(',');
}

function resolveBridgeDir() {
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'rfid-bridge');
    if (require('fs').existsSync(path.join(packaged, 'rfid-bridge.exe'))) {
      return packaged;
    }
  }
  return path.join(__dirname, '..', '..', '..', 'rfid-bridge', 'bin');
}

function resolveBridgeExe() {
  return path.join(resolveBridgeDir(), 'rfid-bridge.exe');
}

class RealRFIDAdapter extends RFIDAdapter {
  constructor(config = {}) {
    super(config);
    this._proc = null;
    this._rl = null;
    this._connectPromise = null;
    this._lastEmittedTag = null;
    this._lastEmittedAt = 0;
    this._debounceMs =
      Number(config.debounceMs) > 0
        ? Number(config.debounceMs)
        : DEFAULT_DEBOUNCE_MS;
    this._antMask =
      Number(config.antMask) > 0 ? Number(config.antMask) : DEFAULT_ANT_MASK;
    this._inventoryStarted = false;
    this._scanning = false;
    this._antennaPower =
      Number(config.antennaPower) > 0
        ? Number(config.antennaPower)
        : DEFAULT_ANTENNA_POWER;
    this._lastError = null;
    this._reconnecting = false;
    this._intentionalDisconnect = false;
    this._connectionLostHandled = false;
  }

  getStatus() {
    const readerIp = this.config.ip || process.env.RFID_IP || null;
    return {
      ...super.getStatus(),
      bridgeRunning: !!this._proc && !this._proc.killed,
      inventoryStarted: this._inventoryStarted,
      scanning: this._scanning,
      lastTag: this._lastEmittedTag,
      lastError: this._lastError,
      reconnecting: !!this._reconnecting,
      readerIp,
      onReaderSubnet: readerIp ? !!findMatchingLocalIp(readerIp) : null,
    };
  }

  async _preflightNetwork(ip, port) {
    if (!findMatchingLocalIp(ip)) {
      throw new Error(describeSubnetMismatch(ip));
    }

    const probe = await probeTcp(ip, port, tcpProbeTimeoutMs());
    if (!probe.ok) {
      throw new Error(
        formatRfidConnectError(
          ip,
          port,
          probe.code === 'ETIMEDOUT'
            ? 'TCP connection timed out'
            : probe.error,
        ),
      );
    }
  }

  _sendCommand(payload) {
    if (
      !this._proc ||
      this._proc.killed ||
      !this._proc.stdin ||
      this._proc.stdin.destroyed ||
      !this._proc.stdin.writable
    ) {
      throw new Error('RFID bridge process is not running');
    }

    try {
      this._proc.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      if (err && err.code === 'EPIPE') {
        throw new Error('RFID bridge process closed unexpectedly');
      }
      throw err;
    }
  }

  _safeSendCommand(payload) {
    try {
      this._sendCommand(payload);
      return true;
    } catch (_err) {
      return false;
    }
  }

  _awaitBridgeEvent(eventName, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`RFID bridge timeout waiting for ${eventName}`));
      }, timeoutMs);

      const onLine = (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.event === eventName) {
            cleanup();
            resolve(msg);
          } else if (msg.event === 'error') {
            cleanup();
            reject(new Error(msg.message || `RFID bridge error during ${eventName}`));
          }
        } catch (_e) {
          /* ignore */
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        if (this._rl) this._rl.off('line', onLine);
      };

      if (this._rl) this._rl.on('line', onLine);
    });
  }

  _primaryAntenna() {
    return maskToAntennaNumbers(this._antMask)[0];
  }

  async getPowerInfo() {
    const fallback = {
      minPower: FALLBACK_MIN_POWER,
      maxPower: FALLBACK_MAX_POWER,
      currentPower: this._antennaPower,
      connected: this.connected && !!this._proc,
    };

    if (!this.connected || !this._proc) {
      return fallback;
    }

    try {
      this._sendCommand({ cmd: 'getReaderProperty' });
      const props = await this._awaitBridgeEvent('readerProperty', 8000);
      const minPower = Number(props.minPower) || FALLBACK_MIN_POWER;
      const maxPower = Number(props.maxPower) || FALLBACK_MAX_POWER;

      this._sendCommand({ cmd: 'getPower' });
      const powerMsg = await this._awaitBridgeEvent('power', 8000);
      const powerMap = parsePowerMap(powerMsg.powers);
      const primaryAnt = this._primaryAntenna();
      const currentPower =
        powerMap[primaryAnt] != null ? powerMap[primaryAnt] : this._antennaPower;

      return {
        minPower,
        maxPower,
        currentPower,
        connected: true,
        powers: powerMap,
      };
    } catch (err) {
      logger.warn('RFID getPowerInfo failed', { message: err.message });
      return fallback;
    }
  }

  async setAntennaPower(powerDb) {
    const power = Math.round(Number(powerDb));
    if (!Number.isFinite(power)) {
      throw new Error('Invalid antenna power value');
    }

    this._antennaPower = power;

    if (!this.connected || !this._proc) {
      return { ok: false, saved: true, applied: false, power };
    }

    const antennas = maskToAntennaNumbers(this._antMask);
    const powerMap = buildPowerMap(antennas, power);

    this._sendCommand({ cmd: 'setPower', powerMap });
    const result = await this._awaitBridgeEvent('powerSet', 8000);

    logger.info('RFID antenna power set', {
      type: 'device',
      device: 'rfid',
      power,
      antennas,
      powerMap: result.powers,
    });

    return { ok: true, saved: true, applied: true, power, powers: result.powers };
  }

  _handleConnectionLost(reason) {
    if (this._intentionalDisconnect || this._connectionLostHandled) return;

    const wasConnected = this.connected;
    this.connected = false;
    this._inventoryStarted = false;
    this._scanning = false;

    if (!wasConnected) return;

    this._connectionLostHandled = true;
    const message = reason || 'RFID reader connection lost';
    this._lastError = message;
    logger.warn('RFID reader connection lost', {
      type: 'device',
      device: 'rfid',
      ip: this.config.ip || null,
      message,
    });

    if (typeof this.onErrorCallback === 'function') {
      this.onErrorCallback(new Error(message));
    }
  }

  _handleBridgeLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      logger.warn('RFID bridge non-JSON output', { line, message: err.message });
      return;
    }

    const event = msg.event;
    if (!event) return;

    switch (event) {
      case 'ready':
        logger.debug('RFID bridge ready');
        break;

      case 'connected':
        this.connected = true;
        logger.info('RFID reader connected via bridge', {
          type: 'device',
          device: 'rfid',
          connId: msg.connId,
        });
        break;

      case 'inventoryStarted':
        this._inventoryStarted = true;
        logger.info('RFID inventory started', {
          type: 'device',
          device: 'rfid',
          antMask: msg.antMask,
          readType: msg.readType,
        });
        break;

      case 'tag': {
        const epc = String(msg.epc || '').trim().toUpperCase();
        if (!epc) return;

        try {
          const RfidBlocklistService = require('../../services/RfidBlocklistService');
          if (RfidBlocklistService.isBlocked(epc)) return;
        } catch (_e) {
          /* optional */
        }

        const payload = {
          tag: epc,
          tid: msg.tid ? String(msg.tid).trim().toUpperCase() : null,
          rssi: msg.rssi != null ? Number(msg.rssi) : null,
          antenna: msg.antenna != null ? Number(msg.antenna) : null,
          readerName: msg.readerName || null,
          timestamp: ts.now(),
        };

        if (typeof this.onTagDetectedCallback === 'function') {
          this.onTagDetectedCallback(payload);
        }
        break;
      }

      case 'inventoryOver':
        logger.debug('RFID inventory cycle complete');
        break;

      case 'portClosing':
        this._handleConnectionLost(
          `RFID reader at ${this.config.ip || 'unknown'} closed the connection`,
        );
        break;

      case 'stopped':
      case 'disconnected':
        this._inventoryStarted = false;
        if (event === 'disconnected') {
          this._handleConnectionLost(
            `RFID reader at ${this.config.ip || 'unknown'} disconnected`,
          );
        }
        break;

      case 'error': {
        const message = msg.message || 'RFID bridge error';
        const isNonFatalConfigError =
          /^Unknown cmd: setEpcPrefix$/i.test(message);
        if (isNonFatalConfigError) {
          logger.warn('RFID bridge missing setEpcPrefix support; rebuild rfid-bridge.exe', {
            type: 'device',
            device: 'rfid',
            message,
          });
          break;
        }
        logger.error('RFID bridge error', {
          type: 'device',
          device: 'rfid',
          message,
        });
        if (typeof this.onErrorCallback === 'function') {
          this.onErrorCallback(new Error(message));
        }
        break;
      }

      case 'debug':
      case 'log':
        logger.debug('RFID bridge', { message: msg.message });
        break;

      default:
        logger.debug('RFID bridge event', msg);
        break;
    }
  }

  _spawnBridge() {
    const bridgeExe = resolveBridgeExe();
    const bridgeDir = resolveBridgeDir();

    if (!require('fs').existsSync(bridgeExe)) {
      throw new Error(
        `rfid-bridge.exe not found at ${bridgeExe}. Run rfid-bridge/build.ps1 first.`,
      );
    }

    this._proc = spawn(bridgeExe, [], {
      cwd: bridgeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        RFID_BLOCKED_TAGS: readBlockedTagsEnv(),
        RFID_EPC_PREFIX: readEpcPrefixEnv(),
      },
    });

    this._rl = readline.createInterface({ input: this._proc.stdout });

    this._rl.on('line', (line) => this._handleBridgeLine(line));

    if (this._proc.stdin) {
      this._proc.stdin.on('error', (err) => {
        if (err && err.code !== 'EPIPE') {
          logger.warn('RFID bridge stdin error', { message: err.message });
        }
      });
    }

    this._proc.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text) {
        logger.warn('RFID bridge stderr', { text });
      }
    });

    this._proc.on('exit', (code, signal) => {
      const wasConnected = this.connected;
      this.connected = false;
      this._inventoryStarted = false;
      this._proc = null;

      if (this._rl) {
        this._rl.close();
        this._rl = null;
      }

      if (wasConnected && typeof this.onErrorCallback === 'function') {
        this.onErrorCallback(
          new Error(
            `RFID bridge exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
          ),
        );
      }
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('RFID bridge startup timeout'));
      }, 10000);

      const onLine = (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.event === 'ready') {
            cleanup();
            resolve();
          }
        } catch (_e) {
          /* wait for valid ready event */
        }
      };

      const onExit = (code) => {
        cleanup();
        reject(new Error(`RFID bridge failed to start (exit ${code})`));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        if (this._rl) this._rl.off('line', onLine);
        if (this._proc) this._proc.off('exit', onExit);
      };

      if (this._rl) this._rl.on('line', onLine);
      if (this._proc) this._proc.once('exit', onExit);
    });
  }

  syncBlockedTags() {
    if (!this._proc || !this._proc.stdin?.writable) return false;
    try {
      this._sendCommand({
        cmd: 'setBlockedTags',
        tags: readBlockedTagsEnv(),
      });
      this._sendCommand({
        cmd: 'setEpcPrefix',
        prefix: readEpcPrefixEnv(),
      });
      return true;
    } catch (err) {
      logger.debug('RFID filter sync failed', { message: err.message });
      return false;
    }
  }

  async connect() {
    if (this.connected && this._proc) return true;

    if (this._proc) {
      try {
        await this.disconnect();
      } catch (_e) {
        /* replace stale bridge process before reconnect */
      }
    }

    const ip = this.config.ip || process.env.RFID_IP;
    const port = this.config.port || process.env.RFID_PORT || '9090';

    if (!ip) {
      throw new Error('RFID IP is not configured');
    }

    this._lastError = null;

    try {
      await this._preflightNetwork(ip, port);
      await this._spawnBridge();

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              formatRfidConnectError(
                ip,
                port,
                `Connection timed out after ${connectTimeoutMs()}ms`,
              ),
            ),
          );
        }, connectTimeoutMs());

        const onLine = (line) => {
          try {
            const msg = JSON.parse(line);
            if (msg.event === 'connected') {
              cleanup();
              resolve();
            } else if (msg.event === 'error') {
              cleanup();
              reject(
                new Error(
                  formatRfidConnectError(ip, port, msg.message || 'RFID connect failed'),
                ),
              );
            }
          } catch (_e) {
            /* ignore */
          }
        };

        const cleanup = () => {
          clearTimeout(timeout);
          if (this._rl) this._rl.off('line', onLine);
        };

        if (this._rl) this._rl.on('line', onLine);

        try {
          this._sendCommand({ cmd: 'connect', ip, port: String(port) });
        } catch (err) {
          cleanup();
          reject(err);
        }
      });

      const configuredPower =
        Number(this.config.antennaPower) > 0
          ? Number(this.config.antennaPower)
          : this._antennaPower;
      try {
        await this.setAntennaPower(configuredPower);
      } catch (err) {
        logger.warn('RFID power apply on connect failed', { message: err.message });
      }

      this.syncBlockedTags();

      this.connected = true;
      this._scanning = false;
      this._lastError = null;
      this._reconnecting = false;
      this._connectionLostHandled = false;
      if (typeof this.onReconnectCallback === 'function') {
        this.onReconnectCallback();
      }
      return true;
    } catch (err) {
      this._lastError = formatRfidConnectError(ip, port, err.message);
      this.connected = false;
      this._inventoryStarted = false;
      try {
        await this.disconnect();
      } catch (_e) {
        /* ignore cleanup errors */
      }
      throw new Error(this._lastError);
    }
  }

  async _startInventoryWithRetry(maxAttempts = 3) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this._startInventoryOnce();
        return;
      } catch (err) {
        lastError = err;
        logger.warn('RFID inventory start attempt failed', {
          attempt,
          maxAttempts,
          message: err.message,
        });
        if (attempt < maxAttempts) {
          try {
            this._sendCommand({ cmd: 'stop' });
          } catch (_e) {
            /* ignore */
          }
          await new Promise((r) => setTimeout(r, 300 * attempt));
        }
      }
    }

    throw lastError || new Error('RFID inventory start failed');
  }

  async _startInventoryOnce() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('RFID inventory start timeout'));
      }, 15000);

      const onLine = (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.event === 'inventoryStarted') {
            cleanup();
            resolve();
          } else if (msg.event === 'error') {
            cleanup();
            reject(new Error(msg.message || 'RFID inventory start failed'));
          }
        } catch (_e) {
          /* ignore */
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        if (this._rl) this._rl.off('line', onLine);
      };

      if (this._rl) this._rl.on('line', onLine);

      this.syncBlockedTags();

      try {
        this._sendCommand({
          cmd: 'startInventory',
          antMask: this._antMask,
          readType: 'inventory',
        });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    this._inventoryStarted = true;
  }

  async startScanning() {
    if (!this.connected || !this._proc) {
      throw new Error('RFID reader is not connected');
    }
    if (this._scanning && this._inventoryStarted) {
      return true;
    }
    await this._startInventoryWithRetry();
    this._scanning = true;
    return true;
  }

  async stopScanning() {
    if (this._proc && this._proc.stdin.writable && this._inventoryStarted) {
      try {
        this._sendCommand({ cmd: 'stop' });
        await this._awaitBridgeEvent('stopped', 5000).catch(() => {});
      } catch (_e) {
        /* ignore */
      }
    }
    this._inventoryStarted = false;
    this._scanning = false;
    return true;
  }

  async disconnect() {
    this._intentionalDisconnect = true;

    if (this._proc && !this._proc.killed) {
      this._safeSendCommand({ cmd: 'stop' });
      this._safeSendCommand({ cmd: 'disconnect' });
      this._safeSendCommand({ cmd: 'quit' });
      this._proc.kill();
    }

    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }

    this._proc = null;
    this.connected = false;
    this._inventoryStarted = false;
    this._scanning = false;
    this._intentionalDisconnect = false;
    return true;
  }
}

module.exports = RealRFIDAdapter;
