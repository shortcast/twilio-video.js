'use strict';

var defaultCreateCancelableRoomSignalingPromise = require('./websocketcancelableroomsignalingpromise');
var inherits = require('util').inherits;
var LocalParticipantV2 = require('./localparticipant');
var Signaling = require('../');

/**
 * Construct {@link WebSocketSignaling}.
 * @class
 * @classdesc {@link WebSocketSignaling} implements version 2 of our signaling
 * protocol.
 * @extends {Signaling}
 * @param {string} wsServer
 * @param {?object} [options={}]
 */
function WebSocketSignaling(wsServer, options) {
  /* eslint new-cap:0 */
  options = Object.assign({
    createCancelableRoomSignalingPromise: defaultCreateCancelableRoomSignalingPromise
  }, options);

  Signaling.call(this);

  Object.defineProperties(this, {
    _createCancelableRoomSignalingPromise: {
      value: options.createCancelableRoomSignalingPromise
    },
    _options: {
      value: options
    },
    _wsServer: {
      value: wsServer
    }
  });
}

inherits(WebSocketSignaling, Signaling);

WebSocketSignaling.prototype._close = function _close(key) {
  this.transition('closing', key);
  this.transition('closed', key);
  return Promise.resolve(this);
};

WebSocketSignaling.prototype._open = function _open(key) {
  this.transition('opening', key);
  this.transition('open', key);
  return Promise.resolve(this);
};

WebSocketSignaling.prototype._connect = function _connect(localParticipant, token, iceServerSource, encodingParameters, preferredCodecs, options) {
  options = Object.assign({}, this._options, options);

  return this._createCancelableRoomSignalingPromise.bind(
    null,
    this._wsServer,
    token,
    localParticipant,
    iceServerSource,
    encodingParameters,
    preferredCodecs,
    options);
};

WebSocketSignaling.prototype.createLocalParticipantSignaling = function createLocalParticipantSignaling(encodingParameters) {
  return new LocalParticipantV2(encodingParameters);
};

module.exports = WebSocketSignaling;
