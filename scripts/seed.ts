/**
 * Seeds the catalogue from a local folder of audio plus a manifest.
 *
 * Usage:
 *   TABLE_NAME=paulify-catalog BUCKET_NAME=<bucket> AWS_REGION=ca-central-1 \
 *     npm run seed
 *
 * seed/manifest.json is a JSON array:
 *   [{ "file": "karma-police.mp3", "title": "Karma Police", "artist": "Radiohead",
 *      "album": "OK Computer", "durationMs": 261000, "bitrate": 128 }]
 *
 * `file` is resolved relative to seed/. `bitrate` defaults to 128.
 * Re-running is safe: it overwrites the same keys with the same ids.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { PutCommand } from '@aws-sdk/lib-dynamodb';

import { ddb, env, s3 } from '../api/lib/aws';
import { LIBRARY_PK, artistKey, titleSortKey, trackKey } from '../api/lib/tracks';

interface ManifestEntry {
  file: string;
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  bitrate?: number;
}

const SEED_DIR = join(process.cwd(), 'seed');

function requireEnv(name: string, value: string): string {
  if (!value) throw new Error(`${name} is required (see the usage note at the top of scripts/seed.ts)`);
  return value;
}

function trackId(entry: ManifestEntry): string {
  const slug = `${entry.artist}-${entry.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.slice(0, 60);
}

async function main(): Promise<void> {
  const tableName = requireEnv('TABLE_NAME', env.tableName);
  const bucketName = requireEnv('BUCKET_NAME', env.bucketName);

  const manifest = JSON.parse(readFileSync(join(SEED_DIR, 'manifest.json'), 'utf8')) as ManifestEntry[];
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error('seed/manifest.json must be a non-empty array');
  }

  for (const entry of manifest) {
    const id = trackId(entry);
    const body = readFileSync(join(SEED_DIR, entry.file));
    const bitrate = entry.bitrate ?? 128;
    const s3Key = `audio/${id}/${id}.mp3`;
    const addedAt = new Date().toISOString();

    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
        Body: body,
        ContentType: 'audio/mpeg',
        // Audio never changes once written; a re-encode writes a new key.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: trackKey(id),
          sk: 'META',
          id,
          title: entry.title,
          artist: entry.artist,
          album: entry.album,
          durationMs: entry.durationMs,
          bitrate,
          sizeBytes: body.byteLength,
          s3Key,
          addedAt,
          gsi1pk: artistKey(entry.artist),
          gsi1sk: `${addedAt}#${id}`,
          gsi2pk: LIBRARY_PK,
          gsi2sk: titleSortKey(entry.title, addedAt, id),
        },
      }),
    );

    console.log(`seeded ${id} (${body.byteLength} bytes, ${bitrate} kbps)`);
  }

  console.log(`done: ${manifest.length} track(s)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
