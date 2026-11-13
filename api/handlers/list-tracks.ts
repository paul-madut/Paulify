/**
 * GET /tracks[?q=]
 *
 * Reads the library from GSI2, which is one ordered partition keyed on title,
 * so an empty query lists the library and a query becomes a title prefix match.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, env } from '../lib/aws';
import { badRequest, json } from '../lib/http';
import { LIBRARY_PK, toTrack, type TrackItem } from '../lib/tracks';

const MAX_QUERY_LENGTH = 64;
const PAGE_SIZE = 100;

interface ListTracksEvent {
  queryStringParameters?: Record<string, string | undefined> | null;
}

export const handler = async (event: ListTracksEvent) => {
  const raw = event.queryStringParameters?.q ?? '';
  const query = raw.trim().toLowerCase();

  if (query.length > MAX_QUERY_LENGTH) {
    return badRequest(`q must be ${MAX_QUERY_LENGTH} characters or fewer`);
  }

  const command = query
    ? new QueryCommand({
        TableName: env.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk)',
        ExpressionAttributeNames: { '#pk': 'gsi2pk', '#sk': 'gsi2sk' },
        ExpressionAttributeValues: { ':pk': LIBRARY_PK, ':sk': query },
        Limit: PAGE_SIZE,
      })
    : new QueryCommand({
        TableName: env.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'gsi2pk' },
        ExpressionAttributeValues: { ':pk': LIBRARY_PK },
        Limit: PAGE_SIZE,
      });

  const result = await ddb.send(command);
  const items = (result.Items ?? []) as TrackItem[];

  return json(200, {
    tracks: items.map((item) => toTrack(item, env.distributionDomain)),
    count: items.length,
  });
};
