'use strict';

const Homey = require('homey');

class FreshIntelliventApp extends Homey.App {
  async onInit() {
    this.log('Fresh Intellivent app started');
  }
}

module.exports = FreshIntelliventApp;
