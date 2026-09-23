# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-24

First release.

### Added

- Play-only audio path: RemoteIO under a `.playback` session on iOS, and
  `USAGE_MEDIA` / `CONTENT_TYPE_MUSIC` playout on Android.
- Voice leveller (input gain, soft-knee compressor, −1 dBFS limiter): in
  software on iOS, `DynamicsProcessing` on Android with a `LoudnessEnhancer`
  fallback.
- Network resilience: full round-trip resend wait and a 1 MB socket receive
  buffer; 2× playout buffer on Android; `RECOMMENDED_RTC_CONFIGURATION`.
- Optional playout delay, with audio held back to match on iOS.
- Audio focus handling on Android.
- Expo config plugin with validated options (`enabled`, `leveller`,
  `levellerInputGainDb`, `networkResilience`, `playoutDelayMs`,
  `maxPlayoutDelayMs`, `ios.manageAudioSession`, `android.audioFocus`).
- JS API: `getWebRtcPlayback()`, `isWebRtcPlaybackInstalled()`, runtime
  `levellerEnabled`, and `takeLevels()` metering on iOS.
- Example app (Expo SDK 57) with WHEP and Ant Media clients.

[Unreleased]: https://github.com/Fluxlabs-tech/react-native-webrtc-playback/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Fluxlabs-tech/react-native-webrtc-playback/releases/tag/v0.1.0
