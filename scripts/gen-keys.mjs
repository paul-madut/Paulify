/**
 * Generates the CloudFront URL-signing key pair into infra/keys/.
 * The public half is read by the CDK stack; the private half is uploaded to
 * Secrets Manager and never committed (infra/keys/ is gitignored).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'infra', 'keys');
const privateKey = join(dir, 'cloudfront_private_key.pem');
const publicKey = join(dir, 'cloudfront_public_key.pem');

mkdirSync(dir, { recursive: true });

execFileSync('openssl', ['genrsa', '-out', privateKey, '2048'], { stdio: 'inherit' });
execFileSync('openssl', ['rsa', '-pubout', '-in', privateKey, '-out', publicKey], {
  stdio: 'inherit',
});

console.log(`wrote ${publicKey}`);
console.log(`wrote ${privateKey} (gitignored, upload to Secrets Manager)`);
