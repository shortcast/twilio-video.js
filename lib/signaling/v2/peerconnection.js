'use strict';

const WebRTC = require('@twilio/webrtc');
const DefaultMediaStream = WebRTC.MediaStream;
const DefaultRTCIceCandidate = WebRTC.RTCIceCandidate;
const DefaultRTCPeerConnection = WebRTC.RTCPeerConnection;
const DefaultRTCSessionDescription = WebRTC.RTCSessionDescription;
const getStatistics = WebRTC.getStats;
const getMediaSections = require('../../util/sdp').getMediaSections;
const guessBrowser = require('../../util').guessBrowser;
const oncePerTick = require('../../util').oncePerTick;
const setBitrateParameters = require('../../util/sdp').setBitrateParameters;
const setCodecPreferences = require('../../util/sdp').setCodecPreferences;
const setSimulcast = require('../../util/sdp').setSimulcast;
const IceBox = require('./icebox');
const MediaClientLocalDescFailedError = require('../../util/twilio-video-errors').MediaClientLocalDescFailedError;
const MediaClientRemoteDescFailedError = require('../../util/twilio-video-errors').MediaClientRemoteDescFailedError;
const DataTrackReceiver = require('../../data/receiver');
const MediaTrackReceiver = require('../../media/track/receiver');
const StateMachine = require('../../statemachine');
const StatsReport = require('../../stats/statsreport');
const { buildLogLevels } = require('../../util');
const { DEFAULT_LOG_LEVEL } = require('../../util/constants');
const Log = require('../../util/log');
const IdentityTrackMatcher = require('../../util/sdp/trackmatcher/identity');
const OrderedTrackMatcher = require('../../util/sdp/trackmatcher/ordered');
const MIDTrackMatcher = require('../../util/sdp/trackmatcher/mid');
const workaroundIssue8329 = require('../../util/sdp/issue8329');

const isChrome = guessBrowser() === 'chrome';
const isFirefox = guessBrowser() === 'firefox';
const isSafari = guessBrowser() === 'safari';

/*
PeerConnectionV2 States
-----------------------

    +------+    +--------+
    |      |    |        |
    | open |--->| closed |
    |      |    |        |
    +------+    +--------+
      |  ^          ^
      |  |          |
      |  |          |
      v  |          |
  +----------+      |
  |          |      |
  | updating |------+
  |          |
  +----------+

*/

const states = {
  open: [
    'closed',
    'updating'
  ],
  updating: [
    'closed',
    'open'
  ],
  closed: []
};

/**
 * @extends StateMachine
 * @property {id}
 * @emits PeerConnectionV2#iceConnectionStateChanged
 * @emits PeerConnectionV2#candidates
 * @emits PeerConnectionV2#description
 */
