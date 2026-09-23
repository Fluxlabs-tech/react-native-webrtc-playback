import { AntMediaClient } from './antMediaClient';
import type { MediaClient, MediaClientCallbacks, MediaSource } from './types';
import { WhepClient } from './whepClient';

export type { MediaClient, MediaClientCallbacks, MediaSource } from './types';

/** A play-only WebRTC session for any supported source. */
export function createMediaClient(source: MediaSource, callbacks: MediaClientCallbacks): MediaClient {
  switch (source.kind) {
    case 'whep':
      return new WhepClient(source, callbacks);
    case 'ant-media':
      return new AntMediaClient(source, callbacks);
  }
}
