'use strict';

const P = require('./protocol');

/*
 * The fan drops an idle BLE connection after roughly 5 s, while Homey's full
 * GATT enumeration (discoverAllServicesAndCharacteristics) takes ~8 s and ends
 * in "Timeout waiting for ServicesResolved". So we never enumerate everything:
 * reads and the auth write go straight to (service, characteristic), and other
 * writes discover only the one service they need.
 *
 * Service UUIDs from SavyTechLabs/Fresh-Intellivent (MIT), mapped from real fans.
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
    this.writeChars = new Map();
  }

  /** Find + connect, with retries (the fan's BLE is weak and flaky). */
  async open({ advertisement, attempts = 4 } = {}) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        const adv = (i === 1 && advertisement)
          ? advertisement
          : await withTimeout(this.homey.ble.find(this.peripheralUuid), 25000, 'find fan');
        // Let the radio settle after scanning; connecting straight away often fails.
        await sleep(2000);
        const t0 = Date.now();
        this.peripheral = await withTimeout(adv.connect(), 20000, 'connect');
        this.log(`Connected (attempt ${i}) in ${Date.now() - t0} ms`);
        return;
      } catch (err) {
        lastErr = err;
        this.log(`Connect attempt ${i}/${attempts} failed: ${err.message}`);
        await this.close();
        if (i < attempts) await sleep(2000 + i * 1000);
      }
    }
    throw lastErr;
  }

  async close() {
    const p = this.peripheral;
    this.peripheral = null;
    this.writeChars.clear();
    if (p) {
      try {
        await withTimeout(p.disconnect(), 10000, 'disconnect');
      } catch (err) {
        this.log('Disconnect failed:', err.message);
      }
    }
  }

  _svc(uuid) {
    const svc = SERVICE_OF[uuid];
    if (!svc) throw new Error(`Unknown characteristic ${uuid}`);
    if (!this.peripheral) throw new Error('Not connected');
    return svc;
  }

  async read(uuid) {
    const svc = this._svc(uuid);
    const value = await withTimeout(this.peripheral.read(svc, uuid), 10000, `read ${uuid.slice(0, 8)}`);
    return Buffer.from(value);
  }

  /**
   * Mode characteristics need write-with-response. The read/write shorthand
   * skips discovery and may pick the wrong write type, so discover just the
   * one service and write through the characteristic object. Falls back to
   * the shorthand if targeted discovery isn't available.
   */
  async write(uuid, buf) {
    const svc = this._svc(uuid);
    this.log(`[W] ${uuid.slice(0, 8)} = ${buf.toString('hex')}`);
    let ch = this.writeChars.get(uuid);
    if (!ch) {
      try {
        const services = await withTimeout(this.peripheral.discoverServices([svc]), 10000, 'discover service');
        const service = (services || []).find((s) => P.normalizeUuid(s.uuid) === svc);
        if (service) {
          const chars = await withTimeout(service.discoverCharacteristics([uuid]), 10000, 'discover characteristic');
          ch = (chars || []).find((c) => P.normalizeUuid(c.uuid) === uuid);
        }
      } catch (err) {
        this.log('Targeted discovery failed, using shorthand write:', err.message);
      }
      if (ch) this.writeChars.set(uuid, ch);
    }
    if (ch) {
      await withTimeout(ch.write(buf), 10000, `write ${uuid.slice(0, 8)}`);
    } else {
      await withTimeout(this.peripheral.write(svc, uuid, buf), 10000, `write ${uuid.slice(0, 8)}`);
    }
  }

  /** Writes the code and checks the "authenticated" flag in the status. */
  async authenticate(code) {
    const svc = this._svc(P.CHAR.AUTH);
    await withTimeout(this.peripheral.write(svc, P.CHAR.AUTH, P.parseAuthCode(code)), 10000, 'auth');
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
    const fields = [
      ['manufacturer', P.CHAR.MANUFACTURER_NAME],
      ['firmware', P.CHAR.FIRMWARE_VERSION],
    ];
    for (const [key, uuid] of fields) {
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
    };
  }
}

module.exports = FreshConnection;