class PeerConnectionV2 extends StateMachine {
  /**
   * Construct a {@link PeerConnectionV2}.
   * @param {string} id
   * @param {EncodingParametersImpl} encodingParameters
   * @param {PreferredCodecs} preferredCodecs
   * @param {object} [options]
   */
  constructor(id, encodingParameters, preferredCodecs, options) {
    super('open', states);

    options = Object.assign({
      iceServers: [],
      logLevel: DEFAULT_LOG_LEVEL,
      offerOptions: {},
      setBitrateParameters,
      setCodecPreferences,
      setSimulcast,
      MediaStream: DefaultMediaStream,
      RTCIceCandidate: DefaultRTCIceCandidate,
      RTCPeerConnection: DefaultRTCPeerConnection,
      RTCSessionDescription: DefaultRTCSessionDescription
    }, options);

    const configuration = getConfiguration(options);
    const logLevels = buildLogLevels(options.logLevel);
    const RTCPeerConnection = options.RTCPeerConnection;
    const peerConnection = new RTCPeerConnection(configuration);

    Object.defineProperties(this, {
      _dataChannels: {
        value: new Map()
      },
      _dataTrackReceivers: {
        value: new Set()
      },
      _descriptionRevision: {
        writable: true,
        value: 0
      },
      _encodingParameters: {
        value: encodingParameters
      },
      _isRestartingIce: {
        writable: true,
        value: false
      },
      _lastIceConnectionState: {
        writable: true,
        value: null
      },
      _lastStableDescriptionRevision: {
        writable: true,
        value: 0
      },
      _localCandidates: {
        writable: true,
        value: []
      },
      _localCandidatesRevision: {
        writable: true,
        value: 1
      },
      _localDescription: {
        writable: true,
        value: null
      },
      _localMediaStream: {
        value: new options.MediaStream()
      },
      _localUfrag: {
        writable: true,
        value: null
      },
      _log: {
        value: options.log
          ? options.log.createLog('signaling', this)
          : new Log('webrtc', this, logLevels),
      },
      _rtpSenders: {
        value: new Map()
      },
      _mediaTrackReceivers: {
        value: new Set()
      },
      _needsInitialAnswer: {
        writable: true,
        value: false
      },
      _negotiationRole: {
        writable: true,
        value: null
      },
      _offerOptions: {
        writable: true,
        value: options.offerOptions
      },
      _peerConnection: {
        value: peerConnection
      },
      _preferredAudioCodecs: {
        value: preferredCodecs.audio
      },
      _preferredVideoCodecs: {
        value: preferredCodecs.video
      },
      _queuedDescription: {
        writable: true,
        value: null
      },
      _remoteCandidates: {
        writable: true,
        value: new IceBox()
      },
      _setBitrateParameters: {
        value: options.setBitrateParameters
      },
      _setCodecPreferences: {
        value: options.setCodecPreferences
      },
      _setSimulcast: {
        value: options.setSimulcast
      },
      _RTCIceCandidate: {
        value: options.RTCIceCandidate
      },
      _RTCPeerConnection: {
        value: options.RTCPeerConnection
      },
      _RTCSessionDescription: {
        value: options.RTCSessionDescription
      },
      _shouldOffer: {
        writable: true,
        value: false
      },
      _shouldRestartIce: {
        writable: true,
        value: false
      },
      _trackIdsToAttributes: {
        value: new Map()
      },
      _trackMatcher: {
        writable: true,
        value: null
      },
      id: {
        enumerable: true,
        value: id
      }
    });

    encodingParameters.on('changed', oncePerTick(this.offer.bind(this)));
    peerConnection.addEventListener('datachannel', this._handleDataChannelEvent.bind(this));
    peerConnection.addEventListener('icecandidate', this._handleIceCandidateEvent.bind(this));
    peerConnection.addEventListener('iceconnectionstatechange', this._handleIceConnectionStateChange.bind(this));
    peerConnection.addEventListener('signalingstatechange', this._handleSignalingStateChange.bind(this));
    peerConnection.addEventListener('track', this._handleTrackEvent.bind(this));

    const self = this;
    this.on('stateChanged', function stateChanged(state) {
      if (state !== 'closed') {
        return;
      }
      self.removeListener('stateChanged', stateChanged);
      self._dataChannels.forEach((dataChannel, dataTrackSender) => {
        self.removeDataTrackSender(dataTrackSender);
      });
    });
  }

  /**
   * The {@link PeerConnectionV2}'s underlying RTCPeerConnection's
   * RTCIceConnectionState.
   * @property {RTCIceConnectionState}
   */
  get iceConnectionState() {
    return this._peerConnection.iceConnectionState;
  }

  /**
   * Add an ICE candidate to the {@link PeerConnectionV2}.
   * @private
   * @param {object} candidate
   * @returns {Promise<void>}
   */
  _addIceCandidate(candidate) {
    return Promise.resolve().then(() => {
      candidate = new this._RTCIceCandidate(candidate);
      return this._peerConnection.addIceCandidate(candidate);
    });
  }

  /**
   * Add ICE candidates to the {@link PeerConnectionV2}.
   * @private
   * @param {Array<object>} candidates
   * @returns {Promise<void>}
   */
  _addIceCandidates(candidates) {
    return Promise.all(candidates.map(this._addIceCandidate, this)).then(() => {});
  }

  /**
   * Check the {@link IceBox}.
   * @private
   * @param {RTCSessionDescriptionInit} description
   * @returns {Promise<void>}
   */
  _checkIceBox(description) {
    const ufrag = getUfrag(description);
    if (!ufrag) {
      return Promise.resolve();
    }
    const candidates = this._remoteCandidates.setUfrag(ufrag);
    return this._addIceCandidates(candidates);
  }

