import {
  RefreshCw, HardDrive, Server, Cloud, Terminal, Code2, Webhook, CloudDownload,
  CopyX, type LucideIcon,
} from "lucide-react";
import { t } from "./i18n";
import type { MessageKey } from "../../i18n/keys";

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
 *
 * Text is held as catalog keys and translated at render (cardTitle(), t()).
 * A product name (WebDAV, rclone, Google Drive) is a plain `name` and never
 * translated; a descriptive title ("Remote download") is a `titleKey`.
 */

export type IntegrationSlug =
  | "rclone" | "webdav" | "sftp" | "s3" | "cli" | "rest-api"
  | "google" | "onedrive" | "dropbox" | "webhooks" | "remote-download";

/** A card title: a product name as is, or a catalog key for a descriptive one. */
export type CardTitle = { name: string } | { titleKey: MessageKey };

/** The card title in the current language (product names unchanged). */
export function cardTitle(title: CardTitle): string {
  return "name" in title ? title.name : t(title.titleKey);
}

export interface IntegrationMeta {
  slug: IntegrationSlug;
  title: CardTitle;
  description: MessageKey;
  tag: MessageKey;
  icon: LucideIcon;
  /** Brand logo served from renderer/public. Rendered instead of `icon` when set. */
  iconSrc?: string;
  /** Public docs page. Omitted where none exists (e.g. the cloud importers). */
  docsUrl?: string;
}

/** In-app tools that run natively here - no setup, no browser hand-off. */
export interface ToolMeta {
  to: string;
  title: CardTitle;
  description: MessageKey;
  tag: MessageKey;
  icon: LucideIcon;
}

export const TOOLS: ToolMeta[] = [
  {
    to: "/duplicates",
    title: { titleKey: "integrations.heading.duplicateFinder" },
    description: "integrations.description.findByteIdenticalCopiesOfYourFilesAndMove",
    tag: "integrations.label.tool",
    icon: CopyX,
  },
];

export const INTEGRATIONS: IntegrationMeta[] = [
  {
    slug: "webdav",
    title: { name: "WebDAV" },
    description: "integrations.description.mountYourWorkspaceAsANetworkDriveOnMacOS",
    tag: "integrations.label.mountAsDrive",
    icon: HardDrive,
    docsUrl: "https://dosya.dev/developer/webdav",
  },
  {
    slug: "s3",
    title: { name: "S3" },
    description: "integrations.description.pointAnyS3CompatibleToolOrSDKAtYour",
    tag: "integrations.label.s3API",
    icon: Cloud,
    docsUrl: "https://dosya.dev/developer/s3",
  },
  {
    slug: "sftp",
    title: { name: "SFTP" },
    description: "integrations.description.uploadAndManageFilesWithAnySFTPClientFileZilla",
    tag: "integrations.label.secureTransfer",
    icon: Server,
    docsUrl: "https://dosya.dev/developer/sftp",
  },
  {
    slug: "rclone",
    title: { name: "rclone" },
    description: "integrations.description.copySyncAndMountYourFilesFromTheCommand",
    tag: "integrations.label.syncMount",
    icon: RefreshCw,
    docsUrl: "https://dosya.dev/developer/rclone",
  },
  {
    slug: "cli",
    title: { titleKey: "integrations.heading.cli" },
    description: "integrations.description.scriptUploadsDownloadsAndFolderSyncFromYourTerminal",
    tag: "integrations.label.terminal",
    icon: Terminal,
    docsUrl: "https://dosya.dev/developer/cli",
  },
  {
    slug: "rest-api",
    title: { titleKey: "integrations.heading.restAPI" },
    description: "integrations.description.automateEverythingWithTheDosyaRESTAPIAndBearer",
    tag: "integrations.label.httpAPI",
    icon: Code2,
    docsUrl: "https://dosya.dev/developer/api",
  },
  {
    slug: "google",
    title: { name: "Google Drive" },
    description: "integrations.description.importFoldersAndFilesFromGoogleDriveWithYour",
    tag: "common.label.import",
    icon: HardDrive,
    iconSrc: "/google-color.svg",
  },
  {
    slug: "onedrive",
    title: { name: "OneDrive" },
    description: "integrations.description.importFoldersAndFilesFromOneDriveWithYourFolder",
    tag: "common.label.import",
    icon: HardDrive,
    iconSrc: "/onedrive-color.svg",
  },
  {
    slug: "dropbox",
    title: { name: "Dropbox" },
    description: "integrations.description.importFoldersAndFilesFromDropboxWithYourFolder",
    tag: "common.label.import",
    icon: HardDrive,
    iconSrc: "/dropbox-color.svg",
  },
  {
    slug: "webhooks",
    title: { titleKey: "integrations.heading.webhooks" },
    description: "integrations.description.getRealtimeHTTPNotificationsWhenFilesAreUploadedDeleted",
    tag: "integrations.label.events",
    icon: Webhook,
    docsUrl: "https://dosya.dev/developer/api#webhooks",
  },
  {
    slug: "remote-download",
    title: { titleKey: "integrations.heading.remoteDownload" },
    description: "integrations.description.pasteADirectFileLinkAndDosyaDownloadsIt",
    tag: "common.label.import",
    icon: CloudDownload,
  },
];
