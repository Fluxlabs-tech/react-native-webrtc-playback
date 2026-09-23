import { StatusBar } from 'expo-status-bar';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { type MediaStream, RTCView, type RTCPeerConnection } from 'react-native-webrtc';
import { getWebRtcPlayback } from 'react-native-webrtc-playback';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { createMediaClient, type MediaClient, type MediaSource } from './src/media';
import { usePlayoutLevels } from './src/usePlayoutLevels';
import { useReceiveStats } from './src/useReceiveStats';

const media = getWebRtcPlayback();

export default function App() {
  return (
    <SafeAreaProvider>
      <Player />
    </SafeAreaProvider>
  );
}

type SourceKind = MediaSource['kind'];

const SOURCE_KINDS: { kind: SourceKind; label: string }[] = [
  { kind: 'whep', label: 'WHEP' },
  { kind: 'ant-media', label: 'Ant Media WebSocket' },
];

/**
 * Optional starting values, so a test source need not be typed on the phone:
 * `EXPO_PUBLIC_MEDIA_SOURCE_KIND` (`whep` | `ant-media`), `EXPO_PUBLIC_MEDIA_SOURCE_URL`,
 * `EXPO_PUBLIC_MEDIA_STREAM_ID`, `EXPO_PUBLIC_MEDIA_TOKEN` — e.g. in a gitignored
 * `.env.local`. Expo inlines them when it bundles; restart Metro after a change.
 */
const DEFAULTS = {
  kind: (process.env.EXPO_PUBLIC_MEDIA_SOURCE_KIND === 'ant-media' ? 'ant-media' : 'whep') as SourceKind,
  url: process.env.EXPO_PUBLIC_MEDIA_SOURCE_URL ?? '',
  streamId: process.env.EXPO_PUBLIC_MEDIA_STREAM_ID ?? '',
  token: process.env.EXPO_PUBLIC_MEDIA_TOKEN ?? '',
};

