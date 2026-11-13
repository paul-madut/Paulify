# Paulify

A small music streaming service for a 2014 BlackBerry Classic.

## Why this exists

Streaming music to a BlackBerry Classic in 2026 is a constraint problem, not a features problem.
The device runs BB10 10.3.3 with a 2014 WebKit browser, 2 GB of RAM, a 720x720 screen, and no Media Source Extensions.
That rules out HLS.js, DASH.js, and every modern streaming stack that assumes MSE.
Whatever plays on it has to be progressive audio fetched over plain HTTP/1.1 with byte-range requests.

The client is a sideloaded app.
The backend is where the interesting work sits: a private object store, a CDN that signs every playback URL, and a catalog that returns fast on a device that cannot afford a slow first byte.

## Status

Deployed to AWS and verified end to end on 2026-11-12, in `ca-central-1`.

| Check | Result |
|---|---|
| `GET /tracks` | 200, returns the seeded catalogue |
| `GET /tracks?q=test` | 200, title prefix match via GSI2 |
| `GET /tracks/{id}/play` | 200, signed CloudFront URL with `Expires`, `Key-Pair-Id`, `Signature` |
| Signed URL fetch | 200, `audio/mpeg`, `accept-ranges: bytes`, immutable cache header |
| `Range: bytes=100000-100999` | 206, `content-range: bytes 100000-100999/481114` |
| Signed URL with signature stripped | 403 |
| Direct S3 object request | 403 |

The client is not written yet.
Next step is proving playback in the BlackBerry browser before packaging, per `docs/plan.md`.

## Adding music

Open the admin panel from the same server that hosts the player:

```
http://<mac-lan-ip>:8080/admin.html
```

Paste the admin key once (it is stored in the browser's local storage). The key lives in Secrets Manager:

```bash
aws secretsmanager get-secret-value \
  --secret-id paulify/admin-key \
  --query SecretString --output text
```

The panel takes drag-and-dropped MP3 files, a cover image, and a release title and artist.
Ticking **Compilation** keeps a per-track artist, which is how a various-artists release differs from a single-artist album.
Files go straight from the browser to S3 with a presigned PUT, so audio never passes through Lambda.

Covers are served unsigned through a `covers/*` CloudFront behaviour, because they are loaded by `<img>` and are not sensitive.
Audio stays behind a signed URL.

## Deploy

```bash
npm install
npm run keys                                  # generates infra/keys/ (gitignored)
npx cdk bootstrap                             # once per account and region
npx cdk deploy

# put the private half of the signing key into Secrets Manager
aws secretsmanager put-secret-value \
  --secret-id paulify/cloudfront-private-key \
  --secret-string file://infra/keys/cloudfront_private_key.pem
```

Optional alarm email:

```bash
npx cdk deploy -c alarmEmail=you@example.com
```

## Architecture

```
BlackBerry Classic (BB10, sideloaded)
   |
   |  1. GET /tracks?q=        (catalog: title, artist, duration)
   |  2. GET /tracks/{id}/play (signed playback URL, ~10 min TTL)
   v
API Gateway (HTTP API) -> Lambda (TypeScript, Node 22)
   |                          |
   |                          +-> DynamoDB (catalog, single table + GSIs)
   |                          +-> CloudFront signer (key group)
   |
   |  3. GET <signed CloudFront URL> with Range header
   v
CloudFront (OAC, ACM cert) -> private S3 bucket (audio, immutable cache headers)
```

Playback is progressive MP3 with byte-range seeking.
CloudFront is the only public entry point for audio; the bucket has no public access and is reachable only through Origin Access Control.

## AWS services and why each one

| Service | Role | Why it is here |
|---|---|---|
| S3 | Audio origin | Private bucket, no public objects, versioning on, lifecycle rule for old masters |
| CloudFront | Streaming edge | Signed URLs via key group, byte-range support, HTTP/1.1 for the old client, ACM cert because BB10's CA store predates Let's Encrypt |
| Lambda | Read path | Catalogue queries and URL minting, no servers to keep warm |
| API Gateway (HTTP API) | Front door | Cheapest API type, request throttling per device |
| DynamoDB | Catalog | Single table with GSIs for artist and title lookup, on-demand billing |
| CloudWatch | Operations | Structured logs, error alarms, Lambda duration and API 5xx metrics |
| IAM | Access | Least privilege per function, no wildcard resources |
| CDK (TypeScript) | Infrastructure as code | Whole stack is reproducible from one `cdk deploy` |

The backend uses the AWS SDK for JavaScript v3 (`@aws-sdk/client-s3`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-secrets-manager`, `@aws-sdk/cloudfront-signer`).

Estimated running cost for one user is near zero: Lambda and CloudFront free tiers, DynamoDB on-demand on a catalog of thousands of items, and a few hundred megabytes of egress.

## Device constraints that drove the design

- **No Media Source Extensions.** Progressive download only, so seeking depends entirely on HTTP range requests and 206 responses from CloudFront.
- **Old TLS and CA trust store.** Certificates come from ACM through CloudFront rather than a free CA whose root may postdate the device.
- **CBR MP3 at 128 kbps.** Variable bitrate makes seeking land at approximate offsets; constant bitrate keeps it predictable.
- **Tiny screen.** The client UI is a single list and a transport bar, no scrolling artwork, no animation.
- **No credentials on the device.** The client never holds AWS keys; it only receives short-lived signed URLs from the API.

## De-risking order

Validate in the BlackBerry browser before fighting the sideload toolchain.
A plain HTML page that lists tracks and plays one over CloudFront proves codecs, TLS, range seeking, and layout on the real screen in minutes.
Only then is it worth packaging as a WebWorks `.bar` (preferred) or falling back to a minimal Android APK for the BB10 Android runtime, which is capped at API 18.

See `docs/plan.md` for the build order and `docs/architecture.md` for the data model and request flow.

## Repository layout

```
infra/     AWS CDK app (TypeScript)
api/       Lambda handlers (TypeScript)
client/    BB10 client (ES5, no framework)
docs/      Architecture and plan
```
