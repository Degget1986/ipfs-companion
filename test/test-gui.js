var gui = require('./gui.js');
var gw = require('./gateways.js');
var prefs = require('sdk/simple-prefs').prefs;
const button = gui.toggleButton;

let {
  before
} = require('sdk/test/utils');
before(exports, function(name, assert) { // jshint unused:false
  // reset redirect state before each test
  gw.enableHttpGatewayRedirect(button);
});

exports['test toggleButton attributes'] = function(assert) {
  assert.equal(button.id, 'ipfs-gateway-status', 'button id');
  assert.equal(button.checked, prefs.useCustomGateway, 'default state equal prefs.useCustomGateway');
};

exports['test disabled toggleButton'] = function(assert) {
  gw.disableHttpGatewayRedirect(button);
  assert.equal(button.checked, prefs.useCustomGateway, 'state after gw.disableHttpGatewayRedirect()');
};

exports['test enabled toggleButton'] = function(assert) {
  gw.enableHttpGatewayRedirect(button);
  assert.equal(button.checked, prefs.useCustomGateway, 'state after gw.enableHttpGatewayRedirect()');
};

require('sdk/test').run(exports);