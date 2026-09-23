import type { MediaStream, RTCPeerConnection } from 'react-native-webrtc';

/**
 * Where to play from. WHEP is the IETF standard for WebRTC playback and what
 * most servers speak (Ant Media, mediamtx, SRS, OvenMediaEngine, Janus,
 * Cloudflare Stream, Dolby/Millicast, Wowza, Red5). Ant Media's own WebSocket
 * signalling is kept for servers older than its WHEP support.
 */
export type MediaSource =
  | {
      kind: 'whep';
      /** The WHEP endpoint the offer is POSTed to. */
      url: string;
      /** Sent as `Authorization: Bearer <token>` when set. */
      token?: string;
    }
  | {
      kind: 'ant-media';
      /** e.g. wss://<host>:5443/WebRTCAppEE/websocket */
      signalingUrl: string;
      streamId: string;
      token?: string;
    };

export interface MediaClientCallbacks {
  onStream: (stream: MediaStream) => void;
  onState: (state: string) => void;
}

/** One play-only WebRTC session, whatever signalling sets it up. */
export interface MediaClient {
  start(): void;
  stop(): void;
  /** The live peer connection, for `getStats`. */
  readonly peerConnection: RTCPeerConnection | null;
}
