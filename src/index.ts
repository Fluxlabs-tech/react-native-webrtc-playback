import { NitroModules } from 'react-native-nitro-modules'

import type { WebRtcPlayback as WebRtcPlaybackSpec } from './specs/WebRtcPlayback.nitro'

export type {
  PlayoutLevels,
  WebRtcPlayback,
  WebRtcPlaybackConfig,
} from './specs/WebRtcPlayback.nitro'

let hybrid: WebRtcPlaybackSpec | null | undefined

/**
 * The runtime handle, or `null` when the binary does not carry the native side
 * (Expo Go, web, a build from before the package was added). Created on first
 * call, so importing this module never throws.
 */
export function getWebRtcPlayback(): WebRtcPlaybackSpec | null {
  if (hybrid === undefined) {
    try {
      hybrid = NitroModules.createHybridObject<WebRtcPlaybackSpec>('WebRtcPlayback')
    } catch {
      hybrid = null
    }
  }
  return hybrid
}

/**
 * `true` when the playout path is in place, so a caller knows not to boost the
 * remote track itself: `MediaStreamTrack._setVolume` is a saturating multiply
 * inside libwebrtc, and any gain above 1 clips before the leveller sees it.
 */
export function isWebRtcPlaybackInstalled(): boolean {
  return getWebRtcPlayback()?.isInstalled === true
}

/**
 * Receive-side `RTCConfiguration` entries to spread into `new RTCPeerConnection`.
 *
 * Android's jitter buffer defaults to 50 packets (one second of audio), so the
 * burst after a network stall overflows it and the buffer is flushed — a skip.
 * 200 is libwebrtc's own default, which iOS and browsers already use. It is
 * also the headroom a playout delay needs to hold audio back.
 */
export const RECOMMENDED_RTC_CONFIGURATION = {
  audioJitterBufferMaxPackets: 200,
} as const
