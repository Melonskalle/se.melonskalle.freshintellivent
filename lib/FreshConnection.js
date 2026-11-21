'use strict';

const P = require('./protocol');

/*
 * Connecting to the fan on Homey Pro:
 *
 * Homey waits a fixed ~10 s for BlueZ to report "ServicesResolved", but these
 * fans need ~16 s. A single discovery call therefore always fails with
 * "Timeout waiting for ServicesResolved" - and the read/write shorthand runs
 * the same discovery internally. BlueZ keeps resolving in the background, so
 * the trick is to retry discovery on the SAME open connection (each retry gets
 * a fresh window against progress already made) and stop as soon as the
 * characteristics we need are there. Tearing down and reconnecting throws that
 * progress away.
 *
 * Approach from JYxfeldt/Homey-Intellivent; service UUIDs from
 * SavyTechLabs/Fresh-Intellivent.
 */
const SVC_MODES = 'c119e8580531468196745a11f0e53bb4';
const SVC_STATUS = '1a46a853e5ed4696bac070e346884a26';
const SVC_AUTH = 'e6834e4b7b3a48e691e4f1d005f564d3';
const SVC_DEVICE_INFO = '180a';

const SERVICE_OF = {
  [P.CHAR.AUTH]: SVC_AUTH,
  [P.CHAR.DEVICE_NAME]: SVC_AUTH,
  [P.CHAR.DEVICE_STATUS]: SVC_STATUS,
  [P.CHAR.HUMIDITY]: SVC_MODES,
  [P.CHAR.LIGHT_VOC]: SVC_MODES,
  [P.CHAR.CONSTANT_SPEED]: SVC_MODES,
  [P.CHAR.TIMER]: SVC_MODES,
  [P.CHAR.AIRING]: SVC_MODES,
  [P.CHAR.PAUSE]: SVC_MODES,
  [P.CHAR.BOOST]: SVC_MODES,
  [P.CHAR.TEMPORARY_SPEED]: SVC_MODES,
  [P.CHAR.MODEL_NUMBER]: SVC_DEVICE_INFO,
  [P.CHAR.FIRMWARE_VERSION]: SVC_DEVICE_INFO,
  [P.CHAR.HARDWARE_VERSION]: SVC_DEVICE_INFO,
  [P.CHAR.SOFTWARE_VERSION]: SVC_DEVICE_INFO,
  [P.CHAR.MANUFACTURER_NAME]: SVC_DEVICE_INFO,
};

