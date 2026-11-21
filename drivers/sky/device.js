'use strict';

const Homey = require('homey');
const P = require('../../lib/protocol');
const FreshConnection = require('../../lib/FreshConnection');

const DEFAULT_POLL = 120;
const AIRING_STEPS = [30, 60, 90, 120];

const CAPABILITIES = [
  'fresh_boost', 'fresh_pause', 'fresh_constant_speed', 'fresh_constant_rpm',
  'fresh_humidity_level', 'fresh_light_level', 'fresh_voc_level', 'fresh_airing',
  'fresh_mode', 'fresh_rpm', 'measure_temperature', 'measure_humidity', 'fresh_boost_remaining',
];

function nearestAiring(minutes) {
  return AIRING_STEPS.reduce((a, b) => (Math.abs(b - minutes) < Math.abs(a - minutes) ? b : a));
}

class SkyDevice extends Homey.Device {
  async onInit() {
    this._queue = Promise.resolve();
    this._pollTimer = null;
    this._state = null;
    this._deleted = false;
    this._conn = null;
    this._failures = 0;

    // Add capabilities introduced after a device was paired.
    for (const cap of CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }

    const ui = (cap, fn) => this.registerCapabilityListener(cap, (value) => this._fromUi(cap, value, fn));
    ui('fresh_boost', (v) => this.setBoost(v));
    ui('fresh_pause', (v) => this.setPause(v));
    ui('fresh_constant_speed', (v) => this.setConstantSpeed(v));
    ui('fresh_constant_rpm', (v) => this.setConstantSpeed(null, v));
    ui('fresh_humidity_level', (v) => this.setHumidityLevel(v));
    ui('fresh_light_level', (v) => this.setLightLevel(v));
    ui('fresh_voc_level', (v) => this.setVocLevel(v));
    ui('fresh_airing', (v) => this.setAiring(v));

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

  /**
   * A (re)connect can take 15-20 s, longer than the Homey app waits for a
   * capability change. So accept the change at once, do the BLE work in the
   * background, and roll the value back if it fails.
   */
  async _fromUi(cap, value, fn) {
    if (!this.getSetting('auth_key')) throw new Error(this.homey.__('errors.no_auth'));
    const previous = this.getCapabilityValue(cap);
    Promise.resolve()
      .then(() => fn(value))
      .catch(async (err) => {
        this.error(`${cap} -> ${value} failed:`, err.message);
        await this.setCapabilityValue(cap, previous).catch(() => {});
        await this.setWarning(this.homey.__('errors.command_failed', { error: err.message })).catch(() => {});
        this.homey.setTimeout(() => this.unsetWarning().catch(() => {}), 60000);
      });
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
    if (this._state && this._state.boost.enabled && this._state.boost.seconds > 0) {
      seconds = Math.min(seconds, this._state.boost.seconds + 5);
    }
    this.refreshSoon(seconds * 1000);
  }

  /** Serialises all BLE work for this fan. */
  runExclusive(fn) {
    const run = this._queue.then(() => fn(), () => fn());
    this._queue = run.catch(() => {});
    return run;
  }

  /* ---------------- connection ---------------- */

  async _getConn() {
    const c = this._conn;
    if (c && c.isOpen) {
      // The fan silently drops idle links; check before trusting an old one.
      if (Date.now() - c.lastActivity < 3000 || await c.probe()) return c;
      this.log('Stale connection, reconnecting');
    }
    await this._dropConn();
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

  /**
   * Connect (or reuse), authenticate, run fn(conn), re-read state.
   * Retries once on a fresh connection if the first try fails.
   */
  _session(fn, { requireAuth = false, authKey, readBack = true } = {}) {
    return this.runExclusive(async () => {
      const key = authKey !== undefined ? authKey : this.getSetting('auth_key');
      if (requireAuth && !key) throw new Error(this.homey.__('errors.no_auth'));
      let lastErr;
      try {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const conn = await this._getConn();
            // The fan forgets authentication after a few seconds idle; re-send each time.
            if (key) await conn.authenticate(key);
            let state = null;
            if (fn) await fn(conn, this._state);
            if (readBack) {
              if (!this.getStoreValue('info')) {
                const info = await conn.readDeviceInfo();
                await this.setStoreValue('info', info).catch(this.error);
                await this.setSettings({
                  info_manufacturer: info.manufacturer || '-',
                  info_firmware: info.firmware || '-',
                }).catch(this.error);
              }
              state = await conn.readAll();
              await this._applyState(state, key);
            }
            this._failures = 0;
            await this.setAvailable().catch(this.error);
            return state;
          } catch (err) {
            lastErr = err;
            this.error(`BLE session attempt ${attempt} failed:`, err.message);
            await this._dropConn();
          }
        }
        this._failures += 1;
        // A single failed poll is normal for this fan; flag only repeated failures.
        if (this._failures >= 3) await this.setUnavailable(lastErr.message).catch(this.error);
        throw lastErr;
      } finally {
        this._scheduleNext();
      }
    });
  }