  /**
   * Create an answer and set it on the {@link PeerConnectionV2}.
   * @private
   * @param {RTCSessionDescriptionInit} offer
   * @returns {Promise<void>}
   */
  _answer(offer) {
    return Promise.resolve().then(() => {
      if (!this._negotiationRole) {
        this._negotiationRole = 'answerer';
      }
      return this._setRemoteDescription(offer);
    }).catch(() => {
      throw new MediaClientRemoteDescFailedError();
    }).then(() => this._peerConnection.createAnswer()).then(answer => {
      if (!isFirefox) {
        answer = workaroundIssue8329(answer);
      }
      return this._setLocalDescription(answer);
    }).then(() => this._checkIceBox(offer)).then(() => this._peerConnection.localDescription
      ? this._maybeReoffer(this._peerConnection.localDescription)
      : Promise.resolve()).catch(error => {
      throw error instanceof MediaClientRemoteDescFailedError
        ? error
        : new MediaClientLocalDescFailedError();
    });
  }

  /**
   * Close the underlying RTCPeerConnection. Returns false if the
   * RTCPeerConnection was already closed.
   * @private
   * @returns {boolean}
   */
  _close() {
    if (this._peerConnection.signalingState !== 'closed') {
      this._peerConnection.close();
      return true;
    }
    return false;
  }

  /**
   * Handle a "datachannel" event.
   * @private
   * @param {RTCDataChannelEvent} event
   * @returns {void}
   */
  _handleDataChannelEvent(event) {
    const dataChannel = event.channel;
    const dataTrackReceiver = new DataTrackReceiver(dataChannel);
    this._dataTrackReceivers.add(dataTrackReceiver);

    dataChannel.addEventListener('close', () => {
      this._dataTrackReceivers.delete(dataTrackReceiver);
    });

    this.emit('trackAdded', dataTrackReceiver);
  }

  /**
   * Handle a glare scenario on the {@link PeerConnectionV2}.
   * @private
   * @param {RTCSessionDescriptionInit} offer
   * @returns {Promise<void>}
   */
  _handleGlare(offer) {
    this._log.debug('Glare detected; rolling back');
    if (this._isRestartingIce) {
      this._log.debug('An ICE restart was in progress; we\'ll need to restart ICE again after rolling back');
      this._isRestartingIce = false;
      this._shouldRestartIce = true;
    }
    return Promise.resolve().then(() => this._setLocalDescription({ type: 'rollback' })).then(() => this._answer(offer)).then(() => this._offer());
  }

  /**
   * Handle an ICE candidate event.
   * @private
   * @param {Event} event
   * @returns {void}
   */
  _handleIceCandidateEvent(event) {
    if (event.candidate) {
      this._localCandidates.push(event.candidate);
    }
    const peerConnectionState = {
      ice: {
        candidates: this._localCandidates.slice(),
        revision: this._localCandidatesRevision++,
        ufrag: this._localUfrag
      },
      id: this.id
    };
    if (!event.candidate) {
      peerConnectionState.ice.complete = true;
    }
    this.emit('candidates', peerConnectionState);
  }

  /**
   * Handle an ICE connection state change event.
   * @private
   * @returns {void}
   */
  _handleIceConnectionStateChange() {
    const { iceConnectionState } = this._peerConnection;

    this._log.debug(`ICE connection state is "${iceConnectionState}"`);

    // Case 1: Transition to "failed".
    if (this._lastIceConnectionState !== 'failed' && iceConnectionState === 'failed' && !this._shouldRestartIce && !this._isRestartingIce) {
      this._log.warn('ICE failed; attempting to restart ICE');
      this._shouldRestartIce = true;
      this.offer();
    }

    // Case 2: Transition from "failed".
    else if (this._lastIceConnectionState === 'failed' && (iceConnectionState === 'connected' || iceConnectionState === 'completed')) {
      this._log.info('ICE reconnected');
    }

    this._lastIceConnectionState = iceConnectionState;
    this.emit('iceConnectionStateChanged');
  }

