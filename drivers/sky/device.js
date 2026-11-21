'use strict';

const Homey = require('homey');
const P = require('../../lib/protocol');
const FreshConnection = require('../../lib/FreshConnection');

const DEFAULT_POLL = 120;

class SkyDevice extends Homey.Device {
  async onInit() {
    this._queue = Promise.resolve();
    this._pollTimer = null;
    this._state = null;
    this._deleted = false;
    this._conn = null;
    this._failures = 0;

    for (const cap of ['fresh_boost_remaining']) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }

    this.registerCapabilityListener('fresh_boost', async (value) => this.setBoost(value));
    this.registerCapabilityListener('fresh_constant_speed', async (value) => this.setConstantSpeed(value));

    this.refreshSoon(2000);
  }

  async onDeleted() {
    this._deleted = true;
    this.homey.clearTimeout(this._pollTimer);
    await this._dropConn();
  }

  async onUninit() {
    this.homey.clearTimeout(this._pollTimer);
    await this._dropConn();
  }

  /* ---------------- scheduling ---------------- */

  _pollSeconds() {
    const s = Number(this.getSetting('poll_interval')) || DEFAULT_POLL;
    return Math.max(30, s);
  }

  refreshSoon(ms) {
    if (this._deleted) return;
    this.homey.clearTimeout(this._pollTimer);
    this._pollTimer = this.homey.setTimeout(() => {
      this.refresh().catch(() => {});
    }, ms);
  }

  _scheduleNext() {
    let seconds = this._pollSeconds();
    // Poll right after a running boost ends so the UI flips back promptly.
    if (this._state && this._state.boost.enabled && this._state.boost.seconds > 0) {
      seconds = Math.min(seconds, this._state.boost.seconds + 5);
    }
    this.refreshSoon(seconds * 1000);
  }

  /** Serialises all BLE work for this fan. */
  runExclusive(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  /**
   * Reuses one open connection: getting connected and resolved takes the fan
   * ~15-20 s, so doing it on every poll would be slow and flaky. The fan may
   * still drop the link when idle; then the next session reconnects.
   */
  async _getConn() {
    if (this._conn && this._conn.isOpen) return this._conn;
    if (this._conn) await this._conn.close();
    const conn = new FreshConnection(
      this.homey,
      this.getStoreValue('peripheralUuid') || this.getData().id,
      this.log.bind(this),
    );
    await conn.open();
    this._conn = conn;
    return conn;
  }

  async _dropConn() {
    const c = this._conn;
    this._conn = null;
    if (c) await c.close();
  }

  /** Connect (or reuse), authenticate, run fn(conn), re-read state. */
  _session(fn, { requireAuth = false, authKey, readBack = true } = {}) {
    return this.runExclusive(async () => {
      const key = authKey !== undefined ? authKey : this.getSetting('auth_key');
      if (requireAuth && !key) {
        throw new Error(this.homey.__('errors.no_auth'));
      }
      try {
        const conn = await this._getConn();
        // The fan forgets authentication after a few seconds idle; re-send each time.
        if (key) await conn.authenticate(key);
        if (fn) await fn(conn);
        if (!readBack) return null;
        if (!this.getStoreValue('info')) {
          const info = await conn.readDeviceInfo();
          await this.setStoreValue('info', info).catch(this.error);
          await this.setSettings({
            info_manufacturer: info.manufacturer || '-',
            info_firmware: info.firmware || '-',
          }).catch(this.error);
        }
        const state = await conn.readAll();
        await this._applyState(state, key);
        this._failures = 0;
        await this.setAvailable().catch(this.error);
        return state;
      } catch (err) {
        this.error('BLE session failed:', err.message);
        await this._dropConn();
        this._failures = (this._failures || 0) + 1;
        // One failed poll is normal for this fan; only flag it after repeated failures.
        if (this._failures >= 3) await this.setUnavailable(err.message).catch(this.error);
        throw err;
      } finally {
        this._scheduleNext();
      }
    });
  }

  async refresh() {
    return this._session(null);
  }

  /* ---------------- state -> Homey ---------------- */

  async _applyState(state, key) {
    const prev = this._state;
    this._state = state;
    const s = state.status;

    if (s.temperature !== null) await this._set('measure_temperature', s.temperature);
    if (s.humidity !== null) await this._set('measure_humidity', s.humidity);
    await this._set('fresh_rpm', s.rpm);
    await this._set('fresh_mode', s.mode);
    await this._set('fresh_boost', state.boost.enabled);
    await this._set('fresh_constant_speed', state.constantSpeed.enabled);
    await this._set('fresh_boost_remaining',
      state.boost.enabled ? Math.round((state.boost.seconds / 60) * 10) / 10 : 0);

    if (key && !s.authenticated) {
      await this.setWarning(this.homey.__('errors.auth_failed')).catch(this.error);
    } else if (!key) {
      await this.setWarning(this.homey.__('errors.read_only')).catch(this.error);
    } else {
      await this.unsetWarning().catch(this.error);
    }

    // Flow triggers
    if (prev) {
      const driver = this.driver;
      if (prev.status.mode !== s.mode) {
        driver.modeChangedTrigger.trigger(this, { mode: this._modeTitle(s.mode) }).catch(this.error);
      }
      if (!prev.boost.enabled && state.boost.enabled) {
        driver.boostStartedTrigger.trigger(this).catch(this.error);
      }
      if (prev.boost.enabled && !state.boost.enabled) {
        driver.boostStoppedTrigger.trigger(this).catch(this.error);
      }
    }

    // Mirror the fan's configuration into the device settings.
    const settings = {
      constant_speed_rpm: state.constantSpeed.rpm,
      humidity_enabled: state.humidity.enabled,
      humidity_detection: String(state.humidity.detection),
      humidity_rpm: state.humidity.rpm,
      light_enabled: state.lightVoc.lightEnabled,
      light_detection: String(state.lightVoc.lightDetection === 3 ? 3 : 2),
      voc_enabled: state.lightVoc.vocEnabled,
      voc_detection: String(state.lightVoc.vocDetection),
      airing_enabled: state.airing.enabled,
      airing_minutes: state.airing.minutes,
      airing_rpm: state.airing.rpm,
      timer_minutes: state.timer.minutes,
      timer_delay_enabled: state.timer.delayEnabled,
      timer_delay_minutes: state.timer.delayMinutes,
      timer_rpm: state.timer.rpm,
    };
    // While idle the fan reports the configured boost duration.
    if (!state.boost.enabled) {
      settings.boost_rpm = state.boost.rpm;
      settings.boost_seconds = state.boost.seconds;
    }
    await this._syncSettings(settings);
  }

  async _set(cap, value) {
    if (!this.hasCapability(cap)) return;
    if (this.getCapabilityValue(cap) === value) return;
    await this.setCapabilityValue(cap, value).catch(this.error);
  }

  async _syncSettings(fromFan) {
    const ranges = {
      constant_speed_rpm: [800, 2400], humidity_rpm: [800, 2400], airing_rpm: [800, 2400],
      timer_rpm: [800, 2400], boost_rpm: [800, 2400], boost_seconds: [60, 3600],
      airing_minutes: [5, 120], timer_minutes: [1, 60], timer_delay_minutes: [0, 10],
    };
    const dropdown = {
      humidity_detection: ['1', '2', '3'], light_detection: ['2', '3'], voc_detection: ['1', '2', '3'],
    };
    const current = this.getSettings();
    const changed = {};
    for (const key of Object.keys(fromFan)) {
      const v = fromFan[key];
      if (ranges[key] && (v < ranges[key][0] || v > ranges[key][1])) continue;
      if (dropdown[key] && !dropdown[key].includes(v)) continue;
      if (current[key] !== v) changed[key] = v;
    }
    if (Object.keys(changed).length) {
      await this.setSettings(changed).catch((err) => this.error('setSettings', err.message));
    }
  }

  _modeTitle(mode) {
    return this.homey.__(`modes.${mode}`) || mode;
  }

  /* ---------------- commands ---------------- */

  _cur() {
    if (!this._state) throw new Error(this.homey.__('errors.no_state'));
    return this._state;
  }

  async setBoost(enabled, rpm, seconds) {
    const r = rpm || Number(this.getSetting('boost_rpm')) || 2400;
    const s = seconds || Number(this.getSetting('boost_seconds')) || 600;
    await this._session((conn) => conn.write(P.CHAR.BOOST, P.buildBoost(!!enabled, r, s)), { requireAuth: true });
  }

  async startBoost(rpm, minutes) {
    const seconds = minutes ? Math.round(Number(minutes) * 60) : undefined;
    return this.setBoost(true, rpm, seconds);
  }

  async setConstantSpeed(enabled, rpm) {
    await this._session(async (conn) => {
      let r = rpm;
      if (!r) {
        const cur = P.parseConstantSpeed(await conn.read(P.CHAR.CONSTANT_SPEED));
        r = Number(this.getSetting('constant_speed_rpm')) || cur.rpm;
      }
      await conn.write(P.CHAR.CONSTANT_SPEED, P.buildConstantSpeed(!!enabled, r));
    }, { requireAuth: true });
  }

  async setPause(enabled, minutes) {
    await this._session(
      (conn) => conn.write(P.CHAR.PAUSE, P.buildPause(!!enabled, minutes || 0)),
      { requireAuth: true },
    );
  }

  /** detection: 'off' | '1' | '2' | '3' */
  async setHumidityMode(detection, rpm) {
    await this._session(async (conn) => {
      const cur = P.parseHumidity(await conn.read(P.CHAR.HUMIDITY));
      const enabled = detection !== 'off';
      const det = enabled ? Number(detection) : cur.detection;
      await conn.write(P.CHAR.HUMIDITY, P.buildHumidity(enabled, det || 2, rpm || cur.rpm));
    }, { requireAuth: true });
  }

  /* ---------------- settings ---------------- */

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    const has = (prefix) => changedKeys.some((k) => k.indexOf(prefix) === 0);

    if (changedKeys.includes('auth_key') && newSettings.auth_key) {
      P.parseAuthCode(newSettings.auth_key); // throws a readable error if invalid
    }

    const writes = [];
    const n = newSettings;

    if (has('boost_') && this._state && this._state.boost.enabled) {
      writes.push([P.CHAR.BOOST, P.buildBoost(true, n.boost_rpm, n.boost_seconds)]);
    }
    if (has('constant_speed_')) {
      const enabled = this._state ? this._state.constantSpeed.enabled : false;
      writes.push([P.CHAR.CONSTANT_SPEED, P.buildConstantSpeed(enabled, n.constant_speed_rpm)]);
    }
    if (has('humidity_')) {
      writes.push([P.CHAR.HUMIDITY,
        P.buildHumidity(n.humidity_enabled, Number(n.humidity_detection), n.humidity_rpm)]);
    }
    if (has('light_') || has('voc_')) {
      writes.push([P.CHAR.LIGHT_VOC, P.buildLightVoc(
        n.light_enabled, Number(n.light_detection), n.voc_enabled, Number(n.voc_detection),
      )]);
    }
    if (has('airing_')) {
      writes.push([P.CHAR.AIRING, P.buildAiring(n.airing_enabled, n.airing_minutes, n.airing_rpm)]);
    }
    if (has('timer_')) {
      writes.push([P.CHAR.TIMER, P.buildTimer(
        n.timer_minutes, n.timer_delay_enabled, n.timer_delay_minutes, n.timer_rpm,
      )]);
    }

    if (writes.length) {
      if (!n.auth_key) throw new Error(this.homey.__('errors.no_auth'));
      // Settings are stored after onSettings resolves, so pass the new key explicitly.
      await this._session(async (conn) => {
        for (const [uuid, buf] of writes) await conn.write(uuid, buf);
      }, { requireAuth: true, authKey: n.auth_key, readBack: false });
    }

    // Re-read after the new settings have been stored.
    this.refreshSoon(changedKeys.includes('poll_interval') && !writes.length ? 1000 : 3000);
    return undefined;
  }
}

module.exports = SkyDevice;