  async refresh() {
    return this._session(null);
  }

  /** Write, then re-read the fan's state in the same session. */
  _command(fn) {
    return this._session(fn, { requireAuth: true });
  }

  /* ---------------- state -> Homey ---------------- */

  async _applyState(state, key) {
    const prev = this._state;
    this._state = state;
    const s = state.status;
    const lv = state.lightVoc;

    if (s.temperature !== null) await this._set('measure_temperature', s.temperature);
    if (s.humidity !== null) await this._set('measure_humidity', s.humidity);
    await this._set('fresh_rpm', s.rpm);
    await this._set('fresh_mode', s.mode);
    await this._set('fresh_boost', state.boost.enabled);
    await this._set('fresh_pause', state.pause.enabled || s.mode === 'pause');
    await this._set('fresh_constant_speed', state.constantSpeed.enabled);
    await this._set('fresh_constant_rpm', state.constantSpeed.rpm);
    await this._set('fresh_humidity_level', P.rawToLevel('humidity', state.humidity.enabled, state.humidity.detection));
    await this._set('fresh_light_level', P.rawToLevel('light', lv.lightEnabled, lv.lightDetection));
    await this._set('fresh_voc_level', P.rawToLevel('voc', lv.vocEnabled, lv.vocDetection));
    await this._set('fresh_airing', state.airing.enabled ? String(nearestAiring(state.airing.minutes)) : 'off');
    await this._set('fresh_boost_remaining',
      state.boost.enabled ? Math.round((state.boost.seconds / 60) * 10) / 10 : 0);

    if (key && !s.authenticated) {
      await this.setWarning(this.homey.__('errors.auth_failed')).catch(this.error);
    } else if (!key) {
      await this.setWarning(this.homey.__('errors.read_only')).catch(this.error);
    } else {
      await this.unsetWarning().catch(this.error);
    }

    if (prev) {
      const driver = this.driver;
      if (prev.status.mode !== s.mode) {
        driver.modeChangedTrigger.trigger(this, { mode: this._modeTitle(s.mode) }).catch(this.error);
      }
      if (!prev.boost.enabled && state.boost.enabled) driver.boostStartedTrigger.trigger(this).catch(this.error);
      if (prev.boost.enabled && !state.boost.enabled) driver.boostStoppedTrigger.trigger(this).catch(this.error);
    }

    const settings = {
      humidity_rpm: state.humidity.rpm,
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
      humidity_rpm: [800, 2400], airing_rpm: [800, 2400], timer_rpm: [800, 2400],
      boost_rpm: [800, 2400], boost_seconds: [60, 3600], timer_minutes: [1, 60], timer_delay_minutes: [0, 10],
    };
    const current = this.getSettings();
    const changed = {};
    for (const key of Object.keys(fromFan)) {
      const v = fromFan[key];
      if (ranges[key] && (v < ranges[key][0] || v > ranges[key][1])) continue;
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

  async setBoost(enabled, rpm, seconds) {
    const r = rpm || Number(this.getSetting('boost_rpm')) || 2400;
    const s = seconds || Number(this.getSetting('boost_seconds')) || 600;
    await this._command((conn) => conn.write(P.CHAR.BOOST, P.buildBoost(!!enabled, r, s)));
  }

  async startBoost(rpm, minutes) {
    const seconds = minutes ? Math.round(Number(minutes) * 60) : undefined;
    return this.setBoost(true, rpm, seconds);
  }

  async setPause(enabled, minutes) {
    const m = minutes || Number(this.getSetting('pause_minutes')) || 30;
    await this._command((conn) => conn.write(P.CHAR.PAUSE, P.buildPause(!!enabled, enabled ? m : 0)));
  }

  /** enabled: true/false, or null to keep; rpm: number, or null to keep. */
  async setConstantSpeed(enabled, rpm) {
    await this._command(async (conn) => {
      const cur = P.parseConstantSpeed(await conn.read(P.CHAR.CONSTANT_SPEED));
      const en = (enabled === null || enabled === undefined) ? cur.enabled : !!enabled;
      await conn.write(P.CHAR.CONSTANT_SPEED, P.buildConstantSpeed(en, rpm || cur.rpm));
    });
  }

  /** level: 'off' | 'low' | 'medium' | 'high' */
  async setHumidityLevel(level, rpm) {
    await this._command(async (conn) => {
      const cur = P.parseHumidity(await conn.read(P.CHAR.HUMIDITY));
      const on = level !== 'off';
      const det = on ? P.levelToRaw('humidity', level) : cur.detection;
      await conn.write(P.CHAR.HUMIDITY, P.buildHumidity(on, det || 2, rpm || cur.rpm));
    });
  }

  async _setLightVoc(changes) {
    await this._command(async (conn) => {
      const cur = P.parseLightVoc(await conn.read(P.CHAR.LIGHT_VOC));
      const n = Object.assign({}, cur, changes);
      await conn.write(P.CHAR.LIGHT_VOC, P.buildLightVoc(
        n.lightEnabled, n.lightDetection || 2, n.vocEnabled, n.vocDetection || 2,
      ));
    });
  }

  async setLightLevel(level) {
    if (level === 'off') return this._setLightVoc({ lightEnabled: false });
    return this._setLightVoc({ lightEnabled: true, lightDetection: P.levelToRaw('light', level) });
  }

  async setVocLevel(level) {
    if (level === 'off') return this._setLightVoc({ vocEnabled: false });
    return this._setLightVoc({ vocEnabled: true, vocDetection: P.levelToRaw('voc', level) });
  }

  /** value: 'off' or minutes as string/number */
  async setAiring(value, rpm) {
    await this._command(async (conn) => {
      const cur = P.parseAiring(await conn.read(P.CHAR.AIRING));
      const on = String(value) !== 'off';
      const minutes = on ? Number(value) : cur.minutes;
      await conn.write(P.CHAR.AIRING, P.buildAiring(on, minutes || 30, rpm || cur.rpm));
    });
  }

  async setTimer(minutes, delayMinutes, rpm) {
    await this._command(async (conn) => {
      const cur = P.parseTimer(await conn.read(P.CHAR.TIMER));
      const delay = (delayMinutes === null || delayMinutes === undefined) ? cur.delayMinutes : Number(delayMinutes);
      await conn.write(P.CHAR.TIMER, P.buildTimer(
        minutes || cur.minutes, delay > 0, delay, rpm || cur.rpm,
      ));
    });
  }

  /* ---------------- settings ---------------- */

  async onSettings({ newSettings, changedKeys }) {
    const has = (prefix) => changedKeys.some((k) => k.indexOf(prefix) === 0);
    const n = newSettings;

    if (changedKeys.includes('auth_key') && n.auth_key) {
      P.parseAuthCode(n.auth_key); // throws a readable error if invalid
    }

    const needsWrite = has('boost_') || has('humidity_') || has('airing_') || has('timer_');
    if (needsWrite) {
      if (!n.auth_key) throw new Error(this.homey.__('errors.no_auth'));
      // Settings are stored after onSettings resolves, so pass the new values explicitly.
      await this._session(async (conn) => {
        if (has('boost_')) {
          const b = P.parseBoost(await conn.read(P.CHAR.BOOST));
          if (b.enabled) await conn.write(P.CHAR.BOOST, P.buildBoost(true, n.boost_rpm, n.boost_seconds));
        }
        if (has('humidity_')) {
          const h = P.parseHumidity(await conn.read(P.CHAR.HUMIDITY));
          await conn.write(P.CHAR.HUMIDITY, P.buildHumidity(h.enabled, h.detection || 2, n.humidity_rpm));
        }
        if (has('airing_')) {
          const a = P.parseAiring(await conn.read(P.CHAR.AIRING));
          await conn.write(P.CHAR.AIRING, P.buildAiring(a.enabled, a.minutes || 30, n.airing_rpm));
        }
        if (has('timer_')) {
          await conn.write(P.CHAR.TIMER, P.buildTimer(
            n.timer_minutes, n.timer_delay_enabled, n.timer_delay_minutes, n.timer_rpm,
          ));
        }
      }, { requireAuth: true, authKey: n.auth_key, readBack: false });
    }

    this.refreshSoon(needsWrite ? 3000 : 1000);
    return undefined;
  }
}

module.exports = SkyDevice;
