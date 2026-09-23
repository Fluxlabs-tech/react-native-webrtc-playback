import NitroModules

/// The JS handle on the playout device. The device itself is installed from
/// `+load` in WRPAudioDevice.m, before any JS runs; this only reads it back and
/// switches the leveller.
class HybridWebRtcPlayback: HybridWebRtcPlaybackSpec {
  var isInstalled: Bool {
    return WRPIsInstalled()
  }

  var isPlaying: Bool {
    return WRPIsPlaying()
  }

  var config: WebRtcPlaybackConfig {
    let installed = WRPGetInstallConfig()
    return WebRtcPlaybackConfig(
      playoutDelayMs: installed.playoutDelayMs,
      maxPlayoutDelayMs: installed.maxPlayoutDelayMs,
      leveller: installed.leveller,
      levellerInputGainDb: installed.levellerInputGainDb,
      manageAudioSession: installed.manageAudioSession,
      audioFocus: false,
      networkResilience: installed.networkResilience
    )
  }

  var levellerEnabled: Bool {
    get { return WRPGetLevellerEnabled() }
    set { WRPSetLevellerEnabled(newValue) }
  }

  func takeLevels() throws -> PlayoutLevels? {
    var input = 0.0
    var output = 0.0
    var reduction = 0.0
    guard WRPTakeLevels(&input, &output, &reduction) else { return nil }
    return PlayoutLevels(inputPeakDb: input, outputPeakDb: output, maxReductionDb: reduction)
  }
}
