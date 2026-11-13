/**
 * POST /admin/uploads   mint a presigned PUT for one file
 * POST /admin/albums    create a release from already-uploaded files
 *
 * Files go straight from the browser to S3, so nothing large passes through
 * Lambda. The album write then verifies every object exists before it records
 * a track pointing at it.
 */

import { createHash, randomBytes } from 'node:crypto';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

import { rejectUnauthorized } from '../lib/admin-auth';
import { ddb, env, s3 } from '../lib/aws';
import { badRequest, json } from '../lib/http';
import {
  CATALOG_PK,
  albumKey,
  albumSortKey,
  artistKey,
  titleSortKey,
  toAlbum,
  toTrack,
  trackKey,
  type AlbumItem,
  type TrackItem,
} from '../lib/tracks';

const UPLOAD_TTL_SECONDS = 900;
const MAX_TRACKS_PER_ALBUM = 100;
const MAX_BODY_BYTES = 256 * 1024;

interface AdminEvent {
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  rawPath?: string;
}

interface UploadBody {
  kind?: string;
  filename?: string;
  contentType?: string;
  prefix?: string;
}

interface AlbumTrackInput {
  title?: string;
  artist?: string;
  s3Key?: string;
  durationMs?: number;
  bitrate?: number;
  sizeBytes?: number;
}

interface AlbumBody {
  title?: string;
  artist?: string;
  year?: number;
  compilation?: boolean;
  coverKey?: string;
  tracks?: AlbumTrackInput[];
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned.length ? cleaned : 'item';
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 6);
}

function randomSuffix(): string {
  return randomBytes(3).toString('hex');
}

function extensionFor(contentType: string): string {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/jpeg' || contentType === 'image/jpg') return 'jpg';
  return 'mp3';
}

