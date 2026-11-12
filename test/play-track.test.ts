import { generateKeyPairSync } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { handler } from '../api/handlers/play-track';

process.env.TABLE_NAME = 'paulify-test';
process.env.BUCKET_NAME = 'paulify-audio-test';
process.env.DISTRIBUTION_DOMAIN = 'd111111abcdef8.cloudfront.net';
process.env.KEY_PAIR_ID = 'K2JCJMDEHXQW5F';
process.env.PRIVATE_KEY_SECRET_ARN = 'arn:aws:secretsmanager:ca-central-1:111122223333:secret:paulify';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const secretsMock = mockClient(SecretsManagerClient);

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const trackItem = {
  pk: 'TRACK#abc123',
  sk: 'META',
  id: 'abc123',
  title: 'Karma Police',
  artist: 'Radiohead',
  durationMs: 261000,
  bitrate: 128,
  sizeBytes: 4176000,
  s3Key: 'audio/abc123/abc123.mp3',
  addedAt: '2026-11-12T00:00:00.000Z',
  gsi1pk: 'ARTIST#radiohead',
  gsi1sk: '2026-11-12T00:00:00.000Z#abc123',
  gsi2pk: 'LIBRARY',
  gsi2sk: 'karma police#2026-11-12T00:00:00.000Z#abc123',
};

describe('GET /tracks/{id}/play', () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
    secretsMock.reset();
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: privateKey });
  });

  it('rejects an id that cannot be a track key', async () => {
    const response = await handler({ pathParameters: { id: '../../etc/passwd' } });

    expect(response.statusCode).toBe(400);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('returns 404 when the track is not in the catalogue', async () => {
    ddbMock.on(GetCommand).resolves({});

    const response = await handler({ pathParameters: { id: 'missing' } });

    expect(response.statusCode).toBe(404);
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });

  it('returns 404 when the catalogue row exists but the audio does not', async () => {
    ddbMock.on(GetCommand).resolves({ Item: trackItem });
    s3Mock.on(HeadObjectCommand).rejects(
      Object.assign(new Error('NotFound'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      }),
    );

    const response = await handler({ pathParameters: { id: 'abc123' } });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.message).toBe('audio object missing');
  });

  it('signs a short-lived CloudFront URL scoped to the one object', async () => {
    ddbMock.on(GetCommand).resolves({ Item: trackItem });
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 4176000 });

    const before = Date.now();
    const response = await handler({ pathParameters: { id: 'abc123' } });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.url.startsWith('https://d111111abcdef8.cloudfront.net/audio/abc123/abc123.mp3')).toBe(true);
    expect(body.url).toContain('Key-Pair-Id=K2JCJMDEHXQW5F');
    expect(body.url).toContain('Signature=');
    // Canned policy: the expiry travels as Expires, and the URL covers this one object path.
    expect(body.url).toContain('Expires=');
    expect(body.bitrate).toBe(128);

    const expiresAt = new Date(body.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 590_000);
    expect(expiresAt).toBeLessThanOrEqual(before + 610_000);

    // The existence check must target the audio prefix, never the whole bucket.
    const headInput = s3Mock.commandCalls(HeadObjectCommand)[0].args[0].input;
    expect(headInput.Key).toBe('audio/abc123/abc123.mp3');
    expect(headInput.Bucket).toBe('paulify-audio-test');
  });
});
