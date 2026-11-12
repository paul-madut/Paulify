/**
 * GET /tracks/{id}/play
 *
 * Returns a short-lived signed CloudFront URL for one track.
 * The object is verified to exist first, so a well-formed URL is never handed
 * out for audio that is not there.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { ddb, env, s3 } from '../lib/aws';
import { badRequest, json, notFound } from '../lib/http';
import { signPlaybackUrl } from '../lib/signing';
import { trackKey, type TrackItem } from '../lib/tracks';

const TTL_SECONDS = 600;
const TRACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface PlayTrackEvent {
  pathParameters?: { id?: string } | null;
}

export const handler = async (event: PlayTrackEvent) => {
  const id = event.pathParameters?.id;

  if (!id || !TRACK_ID_PATTERN.test(id)) {
    return badRequest('id must be 1-64 characters of letters, digits, underscore or hyphen');
  }

  const result = await ddb.send(
    new GetCommand({
      TableName: env.tableName,
      Key: { pk: trackKey(id), sk: 'META' },
    }),
  );

  if (!result.Item) {
    return notFound('track not found');
  }

  const item = result.Item as TrackItem;

  try {
    await s3.send(new HeadObjectCommand({ Bucket: env.bucketName, Key: item.s3Key }));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;
    if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') {
      return notFound('audio object missing');
    }
    throw error;
  }

  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);
  const url = await signPlaybackUrl({ key: item.s3Key, expiresAt });

  return json(200, {
    id: item.id,
    url,
    expiresAt: expiresAt.toISOString(),
    durationMs: item.durationMs,
    bitrate: item.bitrate,
  });
};
