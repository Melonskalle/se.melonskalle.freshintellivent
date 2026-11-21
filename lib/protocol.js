'use strict';

/**
 * Fresh Intellivent Sky BLE protocol.
 * Port of pyfreshintellivent 0.3.4 (parser.py, sensors.py, characteristics.py).
 * All values are little-endian.
 */

const CHAR = {
  // Standard Device Information service
  MODEL_NUMBER: '2a24',
  FIRMWARE_VERSION: '2a26',
  HARDWARE_VERSION: '2a27',
  SOFTWARE_VERSION: '2a28',
  MANUFACTURER_NAME: '2a29',

  DEVICE_NAME: 'b85fa07a93824838871c81d045dcc2ff',
  DEVICE_STATUS: '528b80e8c47a4c0abdf1916a7748f412',
  AUTH: '4cad343a209a40b7b9114d9b3df569b2',

  HUMIDITY: '7c4adc012f3311e793ae92361f002671',
  LIGHT_VOC: '7c4adc022f3311e793ae92361f002671',
  CONSTANT_SPEED: '7c4adc032f3311e793ae92361f002671',
  TIMER: '7c4adc042f3311e793ae92361f002671',
  AIRING: '7c4adc052f3311e793ae92361f002671',
  PAUSE: '7c4adc062f3311e793ae92361f002671',
  BOOST: '7c4adc072f3311e793ae92361f002671',
  TEMPORARY_SPEED: '7c4adc082f3311e793ae92361f002671',
};

const DEVICE_NAMES = ['Intellivent SKY', 'Intellivent ICE'];

const MODES = {
  0: 'off',
  6: 'pause',
  16: 'constant_speed',
  34: 'light',
  35: 'timer',
  49: 'humidity',
  52: 'voc',
  103: 'boost',
};

const RPM_MIN = 800;
const RPM_MAX = 2400;

/** Normalise a UUID to lowercase hex without dashes; 16-bit SIG UUIDs become 4 chars. */
function normalizeUuid(uuid) {
  let u = String(uuid).toLowerCase().replace(/[^0-9a-f]/g, '');
  const m = /^0000([0-9a-f]{4})00001000800000805f9b34fb$/.exec(u);
  if (m) u = m[1];
  return u;
}

function clampRpm(rpm) {
  const v = Math.round(Number(rpm) || 0);
  if (v < RPM_MIN) return RPM_MIN;
  if (v > RPM_MAX) return RPM_MAX;
  return v;
}

function clampTime(v) {
  const n = Math.round(Number(v) || 0);
  return n < 0 ? 0 : n;
}

function clampByte(v) {
  const n = clampTime(v);
  return n > 255 ? 255 : n;
}

function clampU16(v) {
  const n = clampTime(v);
  return n > 65535 ? 65535 : n;
}

function clampDetection(v) {
  const n = Math.round(Number(v) || 0);
  if (n < 0) return 0;
  if (n > 3) return 3;
  return n;
}

function assertLen(buf, len, what) {
  if (!buf || buf.length !== len) {
    throw new Error(`${what}: expected ${len} bytes, got ${buf ? buf.length : 0}`);
  }
}

/* ---------- auth code ---------- */

function parseAuthCode(value) {
  if (value === null || value === undefined || value === '') {
    throw new Error('Authentication code cannot be empty');
  }
  let buf;
  if (Buffer.isBuffer(value)) {
    buf = value;
  } else {
    const s = String(value).trim().toLowerCase().replace(/[^0-9a-f]/g, '');
    if (s.length !== 8) throw new Error('Authentication code must be 8 hex characters');
    buf = Buffer.from(s, 'hex');
  }
  if (buf.length !== 4) throw new Error('Authentication code must be 4 bytes');
  if (buf.equals(Buffer.alloc(4))) throw new Error('Fan was not in pairing mode (code is 00000000)');
  return buf;
}

/* ---------- status (15 bytes, "<2B2H2B2H3B") ---------- */

function parseStatus(buf) {
  assertLen(buf, 15, 'status');
  const modeRaw = buf.readUInt8(1);
  const humRaw = buf.readUInt16LE(2);
  return {
    status: buf.readUInt8(0) !== 0,
    modeRaw,
    mode: MODES[modeRaw] || 'unknown',
    humidity: humRaw !== 0 ? Math.round(Math.log(humRaw / 10) * 10 * 10) / 10 : null,
    temperature: buf.readUInt16LE(4) / 100,
    authenticated: buf.readUInt8(7) !== 0,
    rpm: buf.readUInt16LE(8),
    temperatureAvg: buf.readUInt16LE(10) / 100,
    unknowns: [buf.readUInt8(6), buf.readUInt8(12), buf.readUInt8(13), buf.readUInt8(14)],
  };
}

/* ---------- boost (5 bytes, "<?2H") ---------- */

function parseBoost(buf) {
  assertLen(buf, 5, 'boost');
  return { enabled: buf.readUInt8(0) !== 0, rpm: buf.readUInt16LE(1), seconds: buf.readUInt16LE(3) };
}

