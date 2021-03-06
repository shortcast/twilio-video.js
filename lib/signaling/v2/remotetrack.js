'use strict';

const RemoteTrackSignaling = require('../remotetrack');

/**
 * @extends RemoteTrackSignaling
 */
class RemoteTrackV2 extends RemoteTrackSignaling {
  /**
   * Construct a {@link RemoteTrackV2}.
   * @param {RemoteTrackV2#Representation} track
   */
  constructor(track) {
    super(track.sid, track.name, track.id, track.kind, track.enabled);
  }

  /**
   * Compare the {@link RemoteTrackV2} to a {@link RemoteTrackV2#Representation} of itself
   * and perform any updates necessary.
   * @param {RemoteTrackV2#Representation} track
   * @returns {this}
   * @fires TrackSignaling#updated
   */
  update(track) {
    this.enable(track.enabled);
    return this;
  }
}

/**
 * The Room Signaling Protocol (RSP) representation of a {@link RemoteTrackV2}
 * @typedef {LocalTrackPublicationV2#Representation} RemoteTrackV2#Representation
 * @property (boolean} subscribed
 */

module.exports = RemoteTrackV2;
