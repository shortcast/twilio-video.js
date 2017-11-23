'use strict';

var inherits = require('util').inherits;
var WebSocket = require('ws');

var InsightsPublisher = require('../../util/insightspublisher');
var NullInsightsPublisher = require('../../util/insightspublisher/null');
var packageInfo = require('../../../package.json');
var StateMachine = require('../../statemachine');
var util = require('../../util');

var SDK_NAME = packageInfo.name + '.js';
var SDK_VERSION = packageInfo.version;
var VERSION = 1;

/*
WebSocketTransport States
-------------------------

                      +-----------+
                      |           |
                      |  syncing  |---------+
                      |           |         |
                      +-----------+         |
                         ^     |            |
                         |     |            |
                         |     v            v
    +------------+    +-----------+    +--------------+
    |            |    |           |    |              |
    | connecting |--->| connected |--->| disconnected |
    |            |    |           |    |              |
    +------------+    +-----------+    +--------------+
             |                              ^
             |                              |
             |                              |
             +------------------------------+

*/

var states = {
  connecting: [
    'connected',
    'disconnected'
  ],
  connected: [
    'disconnected',
    'syncing'
  ],
  syncing: [
    'connected',
    'disconnected'
  ],
  disconnected: []
};

/**
 * Construct a {@link WebSocketTransport}.
 * @extends StateMachine
 * @class
 * @classdesc A {@link WebSocketTransport} supports sending and receiving Room Signaling
 * Protocol (RSP) messages. It also supports RSP requests, such as Sync and
 * Disconnect.
 * @param {string} name
 * @param {string} wsServer
 * @param {string} accessToken
 * @param {ParticipantSignaling} localParticipant
 * @param {PeerConnectionManager} peerConnectionManager
 * @param {object} [options]
 * @emits WebSocketTransport#connected
 * @emits WebSocketTransport#message
 */
function WebSocketTransport(name, wsServer, accessToken, localParticipant, peerConnectionManager, options) {
  if (!(this instanceof WebSocketTransport)) {
    return new WebSocketTransport(name, wsServer, accessToken, localParticipant, peerConnectionManager, options);
  }
  options = Object.assign({
    InsightsPublisher: InsightsPublisher,
    NullInsightsPublisher: NullInsightsPublisher
  }, options);
  StateMachine.call(this, 'connecting', states);

  var eventPublisherOptions = {};
  if (options.wsServerInsights) {
    eventPublisherOptions.gateway = options.wsServerInsights;
  }

  var socket = new WebSocket(wsServer);
  var EventPublisher = options.insights ? options.InsightsPublisher : options.NullInsightsPublisher;

  Object.defineProperties(this, {
    _eventPublisher: {
      value: new EventPublisher(
        accessToken,
        SDK_NAME,
        SDK_VERSION,
        options.environment,
        options.realm,
      eventPublisherOptions)
    },
    _localParticipant: {
      value: localParticipant
    },
    _messagesToSend: {
      value: []
    },
    _name: {
      value: name
    },
    _peerConnectionManager: {
      value: peerConnectionManager
    },
    _session: {
      value: null,
      writable: true
    },
    _socket: {
      value: socket
    },
    _token: {
      value: accessToken
    },
    _updatesReceived: {
      value: []
    },
    _updatesToSend: {
      value: []
    }
  });
  setupWebSocket(this, socket);
}

inherits(WebSocketTransport, StateMachine);

WebSocketTransport.prototype._close = function _close() {
  this._socket.close();
};

WebSocketTransport.prototype._send = function _send(message) {
  message = Object.assign({}, message);
  if (this._session !== null) {
    message.session = this._session;
  }
  if (this._socket.readyState === WebSocket.OPEN) {
    this._socket.send(JSON.stringify(message));
    return;
  }
  this._messagesToSend.push(message);
};

WebSocketTransport.prototype._sendConnectOrSyncOrDisconnect = function _sendConnectOrSyncOrDisconnect() {
  if (this.state === 'disconnected') {
    return {
      type: 'disconnect',
      version: VERSION
    };
  }
  var type = {
    connecting: 'connect',
    syncing: 'sync'
  }[this.state] || 'update';

  var message = {
    name: this._name,
    participant: this._localParticipant.getState(),
    type: type,
    version: VERSION,
    token: this._token
  };

  var sdpFormat = util.getSdpFormat();
  if (type === 'connect' && sdpFormat) {
    message.format = sdpFormat;
  }

  message.peer_connections = this._peerConnectionManager.getStates();

  this._send(message);
};

/**
 * Disconnect the {@link WebSocketTransport}. Returns true if calling the method resulted
 * in disconnection.
 * @returns {boolean}
 */
WebSocketTransport.prototype.disconnect = function disconnect() {
  if (this.state !== 'disconnected') {
    this.preempt('disconnected');
    this._send({
      type: 'disconnect',
      version: VERSION
    });
    this._close();
    this._eventPublisher.disconnect();
    return true;
  }
  return false;
};

/**
 * Publish an RSP Update. Returns true if calling the method resulted in
 * publishing (or eventually publishing) the update.
 * @param {object} update
 * @returns {boolean}
 */