const REQUIRED = [P.CHAR.DEVICE_STATUS, P.CHAR.AUTH];
const DISCOVERY_ATTEMPTS = 5;

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout: ${what}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FreshConnection {
  constructor(homey, peripheralUuid, log) {
    this.homey = homey;
    this.peripheralUuid = peripheralUuid;
    this.log = log || (() => {});
    this.peripheral = null;
    this.connected = false;
    this.chars = new Map();
    this.lastActivity = 0;
  }

  get isOpen() {
    return !!(this.peripheral && this.connected && this.peripheral.isConnected !== false);
  }

  /** Find, connect and resolve the characteristics, with retries. */
  async open({ advertisement, attempts = 3 } = {}) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        let adv = (i === 1 && advertisement) ? advertisement : null;
        if (!adv && i <= 2) {
          adv = await withTimeout(this.homey.ble.find(this.peripheralUuid), 25000, 'find fan').catch(() => null);
        }
        if (!adv) {
          // Homey's advertisement cache can go stale; a real scan gives a fresh object.
          const all = await this.homey.ble.discover([], 15000);
          const id = String(this.peripheralUuid).toLowerCase();
          adv = all.find((a) => String(a.uuid).toLowerCase() === id);
          if (!adv) throw new Error('Fan not found in Bluetooth scan');
        }
        await sleep(1500);
        const t0 = Date.now();
        const p = await withTimeout(adv.connect(), 30000, 'connect');
        this.peripheral = p;
        this.connected = true;
        if (typeof p.once === 'function') {
          p.once('disconnect', () => {
            if (this.peripheral === p) {
              this.connected = false;
              this.log('Fan disconnected');
            }
          });
        }
        this.log(`Connected (attempt ${i}) in ${Date.now() - t0} ms`);
        await this._resolve();
        this.log(`Ready after ${Date.now() - t0} ms, ${this.chars.size} characteristics`);
        return;
      } catch (err) {
        lastErr = err;
        this.log(`Open attempt ${i}/${attempts} failed: ${err.message}`);
        await this.close();
        if (i < attempts) await sleep(3000);
      }
    }
    throw lastErr;
  }

  _cacheChars() {
    const p = this.peripheral;
    if (!p) return;
    for (const service of p.services || []) {
      for (const ch of service.characteristics || []) {
        this.chars.set(P.normalizeUuid(ch.uuid), ch);
      }
    }
  }

  _hasRequired() {
    return REQUIRED.every((u) => this.chars.has(u));
  }

  async _resolve() {
    const p = this.peripheral;
    let lastErr = null;
    for (let attempt = 1; attempt <= DISCOVERY_ATTEMPTS; attempt++) {
      if (!this.isOpen) throw lastErr || new Error('Fan disconnected during service discovery');
      try {
        let services;
        if (typeof p.discoverServices === 'function') {
          services = await withTimeout(p.discoverServices(), 20000, 'discover services');
          for (const service of services || []) {
            if (!this.isOpen) break;
            if (service.characteristics && service.characteristics.length) continue;
            if (typeof service.discoverCharacteristics !== 'function') continue;
            try {
              await withTimeout(service.discoverCharacteristics(), 15000, 'discover characteristics');
            } catch (err) {
              this.log(`Characteristics for ${service.uuid} failed (continuing): ${err.message}`);
            }
          }
        } else {
          await withTimeout(p.discoverAllServicesAndCharacteristics(), 20000, 'discover all');
        }
      } catch (err) {
        lastErr = err;
        this.log(`Discovery attempt ${attempt}/${DISCOVERY_ATTEMPTS}: ${err.message}`);
      }
      this._cacheChars();
      if (this._hasRequired()) return;
    }
    throw lastErr || new Error('Fan characteristics not found');
  }

  async close() {
    const p = this.peripheral;
    this.peripheral = null;
    this.connected = false;
    this.chars.clear();
    if (p) {
      try {
        await withTimeout(p.disconnect(), 10000, 'disconnect');
      } catch (err) {
        this.log('Disconnect failed:', err.message);
      }
    }
  }

  _assertOpen() {
    if (!this.isOpen) throw new Error('Not connected');
  }

  async read(uuid) {
    this._assertOpen();
    const ch = this.chars.get(uuid);
    const value = ch
      ? await withTimeout(ch.read(), 10000, `read ${uuid.slice(0, 8)}`)
      : await withTimeout(this.peripheral.read(SERVICE_OF[uuid], uuid), 10000, `read ${uuid.slice(0, 8)}`);
    this.lastActivity = Date.now();
    return Buffer.from(value);
  }

  /** Quick liveness check: the fan drops idle links without always telling Homey. */
  async probe(ms = 4000) {
    if (!this.isOpen) return false;
    try {
      const ch = this.chars.get(P.CHAR.DEVICE_STATUS);
      if (!ch) return false;
      await withTimeout(ch.read(), ms, 'probe');
      this.lastActivity = Date.now();
      return true;
    } catch (err) {
      this.log('Connection probe failed:', err.message);
      return false;
    }
  }

  async write(uuid, buf) {
    this._assertOpen();
    this.log(`[W] ${uuid.slice(0, 8)} = ${buf.toString('hex')}`);
    const ch = this.chars.get(uuid);
    if (ch) {
      await withTimeout(ch.write(buf), 10000, `write ${uuid.slice(0, 8)}`);
    } else {
      await withTimeout(this.peripheral.write(SERVICE_OF[uuid], uuid, buf), 10000, `write ${uuid.slice(0, 8)}`);
    }
    this.lastActivity = Date.now();
  }

  /** Writes the code and returns the fan's "authenticated" flag. */
  async authenticate(code) {
    await this.write(P.CHAR.AUTH, P.parseAuthCode(code));
    await sleep(800);
    const status = P.parseStatus(await this.read(P.CHAR.DEVICE_STATUS));
    this.log(`Authenticated: ${status.authenticated}`);
    return status.authenticated;
  }

  /** Reads the auth code; only non-zero while the fan is in pairing mode. */
  async fetchAuthCode() {
    const code = await this.read(P.CHAR.AUTH);
    this.log(`Auth characteristic: ${code.toString('hex')}`);
    return P.parseAuthCode(code).toString('hex');
  }

  async readDeviceInfo() {
    const info = {};
    for (const [key, uuid] of [['manufacturer', P.CHAR.MANUFACTURER_NAME], ['firmware', P.CHAR.FIRMWARE_VERSION]]) {
      if (!this.chars.has(uuid)) continue;
      try {
        info[key] = P.decodeString(await this.read(uuid));
      } catch (err) {
        this.log(`Could not read ${key}:`, err.message);
      }
    }
    return info;
  }

  async readAll() {
    return {
      status: P.parseStatus(await this.read(P.CHAR.DEVICE_STATUS)),
      boost: P.parseBoost(await this.read(P.CHAR.BOOST)),
      constantSpeed: P.parseConstantSpeed(await this.read(P.CHAR.CONSTANT_SPEED)),
      humidity: P.parseHumidity(await this.read(P.CHAR.HUMIDITY)),
      lightVoc: P.parseLightVoc(await this.read(P.CHAR.LIGHT_VOC)),
      airing: P.parseAiring(await this.read(P.CHAR.AIRING)),
      timer: P.parseTimer(await this.read(P.CHAR.TIMER)),
      pause: P.parsePause(await this.read(P.CHAR.PAUSE)),
    };
  }
}

module.exports = FreshConnection;