function buildBoost(enabled, rpm, seconds) {
  const b = Buffer.alloc(5);
  b.writeUInt8(enabled ? 1 : 0, 0);
  b.writeUInt16LE(clampRpm(rpm), 1);
  b.writeUInt16LE(clampU16(seconds), 3);
  return b;
}

/* ---------- constant speed (3 bytes, "<?H") ---------- */

function parseConstantSpeed(buf) {
  assertLen(buf, 3, 'constant speed');
  return { enabled: buf.readUInt8(0) !== 0, rpm: buf.readUInt16LE(1) };
}

function buildConstantSpeed(enabled, rpm) {
  const b = Buffer.alloc(3);
  b.writeUInt8(enabled ? 1 : 0, 0);
  b.writeUInt16LE(clampRpm(rpm), 1);
  return b;
}

/* ---------- temporary speed (3 bytes, "<?H") ---------- */

function buildTemporarySpeed(enabled, rpm) {
  return buildConstantSpeed(enabled, rpm);
}

/* ---------- humidity (4 bytes, "<?BH") ---------- */

function parseHumidity(buf) {
  assertLen(buf, 4, 'humidity');
  return { enabled: buf.readUInt8(0) !== 0, detection: buf.readUInt8(1), rpm: buf.readUInt16LE(2) };
}

function buildHumidity(enabled, detection, rpm) {
  const b = Buffer.alloc(4);
  b.writeUInt8(enabled ? 1 : 0, 0);
  b.writeUInt8(clampDetection(detection), 1);
  b.writeUInt16LE(clampRpm(rpm), 2);
  return b;
}

/* ---------- light & VOC (4 bytes, "<?B?B") ---------- */

function parseLightVoc(buf) {
  assertLen(buf, 4, 'light/voc');
  return {
    lightEnabled: buf.readUInt8(0) !== 0,
    lightDetection: buf.readUInt8(1),
    vocEnabled: buf.readUInt8(2) !== 0,
    vocDetection: buf.readUInt8(3),
  };
}

function buildLightVoc(lightEnabled, lightDetection, vocEnabled, vocDetection) {
  const b = Buffer.alloc(4);
  b.writeUInt8(lightEnabled ? 1 : 0, 0);
  b.writeUInt8(clampDetection(lightDetection), 1);
  b.writeUInt8(vocEnabled ? 1 : 0, 2);
  b.writeUInt8(clampDetection(vocDetection), 3);
  return b;
}

/* ---------- airing (5 bytes, "<?2BH", byte 1 is always 26) ---------- */

function parseAiring(buf) {
  assertLen(buf, 5, 'airing');
  return { enabled: buf.readUInt8(0) !== 0, minutes: buf.readUInt8(2), rpm: buf.readUInt16LE(3) };
}

function buildAiring(enabled, minutes, rpm) {
  const b = Buffer.alloc(5);
  b.writeUInt8(enabled ? 1 : 0, 0);
  b.writeUInt8(26, 1);
  b.writeUInt8(clampByte(minutes), 2);
  b.writeUInt16LE(clampRpm(rpm), 3);
  return b;
}

/* ---------- pause (2 bytes, "<?B") ---------- */

function parsePause(buf) {
  assertLen(buf, 2, 'pause');
  return { enabled: buf.readUInt8(0) !== 0, minutes: buf.readUInt8(1) };
}

function buildPause(enabled, minutes) {
  const b = Buffer.alloc(2);
  b.writeUInt8(enabled ? 1 : 0, 0);
  b.writeUInt8(clampByte(minutes), 1);
  return b;
}

/* ---------- timer (5 bytes, "<B?BH") ---------- */

function parseTimer(buf) {
  assertLen(buf, 5, 'timer');
  return {
    minutes: buf.readUInt8(0),
    delayEnabled: buf.readUInt8(1) !== 0,
    delayMinutes: buf.readUInt8(2),
    rpm: buf.readUInt16LE(3),
  };
}

function buildTimer(minutes, delayEnabled, delayMinutes, rpm) {
  const b = Buffer.alloc(5);
  b.writeUInt8(clampByte(minutes), 0);
  b.writeUInt8(delayEnabled ? 1 : 0, 1);
  b.writeUInt8(clampByte(delayMinutes), 2);
  b.writeUInt16LE(clampRpm(rpm), 3);
  return b;
}

function decodeString(buf) {
  return Buffer.from(buf || []).toString('utf8').replace(/\0/g, '').trim();
}

module.exports = {
  CHAR,
  DEVICE_NAMES,
  MODES,
  RPM_MIN,
  RPM_MAX,
  normalizeUuid,
  clampRpm,
  parseAuthCode,
  parseStatus,
  parseBoost,
  buildBoost,
  parseConstantSpeed,
  buildConstantSpeed,
  buildTemporarySpeed,
  parseHumidity,
  buildHumidity,
  parseLightVoc,
  buildLightVoc,
  parseAiring,
  buildAiring,
  parsePause,
  buildPause,
  parseTimer,
  buildTimer,
  decodeString,
};