WebSocketTransport.prototype.publish = function publish(update) {
  update = Object.assign({
    type: 'update',
    version: VERSION
  }, update);
  switch (this.state) {
    case 'connected':
      this._send(update);
      return true;
    case 'connecting':
    case 'syncing':
      this._updatesToSend.push(update);
      return true;
    case 'disconnected':
    default:
      return false;
  }
};

/**
 * Publish (or queue) an event to the Insights gateway.
 * @method
 * @param {string} groupName - Event group name
 * @param {string} eventName - Event name
 * @param {object} payload - Event payload
 * @returns {boolean} true if queued or published, false if disconnected from the Insights gateway
 */
WebSocketTransport.prototype.publishEvent = function publishEvent(groupName, eventName, payload) {
  return this._eventPublisher.publish(groupName, eventName, payload);
};

/**
 * Sync the {@link WebSocketTransport}. Returns true if calling the method resulted in
 * syncing.
 * @returns {boolean}
 */
WebSocketTransport.prototype.sync = function sync() {
  if (this.state === 'connected') {
    this.preempt('syncing');
    // NOTE(mroberts): I doubt this works.
    this._sendConnectOrSyncOrDisconnect();
    return true;
  }
  return false;
};

/**
 * @event WebSocketTransport#connected
 * @param {object} initialState
 */

/**
 * @event WebSocketTransport#message
 * @param {object} state
 */

function reducePeerConnections(peerConnections) {
  return Array.from(peerConnections.reduce(function(peerConnectionsById, update) {
    var reduced = peerConnectionsById.get(update.id) || update;

    // First, reduce the top-level `description` property.
    if (!reduced.description && update.description) {
      reduced.description = update.description;
    } else if (reduced.description && update.description) {
      if (update.description.revision > reduced.description.revision) {
        reduced.description = update.description;
      }
    }

    // Then, reduce the top-level `ice` property.
    if (!reduced.ice && update.ice) {
      reduced.ice = update.ice;
    } else if (reduced.ice && update.ice) {
      if (update.ice.revision > reduced.ice.revision) {
        reduced.ice = update.ice;
      }
    }

    // Finally, update the map.
    peerConnectionsById.set(reduced.id, reduced);

    return peerConnectionsById;
  }, new Map()).values());
}

function reduceUpdates(updates) {
  return updates.reduce(function(reduced, update) {
    // First, reduce the top-level `participant` property.
    if (!reduced.participant && update.participant) {
      reduced.participant = update.participant;
    } else if (reduced.participant && update.participant) {
      if (update.participant.revision > reduced.participant.revision) {
        reduced.participant = update.participant;
      }
    }

    // Then, reduce the top-level `peer_connections` property.
    /* eslint camelcase:0 */
    if (!reduced.peer_connections && update.peer_connections) {
      reduced.peer_connections = reducePeerConnections(update.peer_connections);
    } else if (reduced.peer_connections && update.peer_connections) {
      reduced.peer_connections = reducePeerConnections(
        reduced.peer_connections.concat(update.peer_connections));
    }

    return reduced;
  }, {
    type: 'update',
    version: VERSION
  });
}

function setupWebSocket(transport, socket) {
  function disconnect() {
    transport.disconnect();
  }

  function handleRequestOrResponse(event) {
    var message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }

    switch (transport.state) {
      case 'connected':
        switch (message.type) {
          case 'connected':
          case 'synced':
          case 'update':
            transport.emit('message', message);
            return;
          case 'error':
          case 'disconnected':
            transport.disconnect();
            return;
          default:
            // Do nothing.
            return;
        }
      case 'connecting':
        switch (message.type) {
          case 'connected':
            transport._session = message.session;
            transport.emit('connected', message);
            transport.preempt('connected');
            return;
          case 'synced':
          case 'update':
            transport._updatesReceived.push(message);
            return;
          case 'error':
          case 'disconnected':
            transport.disconnect();
            return;
          default:
            // Do nothing.
            return;
        }
      case 'disconnected':
        // Do nothing.
        return;
      case 'syncing':
        switch (message.type) {
          case 'connected':
          case 'update':
            transport._updatesReceived.push(message);
            return;
          case 'synced':
            transport.emit('message', message);
            transport.preempt('connected');
            return;
          case 'disconnected':
          case 'error':
            transport.disconnect();
            return;
          default:
            // Do nothing.
            return;
        }
      default:
        // Impossible
        return;
    }
  }

  function open() {
    var messagesToSend = transport._messagesToSend.splice(0);
    messagesToSend.forEach(transport._send, transport);
  }

  socket.onclose = disconnect;
  socket.onerror = disconnect;
  socket.onmessage = handleRequestOrResponse;
  socket.onopen = open;

  transport.on('stateChanged', function stateChanged(state) {
    switch (state) {
      case 'connected':
        var updates = transport._updatesToSend.splice(0);
        if (updates.length) {
          transport.publish(reduceUpdates(updates));
        }

        transport._updatesReceived.splice(0).forEach(transport.emit.bind(transport, 'message'));

        return;
      case 'disconnected':
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        transport.removeListener('stateChanged', stateChanged);
        return;
      case 'syncing':
        // Do nothing.
        return;
      default:
        // Impossible
        return;
    }
  });

  transport._sendConnectOrSyncOrDisconnect();
}

module.exports = WebSocketTransport;
