# Releasing the desktop app

One version, one workflow run, every channel. The run is
`.github/workflows/desktop-release.yml`; the record of what shipped where is
`channels` in `desktop-builds/latest.json` on R2 (served by
`GET /api/desktop/info`).

## Cut a release

```
node scripts/desktop-release.mjs 3.0.10          # bump + commit + tag
node scripts/desktop-release.mjs 3.0.10 --push   # and push, which starts the run
```

The script bumps `apps/desktop/package.json` and its lockfile, commits, and
tags `desktop-v3.0.10`. Pushing the tag triggers the workflow. The workflow
refuses a tag whose version differs from package.json, so do not tag by hand.

Versions must be `X.Y.Z` and strictly increasing: the Microsoft Store and the
Snap Store both reject a submission that does not go up.

## What the run does

| Job | Builds | Publishes |
| --- | --- | --- |
| build-mac | universal `.dmg` (download) + `.zip` (auto-update), signed, notarized, stapled | R2 |
| build-windows | NSIS `.exe` (download + auto-update), unsigned AppX (Store) | R2; Store submission via the Microsoft Store CLI |
| build-linux | `.AppImage` (download + auto-update), `.deb`, `.snap` | R2; `snapcraft upload --release=<channel>` |
| update-manifest | | merges `version`, `builds` and `channels` into `latest.json` |

The AppX and the snap are always kept as run artifacts (14 days). They are the
manual fallback if a store step breaks: drag the AppX into Partner Center, or
`snapcraft upload --release=stable dosya_*.snap` locally.

Store steps skip themselves with a warning when their secrets are missing,
so the run still ships the direct download.

## Manual runs

Actions > Desktop Release > Run workflow:

- **version**: empty means package.json's version.
- **channels**: `direct,msstore,snap`, or any subset. Use a subset to re-publish
  one channel without touching the others (e.g. `snap` after fixing a snap-only
  problem; the direct feed keeps its current version).
- **snap_channel**: `candidate` (default) or `stable`.
- **dry_run**: builds everything, publishes nothing, keeps every artifact.
  This is how to test a packaging change before a real release.

## Channels

### Direct download

`latest.json` on R2 is the updater feed and what `/desktop` renders. Nothing
else to do.

### Microsoft Store

`msstore publish` creates a submission from the last published one, uploads
the package and commits it to certification. Microsoft publishes it when
certification passes, typically within a day. Status: Partner Center, or
`msstore submission status 9P1Q4PM856ST` locally after `msstore reconfigure`.

The AppX is deliberately unsigned; Microsoft signs it. The identity block in
`electron-builder.yml` must match Partner Center's Product identity page
exactly, and the workflow asserts it does before submitting.

Secrets: `PARTNER_CENTER_TENANT_ID`, `PARTNER_CENTER_CLIENT_ID`,
`PARTNER_CENTER_CLIENT_SECRET` (an Entra application with the Manager role,
created under Partner Center > Account settings > User management),
`PARTNER_CENTER_SELLER_ID`. The Store ID is `MS_STORE_PRODUCT_ID` in the
workflow file.

### Snap Store

Strict confinement, base core22, built from electron-builder's Electron snap
template. Every release lands on `candidate`; promote when you have tried it:

```
sudo snap install dosya --candidate     # try it
snapcraft release dosya <revision> stable
```

or re-run the workflow with `channels=snap` and `snap_channel=stable`.

Two plugs are not auto-connected. Users who sync folders on other drives run
`sudo snap connect dosya:removable-media`; the keyring interface is
`dosya:password-manager-service`.

Secret: `SNAPCRAFT_STORE_CREDENTIALS`, from
`snapcraft export-login --snaps=dosya --channels=edge,beta,candidate,stable --acls=package_access,package_push,package_update,package_release -`.
Snapcraft tokens expire after a year; the upload step fails with an auth
error when that happens, and a fresh export is the fix.

### Mac App Store

Not shipped. `src/main/distribution.ts` already recognises a `mas` build so
the updater and the Settings copy need no change when it is; the packaging
(sandbox entitlements, security-scoped bookmarks for sync folders,
distribution profile, Transporter upload) is the outstanding work.

## How the app knows its channel

`src/main/distribution.ts` reads platform signals at runtime:
`process.windowsStore` (AppX container), `process.mas`, and snapd's
`SNAP`/`SNAP_NAME`. Any store build disables electron-updater and shows the
store's own update copy in Settings. Sentry events carry a `distribution` tag.
There is no build flag to keep in sync.
