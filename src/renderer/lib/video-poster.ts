// Ported from apps/web/src/lib/video-poster.ts - keep in sync with the web copy.
import { apiBase } from "@/lib/api-client";
import { fileRawUrl } from "@/lib/file-url";

/**
 * Video posters in the browser.
 *
 * The API cannot pull a frame out of a video, so clients make one and store
 * it (PUT /api/files/:id/poster); /thumb then serves it to everyone. A card
 * asks /thumb first. When that 404s, this grabs a frame here: a muted,
 * credentialed <video> reads only the ranges of /raw it needs to seek to one
 * second, the frame is drawn into a 640px canvas, and the JPEG is shown at
 * once and offered to the server so no client has to do it again.
 *
 * A codec the browser cannot play (HEVC in some Chromes) simply fails; the
 * card keeps its plain plate.
 */

export const POSTER_EDGE = 640;
const FRAME_AT_S = 1;
const GRAB_TIMEOUT_MS = 20_000;
const MAX_CONCURRENT = 2;

export interface PosterTarget {
  id: string;
  current_version?: number | null;
}

function versionOf(f: PosterTarget): number {
  return f.current_version && f.current_version > 0 ? f.current_version : 1;
}

/** Draw one frame of `src` into a JPEG no larger than POSTER_EDGE. Null when the browser cannot. */
export function grabFrame(src: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let done = false;
    const finish = (blob: Blob | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Detach the source so the browser drops the connection and its buffer.
      video.removeAttribute("src");
      video.load();
      resolve(blob);
    };
    const timer = setTimeout(() => finish(null), GRAB_TIMEOUT_MS);

    video.crossOrigin = "use-credentials"; // the canvas stays readable, and the cookie rides along
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.onerror = () => finish(null);
    video.onloadedmetadata = () => {
      // A clip shorter than two seconds: the middle, not past the end.
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = d > 0 ? Math.min(FRAME_AT_S, d / 2) : 0;
    };
    video.onseeked = () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return finish(null);
      const scale = Math.min(1, POSTER_EDGE / Math.max(w, h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return finish(null);
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => finish(b), "image/jpeg", 0.7);
      } catch {
        finish(null); // a tainted canvas: the response carried no CORS grant
      }
    };
    video.src = src;
  });
}

/**
 * Store a poster for every client. Best effort: a viewer without upload
 * rights gets a 403, a stale version a 409, and either way this tab already
 * shows its own frame. The server keeps the first poster it is given.
 */
export async function storePoster(f: PosterTarget, jpeg: Blob): Promise<void> {
  try {
    await fetch(`${apiBase()}/api/files/${encodeURIComponent(f.id)}/poster?version=${versionOf(f)}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "image/jpeg" },
      body: jpeg,
    });
  } catch {
    // Offline or refused; the next viewer tries again.
  }
}

// One grab per file version for the life of the tab, two at a time.
const made = new Map<string, Promise<string | null>>();
let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/**
 * An object URL of a poster made in this tab, or null. Repeat calls for the
 * same version (a re-render, a second card) share one grab and its result.
 */
export function ensurePoster(f: PosterTarget): Promise<string | null> {
  const key = `${f.id}:${versionOf(f)}`;
  const have = made.get(key);
  if (have) return have;
  const job = withSlot(async () => {
    const jpeg = await grabFrame(fileRawUrl({ fileId: f.id, version: versionOf(f) }));
    if (!jpeg) return null;
    void storePoster(f, jpeg);
    return URL.createObjectURL(jpeg);
  }).catch(() => null);
  made.set(key, job);
  return job;
}

/** Test seam. */
export function __resetPosters(): void {
  made.clear();
  running = 0;
  waiting.length = 0;
}
