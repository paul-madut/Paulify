import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { handler } from '../api/handlers/list-tracks';

process.env.TABLE_NAME = 'paulify-test';

const ddbMock = mockClient(DynamoDBDocumentClient);

function trackItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    pk: 'TRACK#abc123',
    sk: 'META',
    id: 'abc123',
    title: 'Karma Police',
    artist: 'Radiohead',
    album: 'OK Computer',
    durationMs: 261000,
    bitrate: 128,
    sizeBytes: 4176000,
    s3Key: 'audio/abc123/abc123.mp3',
    addedAt: '2026-11-12T00:00:00.000Z',
    gsi1pk: 'ARTIST#radiohead',
    gsi1sk: '2026-11-12T00:00:00.000Z#abc123',
    gsi2pk: 'LIBRARY',
    gsi2sk: 'karma police#2026-11-12T00:00:00.000Z#abc123',
    ...overrides,
  };
}

describe('GET /tracks', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('lists the library from GSI2 when no query is given', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [trackItem()] });

    const response = await handler({ queryStringParameters: null });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.count).toBe(1);
    expect(body.tracks[0]).toEqual({
      id: 'abc123',
      title: 'Karma Police',
      artist: 'Radiohead',
      album: 'OK Computer',
      durationMs: 261000,
      bitrate: 128,
    });

    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.IndexName).toBe('GSI2');
    expect(input.KeyConditionExpression).toBe('#pk = :pk');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'LIBRARY' });
    // Unused attribute names make DynamoDB reject the request outright.
    expect(input.ExpressionAttributeNames).toEqual({ '#pk': 'gsi2pk' });
  });

  it('turns a query into a lowercased title prefix match', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const response = await handler({ queryStringParameters: { q: '  Karma ' } });

    expect(response.statusCode).toBe(200);
    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.KeyConditionExpression).toBe('#pk = :pk AND begins_with(#sk, :sk)');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'LIBRARY', ':sk': 'karma' });
  });

  it('rejects an over-long query before touching DynamoDB', async () => {
    const response = await handler({ queryStringParameters: { q: 'x'.repeat(65) } });

    expect(response.statusCode).toBe(400);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});