  /**
   * Handle a signaling state change event.
   * @private
   * @param {Event}
   * @returns {void}
   */
  _handleSignalingStateChange() {
    if (this._peerConnection.signalingState === 'closed' && this.state !== 'closed') {
      this.preempt('closed');
    }
  }

  /**
   * Handle a track event.
   * @private
   * @param {Event} event
   * @returns {void}
   */
  _handleTrackEvent(event) {
    const sdp = this._peerConnection.remoteDescription
      ? this._peerConnection.remoteDescription.sdp
      : null;

    if (!this._trackMatcher) {
      this._trackMatcher = event.transceiver && event.transceiver.mid
        ? new MIDTrackMatcher()
        : isSafari ? new OrderedTrackMatcher() : new IdentityTrackMatcher();
    }
    this._trackMatcher.update(sdp);

    const mediaStreamTrack = event.track;
    const signaledTrackId = this._trackMatcher.match(event) || mediaStreamTrack.id;
    const mediaTrackReceiver = new MediaTrackReceiver(signaledTrackId, mediaStreamTrack);
    this._mediaTrackReceivers.add(mediaTrackReceiver);

    mediaStreamTrack.addEventListener('ended', () => {
      this._mediaTrackReceivers.delete(mediaTrackReceiver);
    });

    this.emit('trackAdded', mediaTrackReceiver);
  }

  /**
   * Conditionally re-offer.
   * @private
   * @param {RTCSessionDescriptionInit} localDescription
   * @returns {Promise<void>}
   */
  _maybeReoffer(localDescription) {
    let shouldReoffer = this._shouldOffer;

    // NOTE(mmalavalli): In Firefox, if the remote RTCPeerConnection sends
    // an offer with fewer audio m= lines than the number of audio RTCRTPSenders
    // in the local RTCPeerConnection, then the local RTCPeerConnection creates
    // an answer with the same number of audio m= lines as in the offer. This
    // behavior was triggered by the removal of 'offerToReceiveAudio' from the
    // default RTCOfferOptions. Ideally, the local RTCPeerConnection should create
    // an answer with the same number of audio m= lines as the number of
    // RTCRTPSenders. In order to achieve this,the local RTCPeerConnection
    // initiates renegotiation.
    //
    // We can reduce the number of cases where renegotiation is needed by
    // re-introducing 'offerToReceiveAudio' to the default RTCOfferOptions with a
    // value > 1.
    if (isFirefox) {
      const senders = this._peerConnection.getSenders().filter(sender => sender.track);
      shouldReoffer = ['audio', 'video'].reduce((shouldOffer, kind) => {
        const mediaSections = getMediaSections(localDescription.sdp, kind, '(sendrecv|sendonly)');
        const sendersOfKind = senders.filter(isSenderOfKind.bind(null, kind));
        return shouldOffer || (mediaSections.length < sendersOfKind.length);
      }, shouldReoffer);
    }

    // NOTE(mroberts): We also need to re-offer if we have a DataTrack to share
    // but no m= application section.
    const hasDataTrack = this._dataChannels.size > 0;
    const hasApplicationMediaSection = getMediaSections(localDescription.sdp, 'application').length > 0;
    const needsApplicationMediaSection = hasDataTrack && !hasApplicationMediaSection;
    shouldReoffer = shouldReoffer || needsApplicationMediaSection;

    return shouldReoffer ? this._offer() : Promise.resolve();
  }

  /**
   * Create an offer and set it on the {@link PeerConnectionV2}.
   * @private
   * @returns {Promise<void>}
   */
  _offer() {
    const offerOptions = Object.assign({}, this._offerOptions);
    if (this._shouldRestartIce) {
      this._shouldRestartIce = false;
      this._isRestartingIce = true;
      offerOptions.iceRestart = true;
    }
    return Promise.resolve().then(() => this._peerConnection.createOffer(offerOptions)).catch(() => {
      throw new MediaClientLocalDescFailedError();
    }).then(offer => {
      if (!isFirefox) {
        offer = workaroundIssue8329(offer);
      }

      const updatedSdp = this._setCodecPreferences(
        offer.sdp,
        this._preferredAudioCodecs,
        this._preferredVideoCodecs);

      this._shouldOffer = false;
      if (!this._negotiationRole) {
        this._negotiationRole = 'offerer';
        this._needsInitialAnswer = true;
      }
      return this._setLocalDescription({
        type: 'offer',
        sdp: updatedSdp
      });
    });
  }

