/**
 * Shared AWS client construction.
 *
 * Clients are created once at module scope so a warm Lambda invocation reuses
 * the underlying HTTP connections instead of rebuilding them per request.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const region = process.env.AWS_REGION;

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const s3 = new S3Client({ region });

export const secrets = new SecretsManagerClient({ region });

export const env = {
  get tableName(): string {
    return process.env.TABLE_NAME ?? '';
  },
  get bucketName(): string {
    return process.env.BUCKET_NAME ?? '';
  },
  get distributionDomain(): string {
    return process.env.DISTRIBUTION_DOMAIN ?? '';
  },
  get keyPairId(): string {
    return process.env.KEY_PAIR_ID ?? '';
  },
  get privateKeySecretArn(): string {
    return process.env.PRIVATE_KEY_SECRET_ARN ?? '';
  },
};
