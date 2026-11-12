/**
 * CloudFront URL signing.
 *
 * The private key lives in Secrets Manager and is fetched once per cold start.
 * The device never sees a key: it only receives URLs that expire.
 */

import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import { env, secrets } from './aws';

let cachedPrivateKey: string | undefined;

export function resetSigningCache(): void {
  cachedPrivateKey = undefined;
}

export async function getPrivateKey(): Promise<string> {
  if (cachedPrivateKey) return cachedPrivateKey;
  if (!env.privateKeySecretArn) throw new Error('PRIVATE_KEY_SECRET_ARN is not set');

  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: env.privateKeySecretArn }),
  );

  if (!result.SecretString) throw new Error('signing secret has no string value');
  cachedPrivateKey = result.SecretString;
  return cachedPrivateKey;
}

export async function signPlaybackUrl(options: {
  key: string;
  expiresAt: Date;
}): Promise<string> {
  const privateKey = await getPrivateKey();
  const path = options.key.split('/').map(encodeURIComponent).join('/');
  const url = `https://${env.distributionDomain}/${path}`;

  return getSignedUrl({
    url,
    keyPairId: env.keyPairId,
    privateKey,
    dateLessThan: options.expiresAt.toISOString(),
  });
}
