/** Shape of a catalogue item as stored in DynamoDB, and as returned to the client. */

export interface TrackItem {
  pk: string;
  sk: string;
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  bitrate: number;
  sizeBytes: number;
  s3Key: string;
  addedAt: string;
  gsi1pk: string;
  gsi1sk: string;
  gsi2pk: string;
  gsi2sk: string;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  bitrate: number;
}

/** Constant partition used by GSI2 so the whole library is one ordered partition. */
export const LIBRARY_PK = 'LIBRARY';

export const trackKey = (id: string): string => `TRACK#${id}`;

export const artistKey = (artist: string): string => `ARTIST#${artist.trim().toLowerCase()}`;

/** GSI2 sort key: title first so `begins_with` is a title prefix search. */
export const titleSortKey = (title: string, addedAt: string, id: string): string =>
  `${title.trim().toLowerCase()}#${addedAt}#${id}`;

export function toTrack(item: TrackItem): Track {
  return {
    id: item.id,
    title: item.title,
    artist: item.artist,
    album: item.album,
    durationMs: item.durationMs,
    bitrate: item.bitrate,
  };
}
