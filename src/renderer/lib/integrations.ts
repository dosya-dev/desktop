import {
  RefreshCw, HardDrive, Server, Cloud, Terminal, Code2, Webhook, CloudDownload,
  CopyX, type LucideIcon,
} from "lucide-react";

/**
 * Card metadata for the Integrations page.
 *
 * This is a deliberate copy of the card fields in apps/web/src/lib/integrations.ts.
 * apps/desktop cannot import from apps/web - they are separate builds with
 * separate lockfiles - and the shared package carries API types, not UI copy.
 * Only the card fields are duplicated; the setup instructions, code samples and
 * credential flows stay on web, which is where these cards send you.
 *
 * Two deliberate differences from web's list:
 *  - No "Desktop apps" card. It offers a download of the app you are already in.
 *  - No "Photo map" tool. On desktop the map lives under Files in the sidebar,
 *    so listing it here too would give one feature two doors on one screen.
 */

export type IntegrationSlug =
  | "rclone" | "webdav" | "sftp" | "s3" | "cli" | "rest-api"
  | "google" | "onedrive" | "dropbox" | "webhooks" | "remote-download";

export interface IntegrationMeta {
  slug: IntegrationSlug;
  title: string;
  description: string;
  tag: string;
  icon: LucideIcon;
  /** Brand logo served from renderer/public. Rendered instead of `icon` when set. */
  iconSrc?: string;
  /** Public docs page. Omitted where none exists (e.g. the cloud importers). */
  docsUrl?: string;
}

/** In-app tools that run natively here - no setup, no browser hand-off. */
export interface ToolMeta {
  to: string;
  title: string;
  description: string;
  tag: string;
  icon: LucideIcon;
}

export const TOOLS: ToolMeta[] = [
  {
    to: "/duplicates",
    title: "Duplicate finder",
    description: "Find byte-identical copies of your files and move the extras to trash.",
    tag: "Tool",
    icon: CopyX,
  },
];

export const INTEGRATIONS: IntegrationMeta[] = [
  {
    slug: "webdav",
    title: "WebDAV",
    description: "Mount your workspace as a network drive on macOS, Windows or Linux.",
    tag: "Mount as drive",
    icon: HardDrive,
    docsUrl: "https://dosya.dev/developer/webdav",
  },
  {
    slug: "s3",
    title: "S3",
    description: "Point any S3-compatible tool or SDK at your workspace.",
    tag: "S3 API",
    icon: Cloud,
    docsUrl: "https://dosya.dev/developer/s3",
  },
  {
    slug: "sftp",
    title: "SFTP",
    description: "Upload and manage files with any SFTP client - FileZilla, WinSCP, Cyberduck or the terminal.",
    tag: "Secure transfer",
    icon: Server,
    docsUrl: "https://dosya.dev/developer/sftp",
  },
  {
    slug: "rclone",
    title: "rclone",
    description: "Copy, sync and mount your files from the command line with rclone.",
    tag: "Sync & mount",
    icon: RefreshCw,
    docsUrl: "https://dosya.dev/developer/rclone",
  },
  {
    slug: "cli",
    title: "CLI",
    description: "Script uploads, downloads and folder sync from your terminal with the dosya CLI.",
    tag: "Terminal",
    icon: Terminal,
    docsUrl: "https://dosya.dev/developer/cli",
  },
  {
    slug: "rest-api",
    title: "REST API",
    description: "Automate everything with the dosya REST API and bearer tokens.",
    tag: "HTTP API",
    icon: Code2,
    docsUrl: "https://dosya.dev/developer/api",
  },
  {
    slug: "google",
    title: "Google Drive",
    description: "Import folders and files from Google Drive, with your folder structure preserved.",
    tag: "Import",
    icon: HardDrive,
    iconSrc: "/google-color.svg",
  },
  {
    slug: "onedrive",
    title: "OneDrive",
    description: "Import folders and files from OneDrive, with your folder structure preserved.",
    tag: "Import",
    icon: HardDrive,
    iconSrc: "/onedrive-color.svg",
  },
  {
    slug: "dropbox",
    title: "Dropbox",
    description: "Import folders and files from Dropbox, with your folder structure preserved.",
    tag: "Import",
    icon: HardDrive,
    iconSrc: "/dropbox-color.svg",
  },
  {
    slug: "webhooks",
    title: "Webhooks",
    description: "Get realtime HTTP notifications when files are uploaded, deleted, or shares are accessed.",
    tag: "Events",
    icon: Webhook,
    docsUrl: "https://dosya.dev/developer/api#webhooks",
  },
  {
    slug: "remote-download",
    title: "Remote download",
    description: "Paste a direct file link and dosya downloads it into your workspace server-side - ideal on slow connections.",
    tag: "Import",
    icon: CloudDownload,
  },
];
