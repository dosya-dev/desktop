# dosya desktop

The official desktop client for [dosya.dev](https://dosya.dev) — sync, upload, and manage your files.

## Features

- **Bidirectional file sync** — 5 sync modes: two-way, push, push-safe, pull, pull-safe
- **Conflict detection** — 3-way reconciliation with resolution strategies
- **Dashboard** — Storage usage, recent files, activity feed
- **File browser** — Navigate, upload, download, and manage files
- **Shared links** — Create and manage share links with passwords and expiry
- **Team collaboration** — Manage workspace members and roles
- **File requests** — Receive files from external users
- **LAN transfer** — Peer-to-peer file transfer on local networks
- **Search** — Full-text search across files and folders
- **Auto-updates** — Built-in update mechanism
- **System tray** — Background sync with tray icon
- **macOS Quick Action** — `dosya://` protocol handler for direct sync setup

## Tech Stack

- **Electron 34** — Cross-platform desktop framework
- **React 19** — UI framework
- **TypeScript 5.7** — Type safety
- **TanStack React Query** — Server state management
- **Zustand** — Client state management
- **Tailwind CSS 4** — Styling
- **Radix UI** — Accessible UI primitives
- **electron-vite** — Build tooling

## Development

### Prerequisites

- Node.js >= 18
- npm

### Setup

```bash
npm install
```

### Commands

```bash
npm run dev            # Start dev server with hot reload
npm run build          # Build for production
npm run typecheck      # Run TypeScript checks
```

### Packaging

```bash
npm run package        # Build for current platform
npm run package:mac    # macOS (DMG, universal binary)
npm run package:win    # Windows (NSIS, x64 + ARM64)
npm run package:linux  # Linux (AppImage + DEB)
```

## Project Structure

```
src/
├── main/              # Electron main process
│   ├── index.ts       # App lifecycle, window management
│   ├── sync/          # Sync engine (watcher, poller, reconciler)
│   ├── tray.ts        # System tray integration
│   ├── updater.ts     # Auto-updater
│   └── session.ts     # Session management
├── preload/           # Preload scripts (context bridge)
└── renderer/          # React SPA
    ├── pages/         # Application pages
    ├── components/    # Reusable components
    └── lib/           # API client, stores, utilities
```

## Transparency

Every dosya.dev client is source-available. Your files are yours — this repository lets
you verify exactly what the app sends to and receives from our servers: what gets
uploaded, what metadata travels with it, and what comes back. If a claim we make about
privacy or sync behavior can't be verified in this code, open an issue and call it out.

## License

Source-available under the [Dosya Source Available License 1.0](LICENSE):

- **You can** read and audit the code, build and run it with the official
  [dosya.dev](https://dosya.dev) service, and contribute improvements.
- **You can't** redistribute it, use it with any backend other than dosya.dev, or offer
  it as a service.

See [LICENSE](LICENSE) for the exact terms. Versions of this code previously published
under the MIT license remain MIT for those who obtained them then.

## Contributing

Issues and pull requests are welcome. By submitting a contribution you license it to
dosya.dev under the contribution terms in [LICENSE](LICENSE).

## Security

Found a vulnerability? Please report it privately via
[GitHub private vulnerability reporting](../../security/advisories/new) rather than a
public issue.

## The dosya.dev client family

| Repository | What it is | License |
|---|---|---|
| [desktop](https://github.com/dosya-dev/desktop) | Desktop client — sync, upload, manage | Source-available |
| [cli](https://github.com/dosya-dev/cli) | Command-line interface | Source-available |
| [app.dosya.dev](https://github.com/dosya-dev/app.dosya.dev) | Web application | Source-available |
| [shared](https://github.com/dosya-dev/shared) | Shared TypeScript types & utilities | Source-available |
| [dosya-js](https://github.com/dosya-dev/dosya-js) | Official JavaScript SDK | MIT |
| [dosya-java](https://github.com/dosya-dev/dosya-java) | Official Java SDK | MIT |
