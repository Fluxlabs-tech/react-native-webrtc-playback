import { MediaStream, RTCPeerConnection } from 'react-native-webrtc';
import { RECOMMENDED_RTC_CONFIGURATION } from 'react-native-webrtc-playback';

import type { MediaClientCallbacks } from './types';

export const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun1.l.google.com:19302' }];

/**
 * A peer connection for playing, wired to the client callbacks.
 *
 * The `on*` properties rather than addEventListener: react-native-webrtc's
 * typings lean on whichever event-target-shim npm hoists, and v5's declares no
 * addEventListener. The event payloads are untyped there either way.
 */
export function createPlaybackPeerConnection(
  callbacks: MediaClientCallbacks,
  handlers: {
    onIceCandidate?: (candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }) => void;
    onIceFailed: () => void;
  }
): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers: DEFAULT_ICE_SERVERS,
    // Not in react-native-webrtc's types, but read by its native side.
    ...(RECOMMENDED_RTC_CONFIGURATION as object),
  });
  pc.ontrack = (event: unknown) => {
    const [stream] = (event as { streams: MediaStream[] }).streams;
    if (stream) callbacks.onStream(stream);
  };
  pc.onicecandidate = (event: unknown) => {
    const { candidate } = event as {
      candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null;
    };
    if (candidate) handlers.onIceCandidate?.(candidate);
  };
  pc.oniceconnectionstatechange = () => {
    callbacks.onState(`ice ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed') handlers.onIceFailed();
  };
  return pc;
}