  /**
   * Set a local description on the {@link PeerConnectionV2}.
   * @private
   * @param {RTCSessionDescription|RTCSessionDescriptionInit} description
   * @returns {Promise<void>}
   */
  _setLocalDescription(description) {
    const revision = description.revision;
    const vp8SimulcastRequested = this._preferredVideoCodecs.some(codecSettings => codecSettings.codec.toLowerCase() === 'vp8' && codecSettings.simulcast);

    return Promise.resolve().then(() => {
      if (description.sdp) {
        // NOTE(mmalavalli): We do not directly modify "description.sdp" here as
        // "description" might be an RTCSessionDescription, in which case its
        // properties are immutable.
        description = {
          type: description.type,
          sdp: isChrome && vp8SimulcastRequested
            ? this._setSimulcast(description.sdp, this._trackIdsToAttributes)
            : description.sdp
        };
      }
      description = new this._RTCSessionDescription(description);
      if (description.type === 'answer') {
        this._lastStableDescriptionRevision = revision;
      }
      return this._peerConnection.setLocalDescription(description);
    }).catch(error => {
      this._log.warn(`Calling setLocalDescription with an RTCSessionDescription of type "${description.type}" failed with the error "${error.message}".`);
      if (description.sdp) {
        this._log.warn(`The SDP was ${description.sdp}`);
      }
      throw new MediaClientLocalDescFailedError();
    }).then(() => {
      if (description.type !== 'rollback') {
        this._localDescription = description;
        this._localCandidates = [];
        if (description.type === 'offer') {
          this._descriptionRevision++;
        }
        this._localUfrag = getUfrag(description);
        this.emit('description', this.getState());
      }
    });
  }

  /**
   * Set a remote RTCSessionDescription on the {@link PeerConnectionV2}.
   * @private
   * @param {RTCSessionDescriptionInit} description
   * @returns {Promise<void>}
   */
  _setRemoteDescription(description) {
    if (description.sdp) {
      description.sdp = this._setBitrateParameters(
        description.sdp,
        isFirefox ? 'TIAS' : 'AS',
        this._encodingParameters.maxAudioBitrate,
        this._encodingParameters.maxVideoBitrate);
      description.sdp = this._setCodecPreferences(
        description.sdp,
        this._preferredAudioCodecs,
        this._preferredVideoCodecs);
    }
    description = new this._RTCSessionDescription(description);
    return this._peerConnection.setRemoteDescription(description).then(() => {
      if (description.type === 'answer' && this._isRestartingIce) {
        this._log.debug('An ICE restart was in-progress and is now completed');
        this._isRestartingIce = false;
      }
    }, error => {
      this._log.warn(`Calling setRemoteDescription with an RTCSessionDescription of type "${description.type}" failed with the error "${error.message}".`);
      if (description.sdp) {
        this._log.warn(`The SDP was ${description.sdp}`);
      }
      throw error;
    });
  }

