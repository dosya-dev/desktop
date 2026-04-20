import http from "http";
import * as data from "./mock-data";

export interface MockApiOptions {
  authenticated?: boolean;
}

export interface MockServer {
  url: string;
  close: () => Promise<void>;
}

/** Start a real HTTP mock server (Playwright route.fulfill doesn't set status/headers in Electron). */
export async function startMockServer(
  options: MockApiOptions = {},
): Promise<MockServer> {
  const { authenticated = true } = options;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;
    const method = req.method || "GET";

    const json = (body: unknown, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Cookie",
      });
      res.end(JSON.stringify(body));
    };

    // Handle CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Cookie",
      });
      return res.end();
    }

    // ── Auth ──────────────────────────────────────────────
    if (path === "/api/me" && method === "GET") {
      if (!authenticated) return json({ ok: false, error: "Unauthorized" }, 401);
      return json({ ok: true, user: data.mockUser });
    }
    if (path === "/api/me" && method === "PATCH") return json({ ok: true, user: data.mockUser });
    if (path === "/api/me/sessions" && method === "GET") return json({ ok: true, sessions: data.mockSessions });
    if (path === "/api/me/api-keys" && method === "GET") return json({ ok: true, keys: [] });
    if (path === "/api/me/change-password" && method === "POST") return json({ ok: true });
    if (path === "/api/me/avatar") {
      res.writeHead(200, { "Content-Type": "image/png" });
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
    if (path === "/api/workspaces" && method === "GET") return json({ ok: true, workspaces: [data.mockWorkspace] });
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
    if (path === "/api/files" && method === "GET") {
      return json({ ok: true, files: data.mockFiles, total: data.mockFiles.length, page: 1, per_page: 50, total_pages: 1 });
    }
    if ((path === "/api/files/folder" || path === "/api/folders") && method === "POST") {
      return json({ ok: true, folder: { id: "new_folder_1", name: "New Folder", kind: "folder" } });
    }
    if (/^\/api\/files\/[^/]+$/.test(path) && method === "DELETE") return json({ ok: true });
    if (/^\/api\/files\/[^/]+$/.test(path) && method === "PATCH") return json({ ok: true });
    if (/^\/api\/files\/[^/]+\/share$/.test(path) && method === "POST") return json({ ok: true, share: data.mockShareLinks[0] });

    // ── Activity ──────────────────────────────────────────
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
