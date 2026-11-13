/**
 * Catalogue shapes shared by the handlers.
 *
 * Table layout:
 *   TRACK#<id> / META   one row per track
 *   ALBUM#<id> / META   one row per release
 *
 * A "compilation" is a release whose tracks have different artists, so the
 * album carries its own artist field (the album artist) and each track keeps
 * its own. A single-artist album sets the same artist on both.
 */

export interface TrackItem {
  pk: string;
  sk: string;
  id: string;
  title: string;
  artist: string;
  album?: string;
  albumId?: string;
  trackNumber?: number;
  durationMs: number;
  bitrate: number;
  sizeBytes: number;
  s3Key: string;
  coverKey?: string;
  addedAt: string;
  gsi1pk: string;
  gsi1sk: string;
  gsi2pk: string;
  gsi2sk: string;
}

export interface AlbumItem {
  pk: string;
  sk: string;
  id: string;
  title: string;
  artist: string;
  year?: number;
  compilation: boolean;
  coverKey?: string;
  trackCount: number;
  addedAt: string;
  gsi3pk: string;
  gsi3sk: string;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  albumId?: string;
  trackNumber?: number;
  durationMs: number;
  bitrate: number;
  coverUrl?: string;
}

export interface Album {
  id: string;
  title: string;
  artist: string;
  year?: number;
  compilation: boolean;
  coverUrl?: string;
  trackCount: number;
}

/** Constant partition used by GSI2 so the whole library is one ordered partition. */
export const LIBRARY_PK = 'LIBRARY';

/** Constant partition used by GSI3 so every release lists in one place. */
export const CATALOG_PK = 'CATALOG';

export const trackKey = (id: string): string => `TRACK#${id}`;

export const albumKey = (id: string): string => `ALBUM#${id}`;

export const artistKey = (artist: string): string => `ARTIST#${artist.trim().toLowerCase()}`;

/** GSI2 sort key: title first so `begins_with` is a title prefix search. */
export const titleSortKey = (title: string, addedAt: string, id: string): string =>
  `${title.trim().toLowerCase()}#${addedAt}#${id}`;

/** GSI3 sort key: newest releases first. */
export const albumSortKey = (addedAt: string, id: string): string => `${addedAt}#${id}`;

/** Cover art is served unsigned, so the URL is built directly from the key. */
export function coverUrl(coverKey: string | undefined, distributionDomain: string): string | undefined {
  if (!coverKey || !distributionDomain) return undefined;
  const path = coverKey.split('/').map(encodeURIComponent).join('/');
  return `https://${distributionDomain}/${path}`;
}

export function toTrack(item: TrackItem, distributionDomain: string): Track {
  return {
    id: item.id,
    title: item.title,
    artist: item.artist,
    album: item.album,
    albumId: item.albumId,
    trackNumber: item.trackNumber,
    durationMs: item.durationMs,
    bitrate: item.bitrate,
    coverUrl: coverUrl(item.coverKey, distributionDomain),
  };
}

export function toAlbum(item: AlbumItem, distributionDomain: string): Album {
  return {
    id: item.id,
    title: item.title,
    artist: item.artist,
    year: item.year,
    compilation: item.compilation === true,
    coverUrl: coverUrl(item.coverKey, distributionDomain),
    trackCount: item.trackCount,
  };
}
