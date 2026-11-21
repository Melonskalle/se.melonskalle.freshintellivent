'use strict';

const Homey = require('homey');
const P = require('../../lib/protocol');
const FreshConnection = require('../../lib/FreshConnection');

class SkyDriver extends Homey.Driver {
  async onInit() {
    this._registerFlowCards();
  }

  _registerFlowCards() {
    const h = this.homey.flow;

    this.modeChangedTrigger = h.getDeviceTriggerCard('mode_changed');
    this.boostStartedTrigger = h.getDeviceTriggerCard('boost_started');
    this.boostStoppedTrigger = h.getDeviceTriggerCard('boost_stopped');

    h.getConditionCard('boost_active')
      .registerRunListener(async ({ device }) => device.getCapabilityValue('fresh_boost') === true);
    h.getConditionCard('mode_is')
      .registerRunListener(async ({ device, mode }) => device.getCapabilityValue('fresh_mode') === mode);

    h.getActionCard('boost_start')
      .registerRunListener(async ({ device, rpm, minutes }) => device.startBoost(rpm, minutes));
    h.getActionCard('boost_stop')
      .registerRunListener(async ({ device }) => device.setBoost(false));
    h.getActionCard('constant_speed_on')
      .registerRunListener(async ({ device, rpm }) => device.setConstantSpeed(true, rpm));
    h.getActionCard('constant_speed_off')
      .registerRunListener(async ({ device }) => device.setConstantSpeed(false));
    h.getActionCard('pause_start')
      .registerRunListener(async ({ device, minutes }) => device.setPause(true, minutes));
    h.getActionCard('pause_stop')
      .registerRunListener(async ({ device }) => device.setPause(false, 0));
    h.getActionCard('set_humidity')
      .registerRunListener(async ({ device, detection, rpm }) => device.setHumidityMode(detection, rpm));
  }

  async _discover() {
    const advertisements = await this.homey.ble.discover([], 15000);
    return advertisements.filter((adv) => {
      const name = adv.localName || '';
      return P.DEVICE_NAMES.some((n) => name.indexOf(n) === 0) || /intellivent/i.test(name);
    });
  }

  async onPair(session) {
    let found = [];
    let selected = null;

    session.setHandler('list_devices', async () => {
      found = await this._discover();
      const existing = this.getDevices().map((d) => d.getData().id);
      return found
        .filter((adv) => !existing.includes(adv.uuid))
        .map((adv) => ({
          name: adv.localName || 'Intellivent SKY',
          data: { id: adv.uuid },
          store: { peripheralUuid: adv.uuid, address: adv.address },
        }));
    });

    session.setHandler('list_devices_selection', async (devices) => {
      selected = devices && devices[0] ? devices[0] : null;
    });

    session.setHandler('get_selected', async () => selected);

    const job = this._codeJob();
    session.setHandler('fetch_code_start', async () => {
      if (!selected) throw new Error(this.homey.__('pair.no_device'));
      const adv = found.find((a) => a.uuid === selected.data.id);
      return job.start(() => this._fetchCode(selected.store.peripheralUuid, adv));
    });
    session.setHandler('fetch_code_status', async () => job.status());

    session.setHandler('validate_code', async (code) => P.parseAuthCode(code).toString('hex'));
  }

  async onRepair(session, device) {
    session.setHandler('get_selected', async () => ({ name: device.getName() }));
    const job = this._codeJob();
    session.setHandler('fetch_code_start', async () => job.start(() => device.runExclusive(
      () => this._fetchCode(device.getStoreValue('peripheralUuid') || device.getData().id),
    )));
    session.setHandler('fetch_code_status', async () => job.status());
    session.setHandler('validate_code', async (code) => P.parseAuthCode(code).toString('hex'));
    session.setHandler('save_code', async (code) => {
      const hex = code ? P.parseAuthCode(code).toString('hex') : '';
      await device.setSettings({ auth_key: hex });
      device.refreshSoon(1000);
      return true;
    });
  }

  /**
   * Runs the code fetch in the background. Homey cancels a pairing-view emit
   * after 30 s, and BLE connect + service discovery can take longer than that,
   * so the view starts the job and then polls for the result.
   */
  _codeJob() {
    let state = { state: 'idle' };
    return {
      start: (fn) => {
        if (state.state === 'running') return state;
        state = { state: 'running' };
        Promise.resolve()
          .then(fn)
          .then((code) => { state = { state: 'done', code }; })
          .catch((err) => {
            this.error('Fetch code failed:', err && err.message);
            state = { state: 'error', error: (err && err.message) || String(err) };
          });
        return state;
      },
      status: () => state,
    };
  }

  async _fetchCode(peripheralUuid, advertisement) {
    const conn = new FreshConnection(this.homey, peripheralUuid, this.log.bind(this));
    try {
      await conn.open({ advertisement, attempts: 4 });
      const code = await conn.fetchAuthCode();
      // Confirm the code actually unlocks the fan before handing it back.
      const ok = await conn.authenticate(code).catch((err) => {
        this.error('Verifying code failed:', err.message);
        return null;
      });
      this.log(`Fetched code, verified: ${ok}`);
      return code;
    } finally {
      await conn.close();
    }
  }

}

module.exports = SkyDriver;
