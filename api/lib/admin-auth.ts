/**
 * Admin authentication.
 *
 * The write endpoints are the only part of this API that changes data, and the
 * panel that drives them runs in a browser, so a shared secret header is the
 * right weight. The secret lives in Secrets Manager, is fetched once per cold
 * start, and is compared in constant time.
 */

import { timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { env, secrets } from './aws';
import { json, type ApiResponse } from './http';

let cachedKey: string | undefined;

export function resetAdminKeyCache(): void {
  cachedKey = undefined;
}

async function adminKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  if (!env.adminKeySecretArn) throw new Error('ADMIN_KEY_SECRET_ARN is not set');
  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: env.adminKeySecretArn }),
  );
  if (!result.SecretString) throw new Error('admin secret has no string value');
  cachedKey = result.SecretString;
  return cachedKey;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Returns null when the caller is allowed, or a 401 response when not. */
export async function rejectUnauthorized(headers: Record<string, string | undefined>): Promise<ApiResponse | null> {
  const provided = headers['x-admin-key'];
  if (!provided) return json(401, { error: 'unauthorized', message: 'x-admin-key header required' });

  const expected = await adminKey();
  if (!constantTimeEquals(provided, expected)) {
    return json(401, { error: 'unauthorized', message: 'invalid admin key' });
  }
  return null;
}
