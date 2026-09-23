import { RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';

import { createPlaybackPeerConnection } from './peerConnection';
import type { MediaClient, MediaClientCallbacks, MediaSource } from './types';

type AntMediaSource = Extract<MediaSource, { kind: 'ant-media' }>;

const RETRY_DELAY_MS = 2000;
const PING_INTERVAL_MS = 3000;

interface SignalingMessage {
  command?: string;
  definition?: string;
  type?: 'offer' | 'answer';
  sdp?: string;
  label?: number;
  id?: string;
  candidate?: string;
}

/**
 * Ant Media Server's WebSocket signalling, play-only.
 *
 * Handshake (the server is the offerer for playback):
 *   1. open WS → { command: "play", streamId, token }
 *   2. server → { command: "takeConfiguration", type: "offer", sdp }
 *      → setRemoteDescription, createAnswer, send the answer back
 *   3. ICE candidates both ways via { command: "takeCandidate" }
 *
 * "no_stream_exist" (nobody publishing yet) re-asks after a delay; any other
 * failure tears down and reconnects.
 */
export class AntMediaClient implements MediaClient {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly source: AntMediaSource,
    private readonly callbacks: MediaClientCallbacks
  ) {}

  get peerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.send({ command: 'stop', streamId: this.source.streamId });
    this.teardown();
    this.callbacks.onState('stopped');
  }

  private send(message: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private teardown(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pc?.close();
    this.pc = null;
    if (this.ws) {
      this.ws.onopen = this.ws.onclose = this.ws.onerror = this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private schedule(reason: string, rebuild: boolean): void {
    if (this.stopped || this.retryTimer) return;
    this.callbacks.onState(`${reason} — retrying`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (rebuild) {
        this.teardown();
        this.connect();
      } else {
        this.play();
      }
    }, RETRY_DELAY_MS);
  }

  private play(): void {
    this.send({ command: 'play', streamId: this.source.streamId, token: this.source.token ?? '' });
  }

  private createPeerConnection(): RTCPeerConnection {
    return createPlaybackPeerConnection(this.callbacks, {
      onIceCandidate: (candidate) =>
        this.send({
          command: 'takeCandidate',
          streamId: this.source.streamId,
          label: candidate.sdpMLineIndex,
          id: candidate.sdpMid,
          candidate: candidate.candidate,
        }),
      onIceFailed: () => this.schedule('ice failed', true),
    });
  }

  private async onMessage(raw: string): Promise<void> {
    let message: SignalingMessage;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    switch (message.command) {
      case 'takeConfiguration':
        if (message.type !== 'offer' || !message.sdp) return;
        try {
          this.pc ??= this.createPeerConnection();
          await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: message.sdp }));
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.send({
            command: 'takeConfiguration',
            streamId: this.source.streamId,
            type: 'answer',
            sdp: answer.sdp,
          });
        } catch (error) {
          this.schedule(`sdp error (${String(error)})`, true);
        }
        return;
      case 'takeCandidate':
        if (!this.pc || !message.candidate) return;
        this.pc
          .addIceCandidate(
            new RTCIceCandidate({
              candidate: message.candidate,
              sdpMid: message.id ?? null,
              sdpMLineIndex: message.label ?? null,
            })
          )
          .catch(() => {});
        return;
      case 'notification':
        if (message.definition === 'play_started') this.callbacks.onState('playing');
        if (message.definition === 'play_finished') this.schedule('publisher stopped', true);
        return;
      case 'error':
        if (message.definition === 'no_stream_exist') this.schedule('not publishing yet', false);
        else this.schedule(`server error (${message.definition})`, true);
        return;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.callbacks.onState('connecting');
    this.pc = this.createPeerConnection();
    const ws = new WebSocket(this.source.signalingUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.play();
      // Ant Media closes idle sockets.
      this.pingTimer = setInterval(() => this.send({ command: 'ping' }), PING_INTERVAL_MS);
    };
    ws.onmessage = (event) => void this.onMessage(String(event.data));
    ws.onerror = () => this.schedule('websocket error', true);
    ws.onclose = () => this.schedule('websocket closed', true);
  }
}
