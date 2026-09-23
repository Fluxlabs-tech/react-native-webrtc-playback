//
// Expo config plugin for react-native-webrtc-playback.
//
// The native side installs itself before React Native starts — react-native-webrtc
// reads its audio device and field trials once, when it builds its peer
// connection factory, and no JS runs early enough to set them. So its options
// travel through the native project instead: this plugin writes them to
// Info.plist (iOS, key `WebRtcPlayback`) and to `<meta-data>` in the
// AndroidManifest (Android, names prefixed `com.fluxlabs.webrtcplayback.`),
// and the native side reads them at launch.
//
// Usage in app.json / app.config.js — every option is optional:
//
//   "plugins": [
//     ["react-native-webrtc-playback", {
//       "leveller": true,               // voice leveller behind a -1 dBFS limiter
//       "levellerInputGainDb": 15,      // how far a quiet speaker is lifted
//       "networkResilience": true,      // full-RTT resend wait, 1 MB receive buffer
//       "playoutDelayMs": 1200,         // iOS: play this far behind live
//       "maxPlayoutDelayMs": 2500,      // iOS: how far it may drift under jitter
//       "ios": { "manageAudioSession": true },
//       "android": { "audioFocus": true }
//     }]
//   ]
//
// Top-level keys apply to both platforms, and a key in `ios` / `android` wins
// over the same key at the top level — except the playout delay, which at the
// top level applies to iOS only. Android has no hook for holding audio back to
// match a delayed picture, so there the voice runs ahead of the picture for
// the first seconds of every session; set `android.playoutDelayMs` explicitly
// to accept that.
//
// `"enabled": false` (top level or per platform) leaves react-native-webrtc on
// libwebrtc's own audio device.

const { AndroidConfig, withAndroidManifest, withInfoPlist } = require('@expo/config-plugins');

const PACKAGE = 'react-native-webrtc-playback';
const INFO_PLIST_KEY = 'WebRtcPlayback';
const META_PREFIX = 'com.fluxlabs.webrtcplayback.';

const COMMON = {
  enabled: 'boolean',
  leveller: 'boolean',
  levellerInputGainDb: 'number',
  networkResilience: 'boolean',
};
const DELAY = {
  playoutDelayMs: 'number',
  maxPlayoutDelayMs: 'number',
};
const IOS_ONLY = { manageAudioSession: 'boolean' };
const ANDROID_ONLY = { audioFocus: 'boolean' };

function pick(source, schema, where) {
  const out = {};
  if (source == null) return out;
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`[${PACKAGE}] ${where} must be an object.`);
  }
  for (const [key, type] of Object.entries(schema)) {
    if (source[key] === undefined) continue;
    if (typeof source[key] !== type || (type === 'number' && !Number.isFinite(source[key]))) {
      throw new Error(`[${PACKAGE}] ${where}.${key} must be a ${type}.`);
    }
    out[key] = source[key];
  }
  return out;
}

function checkDelay(options, platform) {
  const { playoutDelayMs, maxPlayoutDelayMs } = options;
  if (playoutDelayMs !== undefined && (playoutDelayMs < 0 || playoutDelayMs > 10000)) {
    throw new Error(`[${PACKAGE}] ${platform}: playoutDelayMs must be between 0 and 10000.`);
  }
  if (maxPlayoutDelayMs !== undefined && maxPlayoutDelayMs < (playoutDelayMs ?? 0)) {
    throw new Error(`[${PACKAGE}] ${platform}: maxPlayoutDelayMs must not be below playoutDelayMs.`);
  }
  return options;
}

function resolve(props = {}) {
  const common = pick(props, COMMON, 'options');
  const topDelay = pick(props, DELAY, 'options');
  const ios = checkDelay(
    { ...common, ...topDelay, ...pick(props.ios, { ...COMMON, ...DELAY, ...IOS_ONLY }, 'ios') },
    'ios'
  );
  const android = checkDelay(
    { ...common, ...pick(props.android, { ...COMMON, ...DELAY, ...ANDROID_ONLY }, 'android') },
    'android'
  );
  return { ios, android };
}

const withWebRtcPlayback = (config, props) => {
  const { ios, android } = resolve(props);

  config = withInfoPlist(config, (cfg) => {
    cfg.modResults[INFO_PLIST_KEY] = ios;
    return cfg;
  });

  config = withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    // Replace, not merge: an option removed from app.json must leave the
    // manifest too.
    for (const key of Object.keys({ ...COMMON, ...DELAY, ...ANDROID_ONLY })) {
      AndroidConfig.Manifest.removeMetaDataItemFromMainApplication(app, META_PREFIX + key);
    }
    for (const [key, value] of Object.entries(android)) {
      AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, META_PREFIX + key, String(value));
    }
    return cfg;
  });

  return config;
};

module.exports = withWebRtcPlayback;
module.exports.resolveOptions = resolve;
