'use strict';

const P = require('./protocol');

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

/**
 * One short-lived BLE connection to a fan. The fan only accepts one client
 * at a time, so (like the HA integration) we connect, do the work and
 * disconnect again.
 */
class FreshConnection {
  constructor(homey, peripheralUuid, log) {
    this.homey = homey;
    this.peripheralUuid = peripheralUuid;
    this.log = log || (() => {});
    this.peripheral = null;
    this.chars = new Map();
  }

  async open({ advertisement } = {}) {
    const adv = advertisement || await withTimeout(
      this.homey.ble.find(this.peripheralUuid, 20000), 25000, 'find fan',
    );
    this.peripheral = await withTimeout(adv.connect(), 30000, 'connect');

    let services = await withTimeout(
      this.peripheral.discoverAllServicesAndCharacteristics(), 30000, 'discover services',
    );
    if (!Array.isArray(services)) services = this.peripheral.services || [];

    for (const service of services) {
      let chars = service.characteristics;
      if (!chars || !chars.length) {
        chars = await service.discoverCharacteristics();
      }
      for (const ch of chars || []) {
        this.chars.set(P.normalizeUuid(ch.uuid), ch);
      }
    }
    if (!this.chars.has(P.CHAR.DEVICE_STATUS)) {
      this.log('Known characteristics:', Array.from(this.chars.keys()).join(', '));
      throw new Error('This does not look like an Intellivent fan (status characteristic missing)');
    }
  }

  async close() {
    const p = this.peripheral;
    this.peripheral = null;
    this.chars.clear();
    if (p) {
      try {
        await withTimeout(p.disconnect(), 10000, 'disconnect');
      } catch (err) {
        this.log('Disconnect failed:', err.message);
      }
    }
  }

  _char(uuid) {
    const ch = this.chars.get(uuid);
    if (!ch) throw new Error(`Characteristic ${uuid} not found`);
    return ch;
  }

  async read(uuid) {
    const value = await withTimeout(this._char(uuid).read(), 15000, `read ${uuid}`);
    return Buffer.from(value);
  }

  async write(uuid, buf) {
    this.log(`[W] ${uuid} = ${buf.toString('hex')}`);
    await withTimeout(this._char(uuid).write(buf), 15000, `write ${uuid}`);
  }

  async authenticate(code) {
    await this.write(P.CHAR.AUTH, P.parseAuthCode(code));
    await sleep(1000);
  }

  /** Reads the auth code; only non-zero while the fan is in pairing mode. */
  async fetchAuthCode() {
    const code = await this.read(P.CHAR.AUTH);
    return P.parseAuthCode(code).toString('hex');
  }

  async readDeviceInfo() {
    const info = {};
    const fields = [
      ['name', P.CHAR.DEVICE_NAME],
      ['manufacturer', P.CHAR.MANUFACTURER_NAME],
      ['firmware', P.CHAR.FIRMWARE_VERSION],
      ['hardware', P.CHAR.HARDWARE_VERSION],
      ['software', P.CHAR.SOFTWARE_VERSION],
    ];
    for (const [key, uuid] of fields) {
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
    };
  }
}

module.exports = FreshConnection;
