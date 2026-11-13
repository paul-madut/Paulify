/**
 * GET /albums        list releases, newest first
 * GET /albums/{id}   one release with its tracks
 *
 * Album membership is denormalised: each track inside an album partition
 * carries the display fields, so one Query returns the whole track list
 * without a second round trip per track.
 */

import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, env } from '../lib/aws';
import { json, notFound } from '../lib/http';
import {
  albumKey,
  toAlbum,
  toTrack,
  type AlbumItem,
  type TrackItem,
} from '../lib/tracks';

const LIST_LIMIT = 100;
const ALBUM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface CatalogEvent {
  pathParameters?: { id?: string } | null;
}

export const handler = async (event: CatalogEvent) => {
  const albumId = event.pathParameters?.id;
  if (albumId) {
    if (!ALBUM_ID_PATTERN.test(albumId)) return notFound('album not found');
    return albumDetail(albumId);
  }
  return albumList();
};

async function albumList() {
  const result = await ddb.send(
    new QueryCommand({
      TableName: env.tableName,
      IndexName: 'GSI3',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'gsi3pk' },
      ExpressionAttributeValues: { ':pk': 'CATALOG' },
      ScanIndexForward: false,
      Limit: LIST_LIMIT,
    }),
  );

  const albums = ((result.Items ?? []) as AlbumItem[]).map((item) =>
    toAlbum(item, env.distributionDomain),
  );

  return json(200, { albums, count: albums.length });
}

async function albumDetail(albumId: string) {
  const albumResult = await ddb.send(
    new GetCommand({
      TableName: env.tableName,
      Key: { pk: albumKey(albumId), sk: 'META' },
    }),
  );

  if (!albumResult.Item) return notFound('album not found');

  const tracksResult = await ddb.send(
    new QueryCommand({
      TableName: env.tableName,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk)',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': albumKey(albumId), ':sk': 'TRACK#' },
    }),
  );

  const album = toAlbum(albumResult.Item as AlbumItem, env.distributionDomain);
  const tracks = ((tracksResult.Items ?? []) as TrackItem[]).map((item) =>
    toTrack(item, env.distributionDomain),
  );

  return json(200, { album, tracks });
}
