# react-native-webrtc-playback

Makes [react-native-webrtc](https://github.com/react-native-webrtc/react-native-webrtc) **playback** sound like media rather than a phone call, and ride out poor networks.

- **Media audio path.** iOS plays through RemoteIO under a `.playback` session instead of VoiceProcessingIO, the phone-call unit. Android plays as `USAGE_MEDIA` instead of `USAGE_VOICE_COMMUNICATION`. Full-band audio at media volume, and no microphone indicator while someone is only watching.
- **Voice leveller.** Input gain, then a slow soft-knee compressor, then a lookahead limiter at −1 dBFS. Quiet speakers are lifted, loud ones are held, and nothing clips. It replaces boosting the track with `_setVolume`, which is a saturating multiply inside libwebrtc.
- **Riding out poor networks.** Optionally play the stream behind live, so a lost packet has time to be re-sent before it's due. Wait a whole round trip for resends, and use a larger socket receive buffer.
- **Audio focus** on Android: other apps' music pauses, and a phone call mutes the stream.

It is a [Nitro module](https://nitro.margelo.com) with an Expo config plugin. It installs itself at app launch, and JS gets a small runtime handle.

## Install

```sh
npx expo install react-native-webrtc-playback react-native-nitro-modules react-native-webrtc
```

```json
{
  "expo": {
    "plugins": [["react-native-webrtc-playback", { "playoutDelayMs": 1200 }]]
  }
}
```

Then build a development build (`npx expo run:ios` / `run:android`). Expo Go does not carry the native code.

**Bare React Native:** autolinking picks the package up. Set the options by hand: an Info.plist dictionary `WebRtcPlayback`, and `<meta-data android:name="com.fluxlabs.webrtcplayback.<option>" android:value="…"/>` under `<application>`.

## Options

| Option | Default | Platforms | What it does |
| --- | --- | --- | --- |
| `enabled` | `true` | both | `false` leaves react-native-webrtc on libwebrtc's own audio device |
| `leveller` | `true` | both | Voice leveller behind a −1 dBFS limiter |
| `levellerInputGainDb` | `15` | both | How far a quiet speaker is lifted (0–30) |
| `networkResilience` | `true` | both | Wait a whole round trip for a resend (`WebRTC-RttMult/Disabled/`; the default gives up after 200 ms). Socket receive buffer 256 KB → 1 MB (`WebRTC-ReceiveBufferSize`) |
| `playoutDelayMs` | `0` | iOS at the top level | Play this far behind live (0–10000). See [Playout delay](#playout-delay) |
| `maxPlayoutDelayMs` | `max(2500, playoutDelayMs)` | same as above | How far the delay may drift under heavy jitter |
| `ios.manageAudioSession` | `true` | iOS | Own the audio session while playing (`.playback` / `.moviePlayback`, not mixable). Set `false` if the app manages the session itself, e.g. because it also records |
| `android.audioFocus` | `true` | Android | Take audio focus while playing; mute for calls |

Top-level options apply to both platforms, and the same key under `ios` / `android` wins. The exception is the playout delay: at the top level it applies to iOS only.

Also spread `RECOMMENDED_RTC_CONFIGURATION` into your `RTCPeerConnection`. It raises Android's audio jitter buffer from 50 packets (one second) to libwebrtc's own default of 200. Without it, the burst after a network stall overflows the buffer and it is flushed, which is heard as a skip.

```ts
import { RECOMMENDED_RTC_CONFIGURATION } from 'react-native-webrtc-playback'

const pc = new RTCPeerConnection({ iceServers, ...RECOMMENDED_RTC_CONFIGURATION })
```

## Playout delay

WebRTC renders each frame the moment it can, so any hiccup on the network is a freeze or a skip. `playoutDelayMs` holds the stream that far behind live (`WebRTC-ForcePlayoutDelay`). That gives a lost packet time to be sent again, instead of the picture freezing until the next keyframe. `1200` / `2500` match what an HTTP-FLV player typically targets, and are still well under HLS latency.

libwebrtc can only delay the **video**. Lip sync then drags audio along at 80 ms a second, so on its own the voice would run ahead of the picture for the first ~15 s of every session.

- **iOS:** the package holds audio back by the same amount in its own delay line, and reports it as output latency, the number lip sync reads. Picture and voice start together.
- **Android:** there is no hook for delaying audio, so the delay is off unless you set `android.playoutDelayMs` explicitly and accept that drift.

## JS API

```ts
import { getWebRtcPlayback, isWebRtcPlaybackInstalled } from 'react-native-webrtc-playback'

const media = getWebRtcPlayback() // null in Expo Go / web / binaries without the package

media?.isInstalled          // the playout path is in place
media?.isPlaying            // WebRTC audio is playing through it now
media?.config               // what it installed with (read-only)
media && (media.levellerEnabled = false) // A/B the leveller while playing
media?.takeLevels()         // iOS: { inputPeakDb, outputPeakDb, maxReductionDb } since last call

if (!isWebRtcPlaybackInstalled()) {
  // no package in this binary: a small _setVolume boost is the fallback
}
```

Options are fixed at launch. react-native-webrtc builds its audio device and field trials once, before any JS runs, so they come from the config plugin rather than from JS.

## The leveller

Speech measured at three source levels, with room noise 40 dB under the voice:

| source | loudness in | loudness out | voice over noise in | out |
| --- | --- | --- | --- | --- |
| quiet | −28.4 LUFS | −19.1 LUFS | 40.2 dB | 39.8 dB |
| typical | −20.4 LUFS | −16.9 LUFS | 40.3 dB | 39.7 dB |
| hot | −14.4 LUFS | −15.3 LUFS | 40.3 dB | 39.5 dB |

- **Peaks:** sample peaks never exceed −1.0 dBFS (true peak −0.9 dBTP), including a full-scale burst after silence.
- **Distortion:** THD on a steady tone is under 0.05% down to 100 Hz.
- **Cost:** about 0.07% of one core.
- **Why it's slow (30 ms / 2 s):** it follows the speaker's level rather than each syllable. A fast compressor on a hot source squashes loud syllables against soft ones and lets every pause swell with room noise. iOS also holds the gain through pauses.
- **Where it runs:** on iOS, in C on the render thread (`ios/WRPPlayoutProcessor.c`). On Android, the platform's `DynamicsProcessing` is attached to WebRTC's AudioTrack, with the same numbers (`WebRtcPlaybackInstaller.kt`). Change them together.

## Limits

- **Play-only.** The iOS device refuses to record. An app that also *sends* audio over react-native-webrtc must not install this package (`"enabled": false`).
- **One per app.** It replaces react-native-webrtc's audio device module for the whole process, and steps aside if another is already set.
- **react-native-webrtc 124.x.** It relies on that version's `WebRTCModuleOptions` (iOS `audioDevice`, Android `audioDeviceModule`) and field trials.
- **Android reads WebRTC's AudioTrack by reflection.** It needs the session id to attach the leveller. The fields survive R8 through react-native-webrtc's own `-keep class org.webrtc.** { *; }`.
- **Android has no level metering.** `takeLevels()` returns `undefined`.
- **Android DynamicsProcessing differs by device.** Some builds reject the time-resolution variant (a Nothing Phone 2 on Android 14 does), others reject zero-band stages. The package tries the layouts in turn and logs the one that attached, e.g. `leveller on session 889: DynamicsProcessing (frequency resolution, 0-band unused stages)`. If none is accepted, it falls back to `LoudnessEnhancer`.
- **Android: the package declares `ACCESS_NETWORK_STATE`.** libwebrtc's network monitor aborts the process without it the moment a peer connection starts, and react-native-webrtc declares no permissions of its own. It's a normal permission, granted without a prompt.

## Checking it on a device

iOS: Console.app, subsystem `com.fluxlabs.webrtc-playback`:

```
started: Speaker 48000 Hz, io 21.3 ms, latency 8.0 ms, delay 1200 ms, category AVAudioSessionCategoryPlayback/AVAudioSessionModeMoviePlayback
```

No orange microphone dot should show while watching.

Android:

```sh
adb logcat -s WebRtcPlayback
# leveller on session 1234: DynamicsProcessing (time resolution, 0-band unused stages)
```

## Example

[`example/`](example) is an Expo SDK 57 app. It plays an Ant Media Server stream over WebRTC with its own small signalling client, and shows:
- the package's installed config;
- a leveller A/B switch;
- live levels (iOS);
- receive stats: resolution, bitrate, jitter-buffer delay, freezes, loss, round trip.

```sh
cd example
npm install
npx expo run:ios      # or run:android
```

## License

MIT