  /**
   * Update the {@link PeerConnectionV2}'s description.
   * @private
   * @param {RTCSessionDescriptionInit} description
   * @returns {Promise<void>}
   */
  _updateDescription(description) {
    switch (description.type) {
      case 'answer':
      case 'pranswer':
        if (description.revision !== this._descriptionRevision
          || this._peerConnection.signalingState !== 'have-local-offer') {
          return Promise.resolve();
        }
        this._descriptionRevision = description.revision;
        break;
      case 'close':
        return this._close();
      case 'create-offer':
        if (description.revision <= this._lastStableDescriptionRevision) {
          return Promise.resolve();
        } else if (this._needsInitialAnswer) {
          this._queuedDescription = description;
          return Promise.resolve();
        }
        this._descriptionRevision = description.revision;
        return this._offer();
      case 'offer':
        if (description.revision <= this._lastStableDescriptionRevision
          || this._peerConnection.signalingState === 'closed') {
          return Promise.resolve();
        }
        if (this._peerConnection.signalingState === 'have-local-offer') {
          if (this._needsInitialAnswer) {
            this._queuedDescription = description;
            return Promise.resolve();
          }
          this._descriptionRevision = description.revision;
          return this._handleGlare(description);
        }
        this._descriptionRevision = description.revision;
        return this._answer(description);
      default:
        // Do nothing.
    }

    // Handle answer or pranswer.
    const revision = description.revision;
    return Promise.resolve().then(() => {
      if (description.type === 'answer') {
        this._lastStableDescriptionRevision = revision;
      }
      return this._setRemoteDescription(description);
    }).catch(() => {
      throw new MediaClientRemoteDescFailedError();
    }).then(() => {
      if (description.type === 'answer') {
        this._needsInitialAnswer = false;
      }
      return this._checkIceBox(description);
    }).then(() => this._queuedDescription && this._updateDescription(this._queuedDescription)).then(() => {
      this._queuedDescription = null;
      return this._peerConnection.localDescription
        ? this._maybeReoffer(this._peerConnection.localDescription)
        : Promise.resolve();
    });
  }

  /**
   * Update the {@link PeerConnectionV2}'s ICE candidates.
   * @private
   * @param {object} iceState
   * @returns {Promise<void>}
   */
  _updateIce(iceState) {
    const candidates = this._remoteCandidates.update(iceState);
    return this._addIceCandidates(candidates);
  }

  /**
   * Add a {@link DataTrackSender} to the {@link PeerConnectionV2}.
   * @param {DataTrackSender} dataTrackSender
   * @returns {void}
   */
  addDataTrackSender(dataTrackSender) {
    if (this._dataChannels.has(dataTrackSender)) {
      return;
    }
    try {
      const dataChannelDict = {
        ordered: dataTrackSender.ordered
      };
      if (dataTrackSender.maxPacketLifeTime !== null) {
        dataChannelDict.maxPacketLifeTime = dataTrackSender.maxPacketLifeTime;
      }
      if (dataTrackSender.maxRetransmits !== null) {
        dataChannelDict.maxRetransmits = dataTrackSender.maxRetransmits;
      }
      const dataChannel = this._peerConnection.createDataChannel(dataTrackSender.id, dataChannelDict);
      dataTrackSender.addDataChannel(dataChannel);
      this._dataChannels.set(dataTrackSender, dataChannel);
    } catch (error) {
      // Do nothing.
    }
  }

  /**
   * Add the {@link MediaTrackSender} to the {@link PeerConnectionV2}.
   * @param {MediaTrackSender} mediaTrackSender
   * @returns {void}
   */
  addMediaTrackSender(mediaTrackSender) {
    if (this._peerConnection.signalingState === 'closed' || this._rtpSenders.has(mediaTrackSender)) {
      return;
    }
    this._localMediaStream.addTrack(mediaTrackSender.track);
    const sender = this._peerConnection.addTrack(mediaTrackSender.track, this._localMediaStream);
    mediaTrackSender.addSender(sender);
    this._rtpSenders.set(mediaTrackSender, sender);
  }

  /**
   * Close the {@link PeerConnectionV2}.
   * @returns {void}
   */
  close() {
    if (this._close()) {
      this._descriptionRevision++;
      this._localDescription = { type: 'close' };
      this.emit('description', this.getState());
    }
  }

  /**
   * Get the {@link DataTrackReceiver}s and the {@link MediaTrackReceivers} on the
   * {@link PeerConnectionV2}.
   * @returns {Array<DataTrackReceiver|MediaTrackReceiver>} trackReceivers
   */
  getTrackReceivers() {
    return Array.from(this._dataTrackReceivers).concat(Array.from(this._mediaTrackReceivers));
  }

  /**
   * Get the {@link PeerConnectionV2}'s state (specifically, its description).
   * @returns {?object}
   */
  getState() {
    if (!this._localDescription) {
      return null;
    }
    const localDescription = {
      type: this._localDescription.type,
      revision: this._descriptionRevision
    };
    if (this._localDescription.sdp) {
      localDescription.sdp = this._localDescription.sdp;
    }
    return {
      description: localDescription,
      id: this.id
    };
  }

