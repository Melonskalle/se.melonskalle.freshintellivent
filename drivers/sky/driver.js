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

    session.setHandler('fetch_code', async () => {
      if (!selected) throw new Error(this.homey.__('pair.no_device'));
      const adv = found.find((a) => a.uuid === selected.data.id);
      return this._fetchCode(selected.store.peripheralUuid, adv);
    });

    session.setHandler('validate_code', async (code) => P.parseAuthCode(code).toString('hex'));
  }

  async onRepair(session, device) {
    session.setHandler('get_selected', async () => ({ name: device.getName() }));
    session.setHandler('fetch_code', async () => device.runExclusive(
      () => this._fetchCode(device.getStoreValue('peripheralUuid') || device.getData().id),
    ));
    session.setHandler('validate_code', async (code) => P.parseAuthCode(code).toString('hex'));
    session.setHandler('save_code', async (code) => {
      const hex = code ? P.parseAuthCode(code).toString('hex') : '';
      await device.setSettings({ auth_key: hex });
      device.refreshSoon(1000);
      return true;
    });
  }

  async _fetchCode(peripheralUuid, advertisement) {
    const conn = new FreshConnection(this.homey, peripheralUuid, this.log.bind(this));
    try {
      await conn.open({ advertisement });
      return await conn.fetchAuthCode();
    } finally {
      await conn.close();
    }
  }
}

module.exports = SkyDriver;
