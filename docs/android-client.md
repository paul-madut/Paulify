# Android client for the BlackBerry Classic

Goal: a sideloaded APK that plays the Paulify catalogue natively, replacing the browser tab with a proper app.

## What already exists

The entire backend is done and does not need to change:

- `GET /albums` and `GET /albums/{id}` return the catalogue and ordered tracks.
- `GET /tracks/{id}/play` returns a signed CloudFront URL valid for ten minutes.
- Covers are unsigned and cacheable.
- Audio supports byte-range requests, so seeking works.
- CORS is irrelevant to a native client.

So the app is a view layer over an API that already works.

## Device constraints that shape every decision

| Constraint | Consequence |
|---|---|
| BB10 Android runtime is **Android 4.3, API 18** | No Jetpack, no Compose, no Media3, no Kotlin coroutines library unless the app still targets API 18 |
| **360x360 dp** display (720x720 px at xhdpi) | Design square. One column of albums, not a two-column phone grid |
| No Google Play Services | Nothing from Play; plain HTTP, no Firebase |
| TLS 1.2 disabled by default on API 18 HTTP stack | Must force it or CloudFront refuses the handshake |
| Snapdragon S4 Plus, 2 GB RAM, Adreno 225 | Small image cache, downsampled covers, no animation |
| No `adb` on the device | Diagnostics must be on screen or in logcat via SideSwipe, so build a debug overlay in |

## Approach

Deliberately boring: **one Activity, `GridView` for albums, `ListView` for tracks, `MediaPlayer` for audio, `HttpURLConnection` for HTTP, `org.json` for parsing.**

No third-party libraries unless one earns its place. That keeps the APK small, avoids dependency graphs that assume API 21, and makes the build reproducible with an old toolchain.

### Package layout

```
com.paulmadut.paulify
  MainActivity          album grid, back handling
  AlbumActivity         track list for one release
  PlayerService         MediaPlayer + notification (stretch, see milestones)
  api/PaulifyClient     HTTP, JSON, TLS configuration
  api/Models            Album, Track
  images/CoverLoader    downsampling + LruCache
  ui/Diagnostics        overlay log, toggled from the overflow
```

### Networking

- `HttpsURLConnection` with an `SSLSocketFactory` that explicitly enables `TLSv1.2`. On API 18 the default handshake may negotiate TLS 1.0 and CloudFront will reject it.
- Connect and read timeouts around 10 seconds, matching the web client.
- JSON via `org.json`, which ships with the platform.
- Every request on a background thread, result posted to the UI thread through a `Handler`.

### Playback

- `MediaPlayer` with `setAudioStreamType(STREAM_MUSIC)` and the signed URL as the data source.
- Seeking calls `seekTo`, and the HTTP stack issues the range request. This is the same path the browser takes, already proven end to end.
- `setOnErrorListener` requests a **fresh signed URL** and retries once from the last position. A ten-minute TTL will eventually bite a long listening session, and this is the whole reason the API returns `expiresAt`.
- Audio focus via `AudioManager` so the browser or a call does not fight it.
- Background playback is a stretch goal: API 18 has no `MediaSession`, so it needs a foreground `Service` plus `RemoteControlClient`, which is deprecated but is what this platform has.

### Images

- Covers are up to several megabytes as uploaded. Downsample to roughly 360 px wide before decoding into memory, and hold them in an `LruCache` sized to about an eighth of available heap.
- A missing cover draws a coloured placeholder rather than an empty box.

### Build and signing

- Gradle 7.6, AGP 7.4, JDK 11, `minSdk 18`, `targetSdk 18`, `compileSdk 33`.
- Sign with a local keystore. Debug signing is enough for sideloading, but a real keystore means future updates install over the old copy instead of forcing an uninstall first.
- Output `paulify-release.apk` and keep the keystore out of the repository.

### Sideloading

1. On the device: Settings, Security and Privacy, Development Mode, enable it (this requires setting a device password).
2. Connect over USB, open Sachesi on the Mac, drop the APK in.
3. The app appears on the home screen with the rest of the Android apps.

If Sachesi refuses, DDBP on the command line does the same job and gives worse error messages.

## Milestones

1. **Skeleton that lists albums.** HTTP, TLS fix, JSON, `GridView`, covers. Success is four album cards on the device.
2. **Album detail and playback.** Track list, tap to play, working transport for a single album queue.
3. **Seeking and error recovery.** Scrubber wired to `seekTo`, plus the signed-URL refresh on error.
4. **Polish.** Diagnostics overlay, empty and error states, square layout pass.
5. **Stretch: background playback** via a foreground service and notification controls.

Milestones 1 and 2 are the ones that decide whether this is viable. Everything after is refinement.

## Risks, ranked

1. **The build toolchain.** AGP and Gradle versions that still support `minSdk 18` need JDK 11 rather than the current default. Pin them in `gradle-wrapper.properties` and `build.gradle`, and do not let a global Gradle update touch it.
2. **TLS on API 18.** If the socket factory is wrong the app fails with an opaque SSL error on every call. Test the handshake on a real machine before building UI.
3. **Cover weight on mobile data.** A 2.4 MB cover over cellular on this device is a bad experience. Downsample, or re-encode covers at upload time.
4. **Signed URL expiry during playback.** Mitigated by the refresh-on-error path, but it must be written, not assumed.

## What stays the same

The web client remains the reference implementation for behaviour, and the diagnostics overlay in the app mirrors the browser's DIAG panel, so a failure on the device can be diagnosed from a screenshot instead of a debugger.