  /**
   * Create an offer and set it on the {@link PeerConnectionV2}.
   * @returns {Promise<void>}
   */
  offer() {
    if (this._needsInitialAnswer || this._isRestartingIce) {
      this._shouldOffer = true;
      return Promise.resolve();
    }

    return this.bracket('offering', key => {
      this.transition('updating', key);
      return this._offer().then(() => {
        this.tryTransition('open', key);
      }, error => {
        this.tryTransition('open', key);
        throw error;
      });
    });
  }

  /**
   * Remove a {@link DataTrackSender} from the {@link PeerConnectionV2}.
   * @param {DataTrackSender} dataTrackSender
   * @returns {void}
   */
  removeDataTrackSender(dataTrackSender) {
    const dataChannel = this._dataChannels.get(dataTrackSender);
    if (dataChannel) {
      dataTrackSender.removeDataChannel(dataChannel);
      this._dataChannels.delete(dataTrackSender);
      dataChannel.close();
    }
  }

  /**
   * Remove the {@link MediaTrackSender} from the {@link PeerConnectionV2}.
   * @param {MediaTrackSender} mediaTrackSender
   * @returns {void}
   */
  removeMediaTrackSender(mediaTrackSender) {
    if (this._peerConnection.signalingState === 'closed' || !this._rtpSenders.has(mediaTrackSender)) {
      return;
    }
    const sender = this._rtpSenders.get(mediaTrackSender);
    this._peerConnection.removeTrack(sender);
    this._localMediaStream.removeTrack(mediaTrackSender.track);
    mediaTrackSender.removeSender(sender);
    this._rtpSenders.delete(mediaTrackSender);
  }

  /**
   * Set the RTCConfiguration on the underlying RTCPeerConnection.
   * @param {RTCConfiguration} configuration
   * @returns {void}
   */
  setConfiguration(configuration) {
    if (typeof this._peerConnection.setConfiguration === 'function') {
      this._peerConnection.setConfiguration(getConfiguration(configuration));
    }
  }

  /**
   * Update the {@link PeerConnectionV2}.
   * @param {object} peerConnectionState
   * @returns {Promise<void>}
   */
  update(peerConnectionState) {
    return this.bracket('updating', key => {
      if (this.state === 'closed') {
        return Promise.resolve();
      }

      this.transition('updating', key);

      const updates = [];

      if (peerConnectionState.ice) {
        updates.push(this._updateIce(peerConnectionState.ice));
      }

      if (peerConnectionState.description) {
        updates.push(this._updateDescription(peerConnectionState.description));
      }

      return Promise.all(updates).then(() => {
        this.tryTransition('open', key);
      }, error => {
        this.tryTransition('open', key);
        throw error;
      });
    });
  }

  /**
   * Get the {@link PeerConnectionV2}'s media statistics.
   * @returns {Promise<StatsReport>}
   */
  getStats() {
    return getStatistics(this._peerConnection).then(statsResponse => new StatsReport(this.id, statsResponse));
  }
}

/**
 * @event PeerConnectionV2#candidates
 * @param {object} candidates
 */

/**
 * @event PeerConnectionV2#description
 * @param {object} description
 */

/**
 * @event PeerConnectionV2#iceConnectionStateChanged
 */

/**
 * @event PeerConnectionV2#trackAdded
 * @param {DataTrackReceiver|MediaTrackReceiver} trackReceiver
 */

function getUfrag(description) {
  if (description.sdp) {
    const match = description.sdp.match(/^a=ice-ufrag:([a-zA-Z0-9+/]+)/m);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function getConfiguration(configuration) {
  return Object.assign({
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  }, configuration);
}

/**
 * Whether the MediaStreamTrack of the given RTCRTPSender is a non-ended
 * MediaStreamTrack of a given kind.
 * @private
 * @param {string} kind
 * @param {RTCRTPSender} sender
 * @return {boolean}
 */
function isSenderOfKind(kind, sender) {
  const track = sender.track;
  return track && track.kind === kind && track.readyState !== 'ended';
}

/**
 * Preferred codecs.
 * @typedef {object} PreferredCodecs
 * @property {Array<AudioCodec>} audio
 * @property {Array<VideoCodec>} video
 */

module.exports = PeerConnectionV2;
