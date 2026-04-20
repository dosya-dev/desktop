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

## License

[MIT](LICENSE)