function Player() {
  const [kind, setKind] = useState<SourceKind>(DEFAULTS.kind);
  const [url, setUrl] = useState(DEFAULTS.url);
  const [streamId, setStreamId] = useState(DEFAULTS.streamId);
  const [token, setToken] = useState(DEFAULTS.token);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [state, setState] = useState('idle');
  const [playing, setPlaying] = useState(false);
  const [leveller, setLeveller] = useState(media?.levellerEnabled ?? false);
  const client = useRef<MediaClient | null>(null);

  const stats = useReceiveStats(pc);
  const levels = usePlayoutLevels(stream !== null);

  useEffect(() => () => client.current?.stop(), []);

  const play = () => {
    const source = toSource(kind, url.trim(), streamId.trim(), token.trim() || undefined);
    if (!source) {
      setState(kind === 'whep' ? 'enter a WHEP URL' : 'enter a signalling URL and a stream ID');
      return;
    }
    const next = createMediaClient(source, {
      onStream: (s) => {
        setStream(s);
        setPc(next.peerConnection);
      },
      onState: setState,
    });
    client.current = next;
    next.start();
    setPlaying(true);
  };

  const stop = () => {
    client.current?.stop();
    client.current = null;
    setStream(null);
    setPc(null);
    setPlaying(false);
  };

  const toggleLeveller = (value: boolean) => {
    if (!media) return;
    media.levellerEnabled = value;
    setLeveller(media.levellerEnabled);
  };

  const config = media?.config;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>WebRTC Playback</Text>

        <View style={styles.video}>
          {stream ? (
            <RTCView streamURL={stream.toURL()} objectFit="contain" style={StyleSheet.absoluteFill} />
          ) : (
            <Text style={styles.placeholder}>{state}</Text>
          )}
        </View>

        <Section title="Source">
          <View style={styles.row}>
            {SOURCE_KINDS.map((option) => (
              <Pressable
                key={option.kind}
                style={[styles.chip, kind === option.kind && styles.chipActive]}
                onPress={() => !playing && setKind(option.kind)}
              >
                <Text style={styles.chipText}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            style={styles.input}
            placeholder={
              kind === 'whep'
                ? 'https://host/…/whep  (WHEP endpoint)'
                : 'wss://host:5443/WebRTCAppEE/websocket'
            }
            placeholderTextColor="#6b7280"
            autoCapitalize="none"
            autoCorrect={false}
            value={url}
            onChangeText={setUrl}
            editable={!playing}
          />
          <View style={styles.row}>
            {kind === 'ant-media' && (
              <TextInput
                style={[styles.input, styles.flex]}
                placeholder="Stream ID"
                placeholderTextColor="#6b7280"
                autoCapitalize="none"
                autoCorrect={false}
                value={streamId}
                onChangeText={setStreamId}
                editable={!playing}
              />
            )}
            <TextInput
              style={[styles.input, styles.flex]}
              placeholder={kind === 'whep' ? 'Bearer token (optional)' : 'Token (optional)'}
              placeholderTextColor="#6b7280"
              autoCapitalize="none"
              autoCorrect={false}
              value={token}
              onChangeText={setToken}
              editable={!playing}
            />
          </View>
          <Pressable style={[styles.button, playing && styles.buttonStop]} onPress={playing ? stop : play}>
            <Text style={styles.buttonText}>{playing ? 'Stop' : 'Play'}</Text>
          </Pressable>
          <Text style={styles.muted}>State: {state}</Text>
        </Section>

        <Section title="Native playout">
          <Line label="Installed" value={media?.isInstalled ? 'yes' : 'no'} />
          {config && (
            <>
              <Line
                label="Playout delay"
                value={
                  config.playoutDelayMs > 0
                    ? `${config.playoutDelayMs} ms (max ${config.maxPlayoutDelayMs})`
                    : 'off'
                }
              />
              <Line label="Network resilience" value={config.networkResilience ? 'on' : 'off'} />
              <Line
                label="Leveller"
                value={
                  config.leveller
                    ? `+${config.levellerInputGainDb} dB in, -1 dBFS ceiling`
                    : 'not installed'
                }
              />
            </>
          )}
          <View style={[styles.row, styles.between]}>
            <Text style={styles.label}>Leveller on (A/B)</Text>
            <Switch value={leveller} onValueChange={toggleLeveller} disabled={!config?.leveller} />
          </View>
          <Line label="In peak" value={levels ? `${levels.inputPeakDb.toFixed(1)} dBFS` : '—'} />
          <Line label="Out peak" value={levels ? `${levels.outputPeakDb.toFixed(1)} dBFS` : '—'} />
          <Line label="Gain reduction" value={levels ? `${levels.maxReductionDb.toFixed(1)} dB` : '—'} />
        </Section>

        <Section title="Receive stats (every 2 s)">
          <Line
            label="Video"
            value={stats ? `${stats.resolution} @ ${stats.fps} fps, ${stats.videoKbps} kbps` : '—'}
          />
          <Line label="Audio" value={stats ? `${stats.audioKbps} kbps` : '—'} />
          <Line
            label="Jitter buffer"
            value={stats ? `video ${stats.videoBufferMs} ms, audio ${stats.audioBufferMs} ms` : '—'}
          />
          <Line
            label="Freezes"
            value={stats ? `${stats.freezes} (${stats.freezeSeconds.toFixed(1)} s total)` : '—'}
          />
          <Line
            label="Loss"
            value={
              stats
                ? `video ${stats.videoLossPercent.toFixed(1)}%, audio concealed ${stats.audioConcealedPercent.toFixed(1)}%`
                : '—'
            }
          />
          <Line label="Round trip" value={stats && stats.rttMs >= 0 ? `${stats.rttMs} ms` : '—'} />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function toSource(
  kind: SourceKind,
  url: string,
  streamId: string,
  token: string | undefined
): MediaSource | null {
  if (!url) return null;
  if (kind === 'whep') return { kind, url, token };
  return streamId ? { kind, signalingUrl: url, streamId, token } : null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={[styles.row, styles.between]}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0b0f17' },
  content: { padding: 16, gap: 16 },
  title: { color: '#f9fafb', fontSize: 22, fontWeight: '700' },
  video: {
    aspectRatio: 16 / 9,
    backgroundColor: '#000',
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholder: { color: '#9ca3af', paddingHorizontal: 16, textAlign: 'center' },
  section: { backgroundColor: '#111827', borderRadius: 12, padding: 12, gap: 8 },
  sectionTitle: { color: '#f9fafb', fontSize: 15, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  between: { justifyContent: 'space-between' },
  flex: { flex: 1 },
  input: {
    backgroundColor: '#1f2937',
    color: '#f9fafb',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  button: { backgroundColor: '#2563eb', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  buttonStop: { backgroundColor: '#dc2626' },
  chip: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#1f2937' },
  chipActive: { backgroundColor: '#2563eb' },
  chipText: { color: '#f9fafb', fontSize: 13 },
  buttonText: { color: '#fff', fontWeight: '600' },
  label: { color: '#9ca3af', fontSize: 13 },
  value: {
    color: '#f9fafb',
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
    textAlign: 'right',
  },
  muted: { color: '#6b7280', fontSize: 12 },
});
