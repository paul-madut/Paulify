# Architecture

## Request flow

1. The client asks the catalogue for tracks.
   `GET /tracks?q=radiohead` returns id, title, artist, album, duration, and bitrate.
   No audio crosses this path.
2. The client asks for a playback URL for one track.
   `GET /tracks/{id}/play` returns a signed CloudFront URL plus an expiry timestamp.
3. The client plays the URL with `<audio>` and sends `Range: bytes=...` when the user seeks.
   CloudFront answers with `206 Partial Content`.

Signing happens in Lambda, never on the device.
The device holds no AWS credentials and cannot mint its own URLs.

## Data model

Single DynamoDB table, on-demand billing.

| Item | PK | SK | Notes |
|---|---|---|---|
| Track | `TRACK#<id>` | `META` | title, artist, album, durationMs, s3Key, bitrate, sizeBytes, addedAt |
| Playlist membership | `PLAYLIST#<id>` | `TRACK#<id>` | position attribute for ordering |

GSIs:

- `GSI1`: `artistLower` partition, `addedAt` sort, for "everything by this artist".
- `GSI2`: `titleLower` partition, for exact and prefix lookups on track title.

Search stays deliberately dumb.
A catalogue of a few thousand tracks does not need a search cluster, and DynamoDB `begins_with` is enough for the client's single search box.

## Storage layout

```
s3://paulify-audio/
  audio/<trackId>/<trackId>.mp3     128 kbps CBR, immutable, max-age 1 year
  audio/<trackId>/cover.jpg         400x400, immutable
```

Objects are never rewritten in place.
A re-encode writes a new key and updates the DynamoDB item, so cached copies at the edge never go stale.

## Signing

CloudFront key group with a public key registered on the distribution.
Lambda holds the private key in Secrets Manager and signs URLs with a short TTL.

- TTL of 10 minutes is long enough to start a track and short enough that a leaked URL is not durable.
- Signed URLs, not signed cookies, because the client makes one request per track and has no cookie jar worth trusting.
- The bucket policy allows only the distribution's service principal through Origin Access Control.

## Failure modes worth handling

| Failure | Handling |
|---|---|
| Signed URL expires mid-track | Client requests a fresh URL on the next `stalled` or `error` event and resumes at the last known offset |
| Lambda cold start | Keep the handler small, no SDK clients constructed per request outside the module scope |
| Track missing from S3 | Return 404 from the play endpoint before signing, not a valid URL that 403s |
| Catalogue grows past a scan | All reads go through a GSI or a key condition, never `Scan` |
| Alarm fires at 3am | CloudWatch alarm on API 5xx rate and Lambda error count, notification to email |

## Security notes

- No long-lived credentials in the repository or the client.
- GitHub Actions deploys with an OIDC role, not stored access keys.
- Bucket blocks all public access; the only path to an object is a signed CloudFront URL.
- Input validation on `q` and `{id}` before they reach DynamoDB.
