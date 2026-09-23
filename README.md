# react-native-webrtc-playback

[![npm version](https://img.shields.io/npm/v/react-native-webrtc-playback.svg)](https://www.npmjs.com/package/react-native-webrtc-playback)
[![npm downloads](https://img.shields.io/npm/dm/react-native-webrtc-playback.svg)](https://www.npmjs.com/package/react-native-webrtc-playback)
[![license](https://img.shields.io/npm/l/react-native-webrtc-playback.svg)](LICENSE)

Make [react-native-webrtc](https://github.com/react-native-webrtc/react-native-webrtc) **playback** sound like media instead of a phone call, and keep playing through a poor network.

For apps that **watch** WebRTC streams (live commerce, live events, auctions, monitoring). It changes how the receiving side plays out audio and buffers the stream. It does not touch signalling, so it works with any server: WHEP, Ant Media, LiveKit, Janus, mediamtx, or your own.

- 🔊 **Media audio, not call audio.** Full-band sound at media volume through the loudspeaker. Out of the box, libwebrtc plays remote audio through the phone-call path.
- 🎚️ **Voice leveller.** Quiet speakers are lifted, loud ones are held, and nothing clips.
- 📶 **Rides out poor networks.** Optionally plays the stream a little behind live, and waits longer for lost packets to be re-sent.
- 🎧 **Behaves like a media app.** No microphone indicator while watching, and it respects phone calls and other apps' audio.
- ⚡ **Nitro module with an Expo config plugin.** Options are set at build time; it hooks into react-native-webrtc when the app starts, with no code in your app. JS gets a small runtime API.

---

- [Why](#why)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [JS API](#js-api)
- [Platform support](#platform-support)
- [How it works](#how-it-works)
- [Playout delay](#playout-delay)
- [The leveller](#the-leveller)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Example app](#example-app)
- [Development](#development)

## Why

react-native-webrtc is built for calls. Used only to *watch* a stream, its defaults work against you:

| Problem | Platform | What this package does |
| --- | --- | --- |
| iOS always plays through **VoiceProcessingIO**, the phone-call audio unit. Speech is muffled, the level follows the call volume, and the microphone stays live (orange dot) while someone is only watching. | iOS | A play-only audio device on **RemoteIO** under a `.playback` session |
| Android plays as **`USAGE_VOICE_COMMUNICATION`**, through the telephony processing chain, band-limited and on the call volume. | Android | Plays as `USAGE_MEDIA` / `CONTENT_TYPE_MUSIC` |
| The usual fix for quiet streams, `track._setVolume(10)`, is a **saturating multiply** inside libwebrtc. Every peak above −20 dBFS is clipped flat. | both | A leveller behind a limiter, so no boost is needed |
| libwebrtc sizes the AudioTrack at the platform minimum, which **underruns (crackles)** whenever the audio thread is late. | Android | 2× playout buffer |
| The audio jitter buffer holds **50 packets** (1 s), so the burst after a network stall overflows it and it is flushed: a skip. | Android | `RECOMMENDED_RTC_CONFIGURATION` raises it to 200 |
| While packets are being lost, video waits at most **`min(0.9 × RTT, 200 ms)`** for a resend. A mobile round trip outlasts that, so the picture freezes. | both | Waits a whole round trip |
| The **256 KB** socket receive buffer overflows on a sharp stream's keyframe burst, so packets are lost even on a good network. | both | 1 MB |
| Frames play the moment they arrive, so **any hiccup is a freeze**. | iOS (Android opt-in) | Optional playout delay, with audio held back to match |
| The WebRTC track **never takes audio focus**, so other apps' music keeps playing over the stream. | Android | Takes focus, and mutes for calls |

## Requirements

| | |
| --- | --- |
| react-native-webrtc | **124.x** |
| react-native-nitro-modules | 0.37+ |
| iOS | 15.1+ |
| Android | minSdk 24 (the leveller needs API 28+ and falls back below that) |
| Expo | Development build or bare workflow. **Not Expo Go.** |

Tested on Expo SDK 57 / React Native 0.86 (New Architecture), on an iPhone X (iOS 16.7) and a Nothing Phone (2) (Android 14).

## Installation

### Expo

```sh
npx expo install react-native-webrtc-playback react-native-nitro-modules react-native-webrtc
```

Add the plugin to `app.json` / `app.config.js`:

```json
{
  "expo": {
    "plugins": ["react-native-webrtc-playback"]
  }
}
```

Then rebuild the native app:

```sh
npx expo prebuild
npx expo run:ios      # or run:android
```

Options are written into the native project at prebuild, so **rebuild after changing them**.

### Bare React Native

```sh
npm install react-native-webrtc-playback react-native-nitro-modules react-native-webrtc
cd ios && pod install
```

Autolinking picks the package up. Without the config plugin, set options by hand, or leave them out for the defaults.

**iOS**: `Info.plist`:

```xml
<key>WebRtcPlayback</key>
<dict>
  <key>playoutDelayMs</key>
  <integer>1200</integer>
  <key>levellerInputGainDb</key>
  <real>15</real>
</dict>
```

**Android**: `AndroidManifest.xml`, inside `<application>`:

```xml
<meta-data android:name="com.fluxlabs.webrtcplayback.levellerInputGainDb" android:value="15" />
<meta-data android:name="com.fluxlabs.webrtcplayback.audioFocus" android:value="true" />
```

## Quick start

Once the plugin is in and the app rebuilt, every react-native-webrtc stream plays through the package. No code is needed for that.

Two things are worth doing in your playback code:

1. Spread `RECOMMENDED_RTC_CONFIGURATION` into the peer connection.
2. Drop any `_setVolume` boost when the package is installed.

Playing a WHEP stream, for example:

```tsx
import { RTCPeerConnection, RTCSessionDescription, RTCView, type MediaStream } from 'react-native-webrtc'
import { RECOMMENDED_RTC_CONFIGURATION } from 'react-native-webrtc-playback'

async function playWhep(url: string, onStream: (stream: MediaStream) => void) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    ...RECOMMENDED_RTC_CONFIGURATION,
  })
  pc.addTransceiver('audio', { direction: 'recvonly' })
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.ontrack = (event: any) => onStream(event.streams[0])

  await pc.setLocalDescription(await pc.createOffer({}))
  // Wait for ICE gathering before posting; see example/src/media/whepClient.ts.
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription!.sdp,
  })
  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: await response.text() }))
  return pc
}

// <RTCView streamURL={stream.toURL()} objectFit="contain" style={{ flex: 1 }} />
```

[`example/src/media`](example/src/media) has complete clients for **WHEP** and **Ant Media's WebSocket signalling**, with retry, ICE gathering and teardown.

## Configuration

All options are optional:

```json
["react-native-webrtc-playback", {
  "leveller": true,
  "levellerInputGainDb": 15,
  "networkResilience": true,
  "playoutDelayMs": 1200,
  "maxPlayoutDelayMs": 2500,
  "ios": { "manageAudioSession": true },
  "android": { "audioFocus": true }
}]
```

| Option | Default | Platforms | Effect |
| --- | --- | --- | --- |
| `enabled` | `true` | both | `false` installs nothing, and react-native-webrtc keeps libwebrtc's own audio device |
| `leveller` | `true` | both | The voice leveller: input gain, then compressor, then −1 dBFS limiter |
| `levellerInputGainDb` | `15` | both | How far a quiet speaker is lifted (0–30 dB) |
| `networkResilience` | `true` | both | Wait a whole round trip for resends (`WebRTC-RttMult/Disabled/`), and a 1 MB socket receive buffer (`WebRTC-ReceiveBufferSize`) |
| `playoutDelayMs` | `0` | iOS at the top level | Play this far behind live (0–10000 ms). [Playout delay](#playout-delay) explains the trade-off. |
| `maxPlayoutDelayMs` | `max(2500, playoutDelayMs)` | same as `playoutDelayMs` | How far the delay may drift under heavy jitter |
| `ios.manageAudioSession` | `true` | iOS | Set the audio session to `.playback` / `.moviePlayback` (not mixable) while playing. Set `false` if your app manages the session itself. |
| `android.audioFocus` | `true` | Android | Take audio focus while playing, and mute during calls |

**Precedence:**
- Top-level options apply to both platforms.
- The same key inside `ios` / `android` overrides it for that platform.
- **Exception: the playout delay.** At the top level it applies to iOS only. To delay Android too, set `android.playoutDelayMs` explicitly ([why](#playout-delay)).

The plugin validates its options at prebuild: wrong types, a delay outside 0–10000, or `maxPlayoutDelayMs` below `playoutDelayMs` fail with a clear message.

## JS API

```ts
import {
  getWebRtcPlayback,
  isWebRtcPlaybackInstalled,
  RECOMMENDED_RTC_CONFIGURATION,
  type PlayoutLevels,
  type WebRtcPlayback,
  type WebRtcPlaybackConfig,
} from 'react-native-webrtc-playback'
```

### `getWebRtcPlayback(): WebRtcPlayback | null`

Returns the runtime handle. It returns `null` when the binary has no native side, which happens in Expo Go, on web, or on a build made before the package was added. Importing the package never throws.

| Member | Type | |
| --- | --- | --- |
| `isInstalled` | `boolean` | The playout path is in place (see [Troubleshooting](#troubleshooting) if not) |
| `isPlaying` | `boolean` | WebRTC audio is playing through it right now |
| `config` | `WebRtcPlaybackConfig` | The settings it installed with, read-only |
| `levellerEnabled` | `boolean` (get/set) | Switch the leveller while playing, e.g. to compare by ear. No effect if `config.leveller` is `false`. |
| `takeLevels()` | `PlayoutLevels \| undefined` | Peak levels since the previous call. iOS only; Android returns `undefined`. |

```ts
type WebRtcPlaybackConfig = {
  playoutDelayMs: number
  maxPlayoutDelayMs: number
  leveller: boolean
  levellerInputGainDb: number
  manageAudioSession: boolean // always false on Android
  audioFocus: boolean // always false on iOS
  networkResilience: boolean
}

type PlayoutLevels = {
  inputPeakDb: number // loudest sample WebRTC handed over, dBFS (−120 = silence)
  outputPeakDb: number // loudest sample played, dBFS — never above −1
  maxReductionDb: number // deepest gain reduction (compressor + limiter), dB
}
```

### `isWebRtcPlaybackInstalled(): boolean`

A shortcut for `getWebRtcPlayback()?.isInstalled === true`. Use it to decide whether a legacy `_setVolume` boost is still needed:

```ts
if (!isWebRtcPlaybackInstalled()) {
  // A build without the package: keep any boost small; _setVolume clips.
  audioTrack._setVolume(2)
}
```

### `RECOMMENDED_RTC_CONFIGURATION`

`{ audioJitterBufferMaxPackets: 200 }`. Spread it into `new RTCPeerConnection(...)`. It's libwebrtc's own default, and iOS and browsers already use it. It is also the headroom a playout delay needs to hold audio back.

> Options are fixed for the life of the process. react-native-webrtc builds its audio device and field trials once, before any JS runs, so they come from the config plugin and not from JS.

## Platform support

| | iOS | Android |
| --- | --- | --- |
| Media audio path | RemoteIO, `.playback` / `.moviePlayback` | `USAGE_MEDIA` / `CONTENT_TYPE_MUSIC` |
| Leveller | In software on the render thread | `DynamicsProcessing` on WebRTC's AudioTrack (API 28+), `LoudnessEnhancer` otherwise |
| Gain held through pauses | ✅ | — |
| Level metering (`takeLevels`) | ✅ | — |
| Network resilience | ✅ | ✅ |
| Larger playout buffer | — (not needed) | ✅ 2× |
| Playout delay | ✅ lip sync right from the start | opt-in; lip sync drifts at first |
| Audio focus | the audio session handles it | ✅ |
| Microphone kept off | ✅ recording is refused | ✅ nothing captures unless the app asks |

## How it works

The package installs **before React Native starts**. react-native-webrtc reads `WebRTCModuleOptions` once, when it builds its peer connection factory, so this is the only way in.

**iOS**
- **Install:** an Objective-C `+load` hook reads the `WebRtcPlayback` Info.plist dictionary. It sets a custom `RTCAudioDevice` and field trials on `WebRTCModuleOptions`.
- **No pod dependency on react-native-webrtc.** The options class is found through the Objective-C runtime. A pod that contains Swift can't depend on react-native-webrtc's non-modular pod, so this way the package builds with static libraries or frameworks, and with no Podfile changes.
- **The device:** RemoteIO, output only, with a fixed 48 kHz stereo format. The input element is never enabled, which keeps the microphone off.
- **The leveller:** plain C (`ios/WRPPlayoutProcessor.c`) on the render thread. No allocation, no locks.
- **The playout delay:** a delay line on the render path, added to `outputLatency`.
- **Robustness:** handles interruptions, media-services resets and route changes. It restarts the unit when the app comes back to the foreground.

**Android**
- **Install:** an init `ContentProvider` runs before `Application.onCreate` and reads `com.fluxlabs.webrtcplayback.*` meta-data. It sets a `JavaAudioDeviceModule` built with media attributes, and the field trials.
- **The leveller:** a `DynamicsProcessing` effect with one full-band compressor and a limiter, on WebRTC's own AudioTrack session. The session id is found by reflection.
- **Device differences:** OEMs differ in which `DynamicsProcessing` layout they accept, so it tries several in turn and logs the one that attached.
- **Audio focus:** taken with delayed gain. A transient loss (call, assistant) mutes the stream. A permanent loss leaves it playing, because a live stream has no play button to come back with.
- **Permission:** it declares `ACCESS_NETWORK_STATE`, because libwebrtc's network monitor aborts the process without it.

## Playout delay

WebRTC renders each frame as soon as it can. On a mobile network that means every hiccup is visible:
- a late packet is a stutter;
- a lost one is a freeze until the next keyframe.

`playoutDelayMs` holds the stream that far behind live (`WebRTC-ForcePlayoutDelay`). That gives lost packets time to be re-sent before they're due. `1200` / `2500` is a good starting point: it matches common HTTP-FLV player targets, and is still far below HLS latency.

libwebrtc can only delay the **video**. Lip sync then drags audio along at most **80 ms per second**, so on its own the voice would run ahead of the picture for the first ~15 s of every session.

- **iOS:** the package delays audio by the same amount in its own delay line, and reports it as output latency, the number lip sync reads. Picture and voice start together.
- **Android:** there is no hook for delaying audio. The delay is off unless you set `android.playoutDelayMs` explicitly and accept the start-up drift.

**Trade-off:** everything the viewer sees and hears is that much later than live. For interactive features (bidding, chat reactions), keep server-driven timers authoritative rather than the video.

## The leveller

Input gain, then a soft-knee RMS compressor (−20 dBFS threshold, 4:1, 6 dB knee, 30 ms / 2 s), then a lookahead peak limiter at −1 dBFS.

Measured on speech at three source levels, with room noise 40 dB under the voice:

| Source | Loudness in | Loudness out | Voice over noise in | Out |
| --- | --- | --- | --- | --- |
| quiet | −28.4 LUFS | −19.1 LUFS | 40.2 dB | 39.8 dB |
| typical | −20.4 LUFS | −16.9 LUFS | 40.3 dB | 39.7 dB |
| hot | −14.4 LUFS | −15.3 LUFS | 40.3 dB | 39.5 dB |

- **Peaks:** sample peaks never exceed −1.0 dBFS (true peak −0.9 dBTP), including a full-scale burst after silence.
- **Distortion:** THD on a steady tone is under 0.05% down to 100 Hz.
- **Cost:** about 0.07% of one CPU core.
- **Why it's slow (30 ms attack / 2 s release):** it follows the speaker's *level*, not each syllable, and leaves the peaks to the limiter. A fast compressor on a loud source squashes loud syllables against soft ones and makes every pause swell with room noise. iOS also holds the gain through pauses.
- **Trade-off:** after a loud stretch, quieter speech takes 3–5 s to come back up.

The numbers live in `WRPPlayoutConfigDefault()` (iOS) and at the top of `WebRtcPlaybackInstaller.kt` (Android). Change them together.

## Limitations

- **Playback only.** The iOS device refuses to record. An app that also *sends* audio over react-native-webrtc (calls, co-hosting) must not use this package, or must set `"enabled": false`.
- **One per app.** It replaces react-native-webrtc's audio device module for the whole process, and steps aside if another one is already set.
- **react-native-webrtc 124.x.** It depends on that version's `WebRTCModuleOptions` API and its libwebrtc field trials.
- **Android levelling is approximate.** `DynamicsProcessing` is a close match for the iOS chain, but it can't hold gain through pauses, and it has no metering.

## Troubleshooting

**`getWebRtcPlayback()` returns `null`.** The binary has no native side: you're in Expo Go, on web, or on a build from before you added the package. Make a development build.

**`isInstalled` is `false`.** Check the device log (below) for one of these:

| Log | Meaning |
| --- | --- |
| `react-native-webrtc 124+ is not in this app; nothing installed` (iOS) | react-native-webrtc is missing or too old |
| `an audio device is already set; leaving it` (iOS)<br>`an audio device module is already set; leaving it` (Android) | Another library already set one |
| `disabled in Info.plist…` / `disabled in the manifest…` | `"enabled": false` |
| `install failed; libwebrtc's own audio device stays` (Android) | Unexpected error; the stack trace follows in logcat |

**Changed an option and nothing happened.** Options are baked into the native project. Run `npx expo prebuild` and rebuild.

**Android crashes as a stream starts, with `Check failed: !env->ExceptionCheck()` right after `NetworkMonitor: Start monitoring`.** The app has lost `android.permission.ACCESS_NETWORK_STATE`, for example through `android.blockedPermissions` or `tools:node="remove"`. libwebrtc aborts without it, so keep it.

**Android logs `falling back to LoudnessEnhancer`.** The device rejected every `DynamicsProcessing` layout. Audio still plays and is lifted, but without the compressor and limiter. The log lines before it say which layouts were rejected.

**The voice runs ahead of the lips on Android.** You set `android.playoutDelayMs`. That's the expected start-up drift; see [Playout delay](#playout-delay).

**Too loud, or too processed.** Lower `levellerInputGainDb`, or set `"leveller": false`. `levellerEnabled` switches it at runtime so you can compare.

**Another part of the app needs a different audio session (iOS).** Set `ios.manageAudioSession: false` and manage the session yourself. It must allow playback.

**Checking it on a device**

iOS: Console.app, subsystem `com.fluxlabs.webrtc-playback`:

```
started: Speaker 48000 Hz, io 21.3 ms, latency 8.0 ms, delay 1200 ms, category AVAudioSessionCategoryPlayback/AVAudioSessionModeMoviePlayback
```

No orange microphone dot should appear while watching.

Android:

```sh
adb logcat -s WebRtcPlayback
# leveller on session 889: DynamicsProcessing (frequency resolution, 0-band unused stages)

adb logcat | grep WebRtcAudioTrackExternal
# initPlayout(sampleRate=48000, channels=1, bufferSizeFactor=2.0)
```

## Example app

[`example/`](example) is an Expo SDK 57 app that plays a stream and shows the package working:
- a source picker: **WHEP** or **Ant Media WebSocket**;
- the video;
- the installed config;
- a leveller A/B switch;
- live levels (iOS);
- receive stats every 2 s: resolution, bitrate, jitter-buffer delay, freezes, loss, round trip.

```sh
cd example
npm install
npx expo run:ios      # or run:android
```

To avoid typing a source on the phone, put defaults in a gitignored `example/.env.local` and restart Metro:

```sh
EXPO_PUBLIC_MEDIA_SOURCE_KIND=whep            # or ant-media
EXPO_PUBLIC_MEDIA_SOURCE_URL=http://192.168.1.10:8889/mystream/whep
EXPO_PUBLIC_MEDIA_STREAM_ID=                  # ant-media only
EXPO_PUBLIC_MEDIA_TOKEN=                      # optional
```

**A local test stream.** Any WHEP server works. With [mediamtx](https://github.com/bluenviron/mediamtx), run it on your machine with `webrtcAdditionalHosts` set to your LAN IP. Then publish a test pattern and tone over RTSP:

```sh
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 \
  -c:v libx264 -preset ultrafast -tune zerolatency -c:a libopus \
  -f rtsp rtsp://localhost:8554/mystream
```

The stream then plays at `http://<your-ip>:8889/mystream/whep`. To see the resilience settings at work, iOS has **Settings → Developer → Network Link Conditioner** (for example "Very Bad Network").

## Development

```sh
npm install
npm run specs        # after editing src/specs: tsc + nitrogen, regenerates nitrogen/generated
npm run typecheck
```

The example depends on the package through `file:..`. Metro and autolinking are set up to use the example's single copy of react, react-native, react-native-nitro-modules and react-native-webrtc.

| Path | What's there |
| --- | --- |
| `src/specs/WebRtcPlayback.nitro.ts` | The HybridObject spec (JS API) |
| `ios/WRPAudioDevice.m` | The iOS audio device, delay line and installer |
| `ios/WRPPlayoutProcessor.c` | The leveller DSP (portable C) |
| `ios/HybridWebRtcPlayback.swift` | The iOS HybridObject |
| `android/.../WebRtcPlaybackInstaller.kt` | The Android audio module, leveller and focus |
| `android/.../WebRtcPlaybackInitProvider.kt` | The Android startup install |
| `plugin/withWebRtcPlayback.js` | The Expo config plugin |

## License

MIT © fluxlabs
