import http from "http";
import { readFileSync } from "fs";
import { join } from "path";
import * as data from "./mock-data";

/** The real tagged MP3 the audio-viewer spec plays. Read once per process. */
const SAMPLE_MP3 = readFileSync(join(__dirname, "../fixtures/sample-track.mp3"));

export interface MockApiOptions {
  authenticated?: boolean;
  /** Workspaces returned by GET /api/workspaces (default: [mockWorkspace]). */
  workspaces?: unknown[];
  /** Delay (ms) before the upload PUT responds - lets tests catch mid-flight state. */
  uploadDelayMs?: number;
}

export interface MockServer {
  url: string;
  close: () => Promise<void>;
}

/** Start a real HTTP mock server (Playwright route.fulfill doesn't set status/headers in Electron). */
export async function startMockServer(
  options: MockApiOptions = {},
): Promise<MockServer> {
  const { authenticated = true, workspaces = [data.mockWorkspace], uploadDelayMs = 0 } = options;

  // Test-only instrumentation: counts POST /api/upload/init calls so specs
  // can assert no *new* upload activity happens after a given point (e.g.
  // after a workspace switch should have canceled the queue). Scoped to this
  // server instance, so it resets per test.
  let uploadInitCount = 0;

  // Test-only folder store: POST /api/folders and /api/folders/batch persist
  // here so sync specs can assert the remote tree shape (parent linkage) via
  // GET /__test/folders. Semantics mirror apps/api folders/batch.ts: parent_id
  // is used literally (no in-batch placeholder resolution), an unresolvable
  // parent drops the entry, and (parent_id, name) is find-or-create.
  const folderStore = new Map<string, { id: string; name: string; parent_id: string | null; is_synced: number }>();
  let folderSeq = 0;
  const createFolderRecord = (name: string, parentId: string | null) => {
    for (const f of folderStore.values()) {
      if (f.name === name && f.parent_id === parentId) return { folder: f, created: false };
    }
    const folder = { id: `fld_${++folderSeq}`, name, parent_id: parentId, is_synced: 0 };
    folderStore.set(folder.id, folder);
    return { folder, created: true };
  };
  const readBody = (req: http.IncomingMessage): Promise<any> =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
      });
    });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;
    const method = req.method || "GET";
    if (process.env.MOCK_API_DEBUG) console.log(`[mock] ${method} ${path}`);

    // Credentialed CORS forbids the "*" wildcard - the renderer fetches with
    // credentials: "include" from a real origin (app://bundle) now that
    // webSecurity is enabled, so echo the request origin back instead.
    const corsHeaders = {
      "Access-Control-Allow-Origin": req.headers.origin || "*",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Cookie, Range",
      "Vary": "Origin",
    };

    const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        ...corsHeaders,
        ...extraHeaders,
      });
      res.end(JSON.stringify(body));
    };

    // Handle CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      return res.end();
    }

    // ── Auth ──────────────────────────────────────────────
    if (path === "/api/me" && method === "GET") {
      if (!authenticated) return json({ ok: false, error: "Unauthorized" }, 401);
      // The main process mirrors dosya_session Set-Cookie headers into the
      // Electron cookie jar (src/main/session.ts) - the sync engine's
      // hasSession() login gate checks that jar, so authenticated fixtures
      // must carry a session cookie, not just a 200 from /api/me.
      return json({ ok: true, user: data.mockUser }, 200, {
        "Set-Cookie": "dosya_session=mock-session; Path=/",
      });
    }
    if (path === "/api/me" && method === "PATCH") return json({ ok: true, user: data.mockUser });
    if (path === "/api/me/sessions" && method === "GET") return json({ ok: true, sessions: data.mockSessions });
    if (path === "/api/me/api-keys" && method === "GET") return json({ ok: true, keys: [] });
    if (path === "/api/me/change-password" && method === "POST") return json({ ok: true });
    if (path === "/api/me/avatar") {
      res.writeHead(200, { "Content-Type": "image/png", ...corsHeaders });
      return res.end(Buffer.from([]));
    }
    if (path === "/api/auth/login" && method === "POST") return json({ ok: true, user: data.mockUser });
    if (path === "/api/auth/signup" && method === "POST") return json({ ok: true });
    if (path === "/api/auth/2fa/verify" && method === "POST") return json({ ok: true, user: data.mockUser });
    if (path.startsWith("/api/auth/forgot") && method === "POST") return json({ ok: true });
    if (path.startsWith("/api/auth/reset") && method === "POST") return json({ ok: true });
    if (path === "/api/auth/verify-email" && method === "POST") return json({ ok: true });
    if (path === "/api/auth/logout" && method === "POST") return json({ ok: true });

    // ── Workspaces ────────────────────────────────────────
    if (path === "/api/workspaces" && method === "GET") return json({ ok: true, workspaces });
    if (path === "/api/workspaces" && method === "POST") return json({ ok: true, workspace: data.mockWorkspace });
    if (/^\/api\/workspaces\/[^/]+\/settings$/.test(path) && method === "GET") {
      return json({
        ok: true,
        settings: {
          max_file_size_gb: 5, max_total_storage_gb: 100, max_storage_per_member_gb: 10,
          max_concurrent_uploads: 5, allowed_extensions: null, blocked_extensions: null,
          require_2fa: 0, disable_share_links: 0, force_share_password: 0, share_max_expiry_days: null,
        },
      });
    }
    if (/^\/api\/workspaces\//.test(path) && method === "PATCH") return json({ ok: true });

    // ── Dashboard ─────────────────────────────────────────
    if (path === "/api/dashboard" && method === "GET") {
      return json({
        ok: true,
        user_name: "Test User",
        stats: {
          total_files: 42,
          files_this_week: 3,
          shared_externally: 5,
          total_bytes: 1_073_741_824,
          storage_cap_bytes: 10_737_418_240,
        },
        storage_breakdown: [
          { name: "Documents", bytes: 524_288_000, color: "#3B82F6" },
          { name: "Images", bytes: 314_572_800, color: "#10B981" },
          { name: "Videos", bytes: 234_881_024, color: "#F59E0B" },
        ],
        recent_files: [
          { id: "file_1", name: "Project Report.pdf", size_bytes: 1_048_576, extension: "pdf", created_at: 1740825600, share_count: 1 },
          { id: "file_2", name: "Photo.png", size_bytes: 2_097_152, extension: "png", created_at: 1740912000, share_count: 0 },
        ],
        activity: [
          { id: "act_1", action: "file.upload", entity_type: "file", metadata: null, created_at: 1740825600, user_name: "Test User", meta: { name: "Project Report.pdf" } },
        ],
        team_stats: [],
      });
    }

    // ── Files ─────────────────────────────────────────────

    // Serve the sample MP3 the way the real /raw does, RANGE INCLUDED - the
    // audio viewer reads its tags with a 256KB ranged request, so a mock that
    // ignored Range would exercise a path production does not have.
    if (/^\/api\/files\/[^/]+\/raw$/.test(path) && (method === "GET" || method === "HEAD")) {
      const size = SAMPLE_MP3.length;
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (m && (m[1] !== "" || m[2] !== "")) {
        const start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);
        const end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
        if (start >= size || start > end) {
          res.writeHead(416, { ...corsHeaders, "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" });
          res.end();
          return;
        }
        res.writeHead(206, {
          ...corsHeaders,
          "Content-Type": "audio/mpeg",
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
        });
        res.end(method === "HEAD" ? undefined : SAMPLE_MP3.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, {
        ...corsHeaders,
        "Content-Type": "audio/mpeg",
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
      });
      res.end(method === "HEAD" ? undefined : SAMPLE_MP3);
      return;
    }

    if (path === "/api/files" && method === "GET") {
      return json({ ok: true, files: data.mockFiles, total: data.mockFiles.length, page: 1, per_page: 50, total_pages: 1 });
    }
    if ((path === "/api/files/folder" || path === "/api/folders") && method === "POST") {
      readBody(req).then((body) => {
        const { folder } = createFolderRecord(body.name || "New Folder", body.parent_id ?? null);
        json({ ok: true, folder: { ...folder, kind: "folder" } });
      });
      return;
    }
    if (/^\/api\/folders\/[^/]+\/sync$/.test(path) && method === "POST") {
      readBody(req).then((body) => {
        const folder = folderStore.get(path.split("/")[3]);
        if (folder) folder.is_synced = body.enabled ? 1 : 0;
        json({ ok: true });
      });
      return;
    }
    if (/^\/api\/folders\/[^/]+$/.test(path) && method === "GET") {
      const folder = folderStore.get(path.split("/")[3]);
      if (!folder) return json({ ok: false, error: "Not found" }, 404);
      return json({ ok: true, folder });
    }
    if (path === "/api/folders/batch" && method === "POST") {
      readBody(req).then((body) => {
        const results: { name: string; parent_id: string | null; id: string; created: boolean }[] = [];
        for (const entry of body.folders ?? []) {
          const parentId = entry.parent_id ?? null;
          // Prod drops entries whose parent_id doesn't resolve to an existing folder
          if (parentId && !folderStore.has(parentId)) continue;
          const { folder, created } = createFolderRecord(entry.name, parentId);
          results.push({ name: folder.name, parent_id: folder.parent_id, id: folder.id, created });
        }
        json({ ok: true, folders: results });
      });
      return;
    }
    if (/^\/api\/files\/[^/]+$/.test(path) && method === "DELETE") return json({ ok: true });
    if (/^\/api\/files\/[^/]+$/.test(path) && method === "PATCH") return json({ ok: true });
    if (/^\/api\/files\/[^/]+\/share$/.test(path) && method === "POST") return json({ ok: true, share: data.mockShareLinks[0] });

    // ── Activity ──────────────────────────────────────────
    // ── Notifications ──────────────────────────────────────────
    if (path === "/api/notifications/summary" && method === "GET") {
      return json({ ok: true, unread: data.mockNotifications.filter((n) => n.read_at == null).length, latest: data.mockNotifications[0] ?? null });
    }
    if (path === "/api/notifications" && method === "GET") {
      return json({ ok: true, items: data.mockNotifications, nextBefore: null });
    }
    if (path === "/api/notifications/read-all" && method === "POST") return json({ ok: true });
    if (path.startsWith("/api/notifications/") && path.endsWith("/read") && method === "POST") return json({ ok: true });
    if (path.startsWith("/api/notifications/") && path.endsWith("/dismiss") && method === "POST") return json({ ok: true });

    if (path === "/api/activity" && method === "GET") {
      return json({ ok: true, activities: data.mockActivity, total: data.mockActivity.length, page: 1, per_page: 50, total_pages: 1 });
    }

    // ── Shares ────────────────────────────────────────────
    if (path === "/api/shares" && method === "GET") {
      return json({
        ok: true,
        links: [
          {
            link_id: "share_1",
            token: "abc123",
            expires_at: null,
            view_count: 12,
            download_count: 5,
            is_revoked: 0,
            shared_at: 1740825600,
            is_password_protected: 0,
            file_id: "file_1",
            file_name: "Project Report.pdf",
            size_bytes: 1_048_576,
            extension: "pdf",
            region: "eu-west",
            folder_name: null,
            sharer_name: "Test User",
            status: "active",
            display_name: "Project Report.pdf",
            url: "https://dosya.dev/s/abc123",
            is_mine: true,
          },
        ],
        stats: { total: 1, active: 1, expiring: 0, total_views: 12 },
      });
    }

    // ── Team / Members ────────────────────────────────────
    if (/\/(team\/members|workspaces\/[^/]+\/members)$/.test(path) && method === "GET") return json({ ok: true, members: data.mockMembers });
    if (/\/(team\/invites|workspaces\/[^/]+\/invites)$/.test(path) && method === "GET") return json({ ok: true, invites: [] });
    if (/\/(team\/invite|workspaces\/[^/]+\/invite)$/.test(path) && method === "POST") return json({ ok: true });

    // ── File Requests ─────────────────────────────────────
    if (path === "/api/file-requests" && method === "GET") return json({ ok: true, requests: data.mockFileRequests });
    if (path === "/api/file-requests" && method === "POST") return json({ ok: true, request: data.mockFileRequests[0] });

    // ── Search ────────────────────────────────────────────
    if (path === "/api/search" && method === "GET") {
      const q = url.searchParams.get("q") || "";
      const matchingFiles = q
        ? data.mockFiles
            .filter((f) => f.kind === "file" && f.name.toLowerCase().includes(q.toLowerCase()))
            .map((f) => ({ id: f.id, name: f.name, size_bytes: f.size_bytes, mime_type: f.mime_type, extension: f.extension, region: f.region, folder_id: f.folder_id, uploader_name: f.uploader_name, created_at: Date.parse(f.created_at) / 1000 }))
        : [];
      return json({ ok: true, query: q, files: matchingFiles, folders: [], shared: [], file_requests: [] });
    }

    // ── Upload ────────────────────────────────────────────
    if (path === "/api/upload/init" && method === "POST") {
      uploadInitCount++;
      return json({ ok: true, session_id: "sess_1" });
    }
    if (path.startsWith("/api/upload/") && method === "PUT") {
      setTimeout(() => json({ ok: true }), uploadDelayMs);
      return;
    }

    // ── Test-only instrumentation ───────────────────────────
    if (path === "/__test/upload-init-count" && method === "GET") {
      return json({ count: uploadInitCount });
    }
    if (path === "/__test/folders" && method === "GET") {
      return json({ folders: [...folderStore.values()] });
    }

    // ── Regions ───────────────────────────────────────────
    if (path === "/api/regions" && method === "GET") {
      return json({
        ok: true,
        regions: [
          { id: "eu-west", name: "Europe West", city: "Amsterdam", country: "Netherlands", continent: "Europe" },
          { id: "us-east", name: "US East", city: "Virginia", country: "United States", continent: "North America" },
        ],
      });
    }

    // ── Roles ─────────────────────────────────────────────
    if (/\/roles/.test(path) && method === "GET") {
      return json({
        ok: true,
        roles: [
          { id: "role_owner", name: "Owner" },
          { id: "role_admin", name: "Admin" },
          { id: "role_member", name: "Member" },
          { id: "role_viewer", name: "Viewer" },
        ],
      });
    }

    // ── Fallback ──────────────────────────────────────────
    return json({ ok: true });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
