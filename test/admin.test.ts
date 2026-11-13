import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { handler } from '../api/handlers/admin';

process.env.TABLE_NAME = 'paulify-test';
process.env.BUCKET_NAME = 'paulify-audio-test';
process.env.DISTRIBUTION_DOMAIN = 'd111111abcdef8.cloudfront.net';
process.env.ADMIN_KEY_SECRET_ARN = 'arn:aws:secretsmanager:ca-central-1:111122223333:secret:paulify-admin';
// The presigner needs *some* credentials to sign with.
process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY';
process.env.AWS_REGION = 'ca-central-1';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const secretsMock = mockClient(SecretsManagerClient);

const ADMIN_KEY = 'test-admin-key-123';

function event(path: string, body: unknown, headers: Record<string, string> = {}) {
  return {
    rawPath: path,
    headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

describe('admin authentication', () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
    secretsMock.reset();
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: ADMIN_KEY });
  });

  it('rejects a request with no key', async () => {
    const response = await handler({
      rawPath: '/admin/albums',
      headers: {},
      body: JSON.stringify({}),
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a wrong key', async () => {
    const response = await handler(
      event('/admin/albums', { title: 'x', artist: 'y', tracks: [] }, { 'x-admin-key': 'nope' }),
    );

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /admin/uploads', () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
    secretsMock.reset();
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: ADMIN_KEY });
  });

  it('mints a presigned PUT under the requested prefix', async () => {
    const response = await handler(
      event('/admin/uploads', {
        kind: 'audio',
        filename: 'Karma Police.mp3',
        contentType: 'audio/mpeg',
        prefix: 'ok-computer',
      }),
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.key).toMatch(/^audio\/ok-computer\/karma-police-[0-9a-f]{6}\.mp3$/);
    expect(body.url).toContain('X-Amz-Signature');
    expect(body.expiresIn).toBe(900);
  });

  it('puts cover art in the covers prefix', async () => {
    const response = await handler(
      event('/admin/uploads', { kind: 'cover', filename: 'art.png', contentType: 'image/png' }),
    );

    const body = JSON.parse(response.body);
    expect(body.key).toMatch(/^covers\/art-[0-9a-f]{6}\.png$/);
  });

  it('refuses an audio upload without an audio content type', async () => {
    const response = await handler(
      event('/admin/uploads', { kind: 'audio', filename: 'x.mp3', contentType: 'image/png' }),
    );

    expect(response.statusCode).toBe(400);
  });

  it('refuses a path-traversal prefix', async () => {
    const response = await handler(
      event('/admin/uploads', {
        kind: 'audio',
        filename: 'x.mp3',
        contentType: 'audio/mpeg',
        prefix: '../../etc',
      }),
    );

    expect(response.statusCode).toBe(400);
  });
});

describe('POST /admin/albums', () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
    secretsMock.reset();
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: ADMIN_KEY });
  });

  const validBody = {
    title: 'OK Computer',
    artist: 'Radiohead',
    year: 1997,
    compilation: false,
    coverKey: 'covers/ok-computer.jpg',
    tracks: [
      {
        title: 'Karma Police',
        artist: 'Radiohead',
        s3Key: 'audio/ok-computer/karma-police.mp3',
        durationMs: 261000,
        bitrate: 128,
        sizeBytes: 4176000,
      },
    ],
  };

  it('rejects a track with no duration and never touches S3', async () => {
    const response = await handler(
      event('/admin/albums', {
        ...validBody,
        tracks: [{ ...validBody.tracks[0], durationMs: 0 }],
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });

  it('verifies every uploaded object before writing rows', async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 4176000 });
    ddbMock.on(BatchWriteCommand).resolves({});

    const response = await handler(event('/admin/albums', validBody));

    expect(response.statusCode).toBe(201);

    const head = s3Mock.commandCalls(HeadObjectCommand)[0].args[0].input;
    expect(head.Key).toBe('audio/ok-computer/karma-police.mp3');

    const body = JSON.parse(response.body);
    expect(body.album.title).toBe('OK Computer');
    expect(body.album.coverUrl).toBe('https://d111111abcdef8.cloudfront.net/covers/ok-computer.jpg');
    expect(body.tracks[0].title).toBe('Karma Police');
    expect(body.tracks[0].trackNumber).toBe(1);

    // Album row, track row, and album membership row.
    const requestItems = ddbMock.commandCalls(BatchWriteCommand)[0]?.args[0].input.RequestItems ?? {};
    const written = (requestItems['paulify-test'] ?? []) as unknown as Array<{
      PutRequest: { Item: { pk: string; sk: string } };
    }>;
    expect(written).toHaveLength(3);
    const items = written.map((entry) => entry.PutRequest.Item);
    expect(items.some((i) => i.pk.startsWith('ALBUM#') && i.sk === 'META')).toBe(true);
    expect(items.some((i) => i.pk.startsWith('TRACK#'))).toBe(true);
    expect(items.some((i) => i.sk.startsWith('TRACK#0001#'))).toBe(true);
  });

  it('keeps per-track artists for a compilation', async () => {
    s3Mock.on(HeadObjectCommand).resolves({});
    ddbMock.on(BatchWriteCommand).resolves({});

    const response = await handler(
      event('/admin/albums', {
        title: 'Now That Is Music',
        artist: 'Various Artists',
        compilation: true,
        tracks: [
          { title: 'One', artist: 'Artist A', s3Key: 'audio/comp/one.mp3', durationMs: 1000 },
          { title: 'Two', artist: 'Artist B', s3Key: 'audio/comp/two.mp3', durationMs: 1000 },
        ],
      }),
    );

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.album.compilation).toBe(true);
    expect(body.album.artist).toBe('Various Artists');
    expect(body.tracks.map((t: { artist: string }) => t.artist)).toEqual(['Artist A', 'Artist B']);
    expect(body.tracks.map((t: { trackNumber: number }) => t.trackNumber)).toEqual([1, 2]);
  });
});
