# dosya.dev File Provider for macOS

Puts dosya.dev in Finder under Locations: the whole account is browsable
immediately and a file's contents are fetched when something opens it.

This is a Swift package rather than an app extension target because SwiftPM
cannot build an `.appex` and because keeping the provider here makes all of it
reachable from `swift test`. The signed extension bundle that wraps it, and the
entitlements it needs, are phase 3.

It is a deliberate copy of the iOS Files extension in the mobile app, not a
shared source tree: each app publishes to its own public mirror, so a cross-app
import would break the mirror. The two will drift, the same way the Kotlin, Swift and
TypeScript clients already differ.

## Build and test

```
swift build
swift test
```

Nothing here needs signing, entitlements or a network.

## What the app must write

The session lives in the **data protection** keychain, which on macOS is the
only one where an access group and an accessibility class mean anything. A
writer using the legacy keychain, which includes Electron's `safeStorage` and
`keytar`, puts the item somewhere this extension cannot see.

| | |
| --- | --- |
| keychain | data protection (`kSecUseDataProtectionKeychain`) |
| service | `dev.dosya.desktop.files-provider` |
| account | `linked-session` |
| access group | the entitled group ending in `group.dev.dosya.desktop`, team-prefixed |
| value | UTF-8 JSON: `access`, `refresh`, `apiBaseUrl`, and optionally `userId` |

## Authentication

The extension never signs anyone in. The desktop app mints it a session with
`POST /api/auth/desktop/linked-session` and writes it to the keychain; this code
reads it and refreshes it against `POST /api/auth/mobile/refresh`, because a
desktop linked session is a `mobile_tokens` row. Signing out of the app, or
revoking that session anywhere, kills it.
