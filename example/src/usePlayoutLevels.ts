import { useEffect, useState } from 'react';
import { getWebRtcPlayback, type PlayoutLevels } from 'react-native-webrtc-playback';

const INTERVAL_MS = 250;

/**
 * The leveller's peaks, refreshed a few times a second while `active`.
 * Stays `undefined` on Android, whose effect has no metering.
 */
export function usePlayoutLevels(active: boolean): PlayoutLevels | undefined {
  const [levels, setLevels] = useState<PlayoutLevels | undefined>();

  useEffect(() => {
    setLevels(undefined);
    const media = getWebRtcPlayback();
    if (!active || !media) return;
    const timer = setInterval(() => {
      const next = media.takeLevels();
      if (next) setLevels(next);
    }, INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active]);

  return levels;
}
