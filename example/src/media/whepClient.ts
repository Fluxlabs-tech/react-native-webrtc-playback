import { RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';

import { createPlaybackPeerConnection } from './peerConnection';
import type { MediaClient, MediaClientCallbacks, MediaSource } from './types';

type WhepSource = Extract<MediaSource, { kind: 'whep' }>;

const RETRY_DELAY_MS = 2000;
/** Longest wait for ICE gathering before posting whatever candidates there are. */
const GATHER_TIMEOUT_MS = 2000;

/**
 * WHEP (WebRTC-HTTP Egress Protocol, RFC 9725) — the server-agnostic way to play.
 *
 *   1. offer with receive-only audio and video, gather ICE
 *   2. POST the offer (`application/sdp`) → 201 with the answer, and the
 *      session's URL in `Location`
 *   3. DELETE that URL to end the session
 *
 * ICE is gathered before posting rather than trickled: trickle over PATCH is
 * optional in WHEP and many servers skip it. A failed POST (most often: nobody
 * publishing yet) or a failed ICE session is retried.
 */
export class WhepClient implements MediaClient {
  private pc: RTCPeerConnection | null = null;
  private resourceUrl: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly source: WhepSource,
    private readonly callbacks: MediaClientCallbacks
  ) {}

  get peerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.teardown();
    this.callbacks.onState('stopped');
  }

  private headers(contentType?: string): Record<string, string> {
    return {
      ...(contentType ? { 'Content-Type': contentType } : {}),
      ...(this.source.token ? { Authorization: `Bearer ${this.source.token}` } : {}),
    };
  }

  private teardown(): void {
    // Best effort: a server that never hears the DELETE times the session out.
    if (this.resourceUrl) {
      fetch(this.resourceUrl, { method: 'DELETE', headers: this.headers() }).catch(() => {});
      this.resourceUrl = null;
    }
    this.pc?.close();
    this.pc = null;
  }

  private schedule(reason: string): void {
    if (this.stopped || this.retryTimer) return;
    this.callbacks.onState(`${reason} — retrying`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.teardown();
      void this.connect();
    }, RETRY_DELAY_MS);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.callbacks.onState('connecting');
    const pc = createPlaybackPeerConnection(this.callbacks, {
      onIceFailed: () => this.schedule('ice failed'),
    });
    this.pc = pc;
    try {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
      await pc.setLocalDescription(await pc.createOffer({}));
      await gatheringComplete(pc);

      const response = await fetch(this.source.url, {
        method: 'POST',
        headers: this.headers('application/sdp'),
        body: pc.localDescription?.sdp ?? '',
      });
      if (this.stopped || this.pc !== pc) return;
      if (response.status !== 201 && response.status !== 200) {
        this.schedule(`WHEP ${response.status}`);
        return;
      }
      const location = response.headers.get('Location');
      this.resourceUrl = location ? resolveUrl(this.source.url, location) : null;
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: await response.text() }));
      this.callbacks.onState('answered');
    } catch (error) {
      this.schedule(`WHEP error (${String(error)})`);
    }
  }
}

function gatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, GATHER_TIMEOUT_MS);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState !== 'complete') return;
      clearTimeout(timer);
      resolve();
    };
  });
}

/** `Location` may be relative to the endpoint. React Native's `URL` cannot resolve that. */
function resolveUrl(base: string, location: string): string {
  if (/^https?:\/\//i.test(location)) return location;
  const origin = base.match(/^https?:\/\/[^/]+/i)?.[0] ?? '';
  if (location.startsWith('/')) return origin + location;
  return base.replace(/[^/]*$/, '') + location;
}
