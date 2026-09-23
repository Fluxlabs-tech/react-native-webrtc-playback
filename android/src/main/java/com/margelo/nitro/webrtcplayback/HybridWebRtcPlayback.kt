package com.margelo.nitro.webrtcplayback

import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip

/**
 * The JS handle on the playout path. The path itself is installed by
 * [WebRtcPlaybackInitProvider] at process start; this only reads it back and
 * switches the leveller.
 */
@DoNotStrip
@Keep
class HybridWebRtcPlayback : HybridWebRtcPlaybackSpec() {
  override val isInstalled: Boolean
    get() = WebRtcPlaybackInstaller.isInstalled

  override val isPlaying: Boolean
    get() = WebRtcPlaybackInstaller.isPlaying

  override val config: WebRtcPlaybackConfig
    get() {
      val installed = WebRtcPlaybackInstaller.config
      return WebRtcPlaybackConfig(
        playoutDelayMs = installed.playoutDelayMs.toDouble(),
        maxPlayoutDelayMs = installed.maxPlayoutDelayMs.toDouble(),
        leveller = installed.leveller,
        levellerInputGainDb = installed.levellerInputGainDb.toDouble(),
        manageAudioSession = false,
        audioFocus = installed.audioFocus,
        networkResilience = installed.networkResilience,
      )
    }

  override var levellerEnabled: Boolean
    get() = WebRtcPlaybackInstaller.levellerEnabled
    set(value) {
      WebRtcPlaybackInstaller.levellerEnabled = value
    }

  /** DynamicsProcessing exposes no metering, so Android has nothing to report. */
  override fun takeLevels(): PlayoutLevels? = null
}
