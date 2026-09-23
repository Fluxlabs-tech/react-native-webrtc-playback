import { useEffect, useState } from 'react';
import type { RTCPeerConnection } from 'react-native-webrtc';

/** What a viewer's peer connection received over the last interval. */
export interface ReceiveStats {
  resolution: string;
  fps: number;
  videoKbps: number;
  audioKbps: number;
  /** Average time a video frame waited in the jitter buffer, in ms. */
  videoBufferMs: number;
  /** Average time an audio sample waited in the jitter buffer, in ms. */
  audioBufferMs: number;
  /** Freezes since playback started, and how long they lasted in total. */
  freezes: number;
  freezeSeconds: number;
  videoLossPercent: number;
  /** Share of audio samples libwebrtc had to conceal (packet loss, underrun). */
  audioConcealedPercent: number;
  rttMs: number;
}

const INTERVAL_MS = 2000;

type Report = Record<string, any>;

/** Polls `getStats` while `pc` is set, and turns the cumulative counters into per-interval numbers. */
export function useReceiveStats(pc: RTCPeerConnection | null): ReceiveStats | null {
  const [stats, setStats] = useState<ReceiveStats | null>(null);

  useEffect(() => {
    setStats(null);
    if (!pc) return;
    let previous: Record<string, Report> = {};
    const timer = setInterval(async () => {
      const current: Record<string, Report> = {};
      let rttMs = -1;
      try {
        const report = await pc.getStats();
        report.forEach((entry: Report) => {
          if (entry.type === 'inbound-rtp') current[entry.kind] = entry;
          if (entry.type === 'candidate-pair' && entry.nominated && entry.state === 'succeeded') {
            rttMs = Math.round((entry.currentRoundTripTime ?? -0.001) * 1000);
          }
        });
      } catch {
        return;
      }
      const delta = (kind: string, field: string) =>
        (current[kind]?.[field] ?? 0) - (previous[kind]?.[field] ?? 0);
      const perEmitted = (kind: string) => {
        const emitted = delta(kind, 'jitterBufferEmittedCount');
        return emitted > 0 ? Math.round((delta(kind, 'jitterBufferDelay') / emitted) * 1000) : 0;
      };
      const received = delta('video', 'packetsReceived');
      const lost = delta('video', 'packetsLost');
      const samples = delta('audio', 'totalSamplesReceived');
      const video = current.video ?? {};
      setStats({
        resolution: video.frameWidth ? `${video.frameWidth}×${video.frameHeight}` : '—',
        fps: Math.round(video.framesPerSecond ?? 0),
        videoKbps: Math.round((delta('video', 'bytesReceived') * 8) / INTERVAL_MS),
        audioKbps: Math.round((delta('audio', 'bytesReceived') * 8) / INTERVAL_MS),
        videoBufferMs: perEmitted('video'),
        audioBufferMs: perEmitted('audio'),
        freezes: video.freezeCount ?? 0,
        freezeSeconds: video.totalFreezesDuration ?? 0,
        videoLossPercent: received + lost > 0 ? (100 * lost) / (received + lost) : 0,
        audioConcealedPercent: samples > 0 ? (100 * delta('audio', 'concealedSamples')) / samples : 0,
        rttMs,
      });
      previous = current;
    }, INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pc]);

  return stats;
}
