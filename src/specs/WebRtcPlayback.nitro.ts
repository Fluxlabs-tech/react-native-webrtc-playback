import type { HybridObject } from 'react-native-nitro-modules'

/**
 * The settings the native side installed with, read back.
 *
 * They are fixed for the life of the process: react-native-webrtc builds its
 * audio device and field trials once, before JS runs, so they come from the
 * config plugin (Info.plist / AndroidManifest), not from JS.
 */
export interface WebRtcPlaybackConfig {
  /**
   * How far behind live the stream plays, in ms. 0 is WebRTC's own behaviour:
   * each frame rendered the moment it can be.
   */
  readonly playoutDelayMs: number
  /** How far the playout delay may drift under heavy jitter, in ms. */
  readonly maxPlayoutDelayMs: number
  /** Whether the voice leveller was built into the playout path. */
  readonly leveller: boolean
  /** The leveller's input gain, in dB. */
  readonly levellerInputGainDb: number
  /**
   * iOS: the package owns the audio session while playing (`.playback` /
   * `.moviePlayback`). Always `false` on Android.
   */
  readonly manageAudioSession: boolean
  /** Android: the stream takes audio focus while playing. Always `false` on iOS. */
  readonly audioFocus: boolean
  /** Wait a whole round trip for a resend, and a 1 MB socket receive buffer. */
  readonly networkResilience: boolean
}

/** Peak levels through the leveller since the previous read. */
export interface PlayoutLevels {
  /** Loudest sample WebRTC handed over, in dBFS. -120 is silence. */
  readonly inputPeakDb: number
  /** Loudest sample played out, in dBFS. Never above the -1 dBFS ceiling. */
  readonly outputPeakDb: number
  /** Deepest gain reduction applied (compressor + limiter), in dB. */
  readonly maxReductionDb: number
}

/**
 * Runtime handle on the playout path installed at app launch.
 */
export interface WebRtcPlayback
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  /**
   * The playout path is in place. `false` when the config plugin disabled it,
   * or when another audio device was already set on react-native-webrtc.
   */
  readonly isInstalled: boolean
  /** WebRTC audio is playing through the package right now. */
  readonly isPlaying: boolean
  /** What the native side installed with. */
  readonly config: WebRtcPlaybackConfig
  /**
   * Turns the leveller on or off while playing — for A/B listening. No effect
   * when the leveller was not installed (`config.leveller` is `false`).
   */
  levellerEnabled: boolean
  /**
   * Peak levels since the previous call, and resets them. `undefined` where the
   * platform cannot meter the playout path (Android), or before audio has
   * played.
   */
  takeLevels(): PlayoutLevels | undefined
}
