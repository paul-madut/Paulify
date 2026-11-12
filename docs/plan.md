# Build plan

Target: a working end-to-end stream onto the BlackBerry Classic, with the AWS stack committed and reproducible.
Ordered so the risky, unfamiliar part is proven early and cheaply.

## Prerequisite: an AWS account

Nothing in the backend can be verified without one.
There is no AWS account configured on the development machine (no CLI, no credentials), and no Docker for a local emulator.
Two options:

- **Free tier account (recommended).** The whole stack fits inside the free tier for personal use.
  Cost at this scale is effectively zero: Lambda and CloudFront free allowances, DynamoDB on-demand on a small catalogue, and a few hundred MB of egress.
- **Deferred deploy.** Write and commit the CDK and handler code now, deploy later.
  Everything except the deploy step stays verifiable: `cdk synth`, unit tests, and typecheck all run offline.

The plan below assumes the free tier account exists by step 2.
Steps 1 and 3 do not depend on it.

## Milestones

### 1. Repo and skeleton (done)

README, architecture, plan, TypeScript project layout, `.gitignore`, MIT license.

### 2. Infrastructure (about an hour)

- CDK app with one stack: S3 bucket, DynamoDB table and two GSIs, CloudFront distribution with OAC, Lambda, HTTP API, CloudWatch alarms.
- `cdk bootstrap` once per account and region, then `cdk deploy`.
- Prove it: `aws s3 cp` a test MP3, confirm the object is not publicly reachable, and confirm a signed URL fetched from the CLI plays.

This is the step that turns the resume claims into facts. Do it before writing the client.

### 3. API (about an hour)

- `GET /tracks` with `q` free-text on title and artist.
- `GET /tracks/{id}/play` returning `{ url, expiresAt }`, 404 when the object is missing.
- Seed script that reads a local folder of MP3s, extracts tags, uploads to S3, and writes DynamoDB items.
- Unit tests with Vitest around the handlers, with the SDK clients mocked.

### 4. Prove playback on the device, in the browser (about 30 minutes)

Before any packaging.
Open a plain HTML page on the Classic that lists tracks and plays one.
This answers the questions that actually matter: does BB10 negotiate TLS with the CloudFront certificate, does the MP3 decode, does seeking issue a range request, and does the layout fit 720x720.

If this step fails, it fails cheaply and nothing downstream was wasted.

### 5. Package and sideload (about an hour, highest unknown)

- Preferred: WebWorks `.bar`, built unsigned and installed with a debug token through Sachesi or DDBP once Development Mode is enabled.
- Fallback: a minimal Android APK for the BB10 Android runtime, which tops out at API 18, so it needs an older build toolchain and a plain `MediaPlayer` plus `ListView`.

The BB10 SDK tooling is a decade old and may not install cleanly on current macOS.
That is why this step comes after playback is already proven.

### 6. CI and operations (about 30 minutes)

- GitHub Actions: typecheck, unit tests, `cdk synth` on every pull request; deploy on `main` through an OIDC role.
- CloudWatch alarm on API 5xx rate and Lambda errors, notification to email.
- README updated with architecture diagram and screenshots from the device.

## Deliberate non-goals

- No HLS or DASH. The device cannot demux them without MSE.
- No user accounts or social features. One user, one device.
- No transcoding pipeline on day one. Pre-encode locally at 128 kbps CBR; a Lambda and EventBridge pipeline is a later addition.
- No search service. DynamoDB key conditions are enough at this size.

## Cost guardrails

- DynamoDB on-demand, not provisioned.
- CloudFront price class limited to the regions actually used.
- S3 lifecycle rule expires old masters.
- Budget alarm at a low threshold so a mistake is visible immediately.
