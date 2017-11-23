'use strict';

var CancelablePromise = require('../../util/cancelablepromise');
var DefaultPeerConnectionManager = require('./peerconnectionmanager');
var DefaultRoomV2 = require('./room');
var DefaultWebSocketTransport = require('./websockettransport');
var flatMap = require('../../util').flatMap;
var SignalingConnectionDisconnectedError = require('../../util/twilio-video-errors').SignalingConnectionDisconnectedError;
var SignalingIncomingMessageInvalidError = require('../../util/twilio-video-errors').SignalingIncomingMessageInvalidError;

function createWebSocketCancelableRoomSignalingPromise(wsServer, token, localParticipant, iceServerSource, encodingParameters, preferredCodecs, options) {
  options = Object.assign({
    PeerConnectionManager: DefaultPeerConnectionManager,
    RoomV2: DefaultRoomV2,
    WebSocketTransport: DefaultWebSocketTransport
  }, options);

  var transport;

  var PeerConnectionManager = options.PeerConnectionManager;
  var RoomV2 = options.RoomV2;

  var peerConnectionManager = new PeerConnectionManager(iceServerSource, encodingParameters, preferredCodecs, options);

  var mediaStreamTracksAndDataTrackSenders = flatMap(localParticipant.tracks, function(track) {
    return [track.mediaStreamTrackOrDataTrackTransceiver];
  });

  peerConnectionManager.setConfiguration(options);
  peerConnectionManager.setMediaStreamTracksAndDataTrackSenders(mediaStreamTracksAndDataTrackSenders);

  var cancelationError = new Error('Canceled');

  return new CancelablePromise(function onCreate(resolve, reject, isCanceled) {
    peerConnectionManager.createAndOffer().then(function createAndOfferSucceeded() {
      // NOTE(mmalavalli): PeerConnectionManager#createAndOffer() queues the
      // initial offer in the event queue for the 'description' event. So,
      // we are dequeueing to prevent the spurious 'update' message sent by
      // the client after connecting to a room.
      peerConnectionManager.dequeue('description');

      return new Promise(function(resolve, reject) {
        if (isCanceled()) {
          reject(cancelationError);
          return;
        }

        var WebSocketTransport = options.WebSocketTransport;
        transport = new WebSocketTransport(
          options.name,
          wsServer,
          token,
          localParticipant,
          peerConnectionManager,
          options);

        transport.once('connected', function connected(initialState) {
          if (isCanceled()) {
            reject(cancelationError);
            return;
          }

          var localParticipantState = initialState.participant;
          if (!localParticipantState) {
            reject(new SignalingIncomingMessageInvalidError());
            return;
          }

          resolve(new RoomV2(localParticipant, initialState, transport, peerConnectionManager, options));
        });

        transport.once('stateChanged', function stateChanged(state, error) {
          if (state === 'disconnected') {
            error = error || new SignalingConnectionDisconnectedError();
            transport = null;
            reject(error);
          }
        });
      });
    }).then(function createRoomSignalingSucceeded(roomSignaling) {
      if (isCanceled()) {
        peerConnectionManager.close();
        roomSignaling.disconnect();
        reject(cancelationError);
        return;
      }
      resolve(roomSignaling);
    }).catch(function onError(error) {
      if (transport) {
        transport.disconnect();
        transport = null;
      }
      peerConnectionManager.close();
      reject(error);
    });
  }, function onCancel() {
    if (transport) {
      transport.disconnect();
      transport = null;
    }
  });
}

module.exports = createWebSocketCancelableRoomSignalingPromise;
