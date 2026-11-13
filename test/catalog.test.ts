import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { handler } from '../api/handlers/catalog';

process.env.TABLE_NAME = 'paulify-test';
process.env.DISTRIBUTION_DOMAIN = 'd111111abcdef8.cloudfront.net';

const ddbMock = mockClient(DynamoDBDocumentClient);

const albumItem = {
  pk: 'ALBUM#ok-computer-abc123',
  sk: 'META',
  id: 'ok-computer-abc123',
  title: 'OK Computer',
  artist: 'Radiohead',
  year: 1997,
  compilation: false,
  coverKey: 'covers/ok-computer.jpg',
  trackCount: 1,
  addedAt: '2026-11-13T00:00:00.000Z',
  gsi3pk: 'CATALOG',
  gsi3sk: '2026-11-13T00:00:00.000Z#ok-computer-abc123',
};

const trackItem = {
  pk: 'ALBUM#ok-computer-abc123',
  sk: 'TRACK#0001#karma-police-def456',
  id: 'karma-police-def456',
  title: 'Karma Police',
  artist: 'Radiohead',
  album: 'OK Computer',
  albumId: 'ok-computer-abc123',
  trackNumber: 1,
  durationMs: 261000,
  bitrate: 128,
  sizeBytes: 4176000,
  s3Key: 'audio/ok-computer/karma-police.mp3',
  coverKey: 'covers/ok-computer.jpg',
  addedAt: '2026-11-13T00:00:00.000Z',
  gsi1pk: 'ARTIST#radiohead',
  gsi1sk: '2026-11-13T00:00:00.000Z#karma-police-def456',
  gsi2pk: 'LIBRARY',
  gsi2sk: 'karma police#2026-11-13T00:00:00.000Z#karma-police-def456',
};

describe('GET /albums', () => {
  beforeEach(() => ddbMock.reset());

  it('lists releases newest first with an unsigned cover URL', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [albumItem] });

    const response = await handler({});

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.count).toBe(1);
    expect(body.albums[0].title).toBe('OK Computer');
    expect(body.albums[0].coverUrl).toBe(
      'https://d111111abcdef8.cloudfront.net/covers/ok-computer.jpg',
    );

    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.IndexName).toBe('GSI3');
    expect(input.ScanIndexForward).toBe(false);
  });
});

describe('GET /albums/{id}', () => {
  beforeEach(() => ddbMock.reset());

  it('returns 404 when the release does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});

    const response = await handler({ pathParameters: { id: 'nope' } });

    expect(response.statusCode).toBe(404);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('returns the release with its tracks', async () => {
    ddbMock.on(GetCommand).resolves({ Item: albumItem });
    ddbMock.on(QueryCommand).resolves({ Items: [trackItem] });

    const response = await handler({ pathParameters: { id: 'ok-computer-abc123' } });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.album.title).toBe('OK Computer');
    expect(body.tracks).toHaveLength(1);
    expect(body.tracks[0].title).toBe('Karma Police');
    expect(body.tracks[0].coverUrl).toBe(
      'https://d111111abcdef8.cloudfront.net/covers/ok-computer.jpg',
    );

    const query = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(query.ExpressionAttributeValues).toEqual({
      ':pk': 'ALBUM#ok-computer-abc123',
      ':sk': 'TRACK#',
    });
  });
});