function readBody(event: AdminEvent): Record<string, unknown> | null {
  if (!event.body) return null;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const handler = async (event: AdminEvent) => {
  const denied = await rejectUnauthorized(event.headers ?? {});
  if (denied) return denied;

  const body = readBody(event);
  if (!body) return badRequest('body must be JSON and under 256 KB');

  const path = event.rawPath ?? '';
  if (path.endsWith('/admin/uploads')) return createUpload(body as UploadBody);
  if (path.endsWith('/admin/albums')) return createAlbum(body as AlbumBody);

  return badRequest('unknown admin route');
};

async function createUpload(body: UploadBody) {
  const kind = body.kind === 'cover' ? 'cover' : 'audio';
  const contentType = (body.contentType ?? '').trim();
  const prefix = (body.prefix ?? '').trim();

  if (kind === 'audio' && !contentType.startsWith('audio/')) {
    return badRequest('audio uploads need an audio/* content type');
  }
  if (kind === 'cover' && !contentType.startsWith('image/')) {
    return badRequest('cover uploads need an image/* content type');
  }
  if (prefix && !/^[A-Za-z0-9_-]{1,40}$/.test(prefix)) {
    return badRequest('prefix must be 1-40 characters of letters, digits, underscore or hyphen');
  }

  const base = slug((body.filename ?? 'file').replace(/\.[^.]+$/, ''));
  const extension = kind === 'cover' ? extensionFor(contentType) : 'mp3';

  const key =
    kind === 'cover'
      ? `covers/${base}-${randomSuffix()}.${extension}`
      : `audio/${prefix || 'uploads'}/${base}-${randomSuffix()}.${extension}`;

  const command = new PutObjectCommand({
    Bucket: env.bucketName,
    Key: key,
    // ContentType is part of the signature, so the browser must send the same
    // header value on the PUT. Cache TTLs come from the CloudFront policy.
    ContentType: contentType,
  });

  const url = await getSignedUrl(s3, command, { expiresIn: UPLOAD_TTL_SECONDS });
  return json(200, { key, url, expiresIn: UPLOAD_TTL_SECONDS });
}

async function createAlbum(body: AlbumBody) {
  const title = (body.title ?? '').trim();
  const artist = (body.artist ?? '').trim();
  const inputs = body.tracks ?? [];

  if (!title) return badRequest('title is required');
  if (!artist) return badRequest('artist is required');
  if (!Array.isArray(inputs) || inputs.length === 0) return badRequest('at least one track is required');
  if (inputs.length > MAX_TRACKS_PER_ALBUM) {
    return badRequest(`at most ${MAX_TRACKS_PER_ALBUM} tracks per album`);
  }

  for (const track of inputs) {
    if (!track.title || !track.title.trim()) return badRequest('every track needs a title');
    if (!track.artist || !track.artist.trim()) return badRequest('every track needs an artist');
    if (!track.s3Key || !track.s3Key.startsWith('audio/')) {
      return badRequest('every track needs an s3Key under audio/');
    }
    if (typeof track.durationMs !== 'number' || track.durationMs <= 0) {
      return badRequest('every track needs a positive durationMs');
    }
  }

  // Every referenced object must actually exist before a row points at it.
  await Promise.all(
    inputs.map((track) =>
      s3.send(new HeadObjectCommand({ Bucket: env.bucketName, Key: track.s3Key as string })),
    ),
  );

  const albumId = `${slug(title)}-${shortHash(`${title}|${artist}`)}`;
  const addedAt = new Date().toISOString();
  const coverKey = body.coverKey && body.coverKey.startsWith('covers/') ? body.coverKey : undefined;
  const compilation = body.compilation === true;

  const trackItems: TrackItem[] = inputs.map((input, index) => {
    const cleanTitle = (input.title as string).trim();
    const cleanArtist = (input.artist as string).trim();
    const id = `${slug(`${cleanArtist}-${cleanTitle}`)}-${shortHash(`${albumId}|${index}|${cleanTitle}`)}`;

    return {
      pk: trackKey(id),
      sk: 'META',
      id,
      title: cleanTitle,
      artist: cleanArtist,
      album: title,
      albumId,
      trackNumber: index + 1,
      durationMs: Math.round(input.durationMs as number),
      bitrate: typeof input.bitrate === 'number' && input.bitrate > 0 ? Math.round(input.bitrate) : 128,
      sizeBytes: typeof input.sizeBytes === 'number' ? Math.round(input.sizeBytes) : 0,
      s3Key: input.s3Key as string,
      coverKey,
      addedAt,
      gsi1pk: artistKey(cleanArtist),
      gsi1sk: `${addedAt}#${id}`,
      gsi2pk: 'LIBRARY',
      gsi2sk: titleSortKey(cleanTitle, addedAt, id),
    };
  });

  const albumItem: AlbumItem = {
    pk: albumKey(albumId),
    sk: 'META',
    id: albumId,
    title,
    artist,
    year: typeof body.year === 'number' ? Math.round(body.year) : undefined,
    compilation,
    coverKey,
    trackCount: trackItems.length,
    addedAt,
    gsi3pk: CATALOG_PK,
    gsi3sk: albumSortKey(addedAt, albumId),
  };

  // Album membership rows keep the display fields so one Query returns a track list.
  const membership = trackItems.map((track) => ({
    PutRequest: {
      Item: {
        ...track,
        pk: albumKey(albumId),
        sk: `TRACK#${String(track.trackNumber).padStart(4, '0')}#${track.id}`,
      },
    },
  }));

  const writes = [
    { PutRequest: { Item: albumItem } },
    ...trackItems.map((track) => ({ PutRequest: { Item: track } })),
    ...membership,
  ];

  for (let index = 0; index < writes.length; index += 25) {
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: { [env.tableName]: writes.slice(index, index + 25) },
      }),
    );
  }

  return json(201, {
    album: toAlbum(albumItem, env.distributionDomain),
    tracks: trackItems.map((track) => toTrack(track, env.distributionDomain)),
  });
}
