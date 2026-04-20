import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Search,
  FileText,
  FolderOpen,
  Link2,
  Mail,
  X,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { formatBytes, formatDate, formatRelative } from "@/lib/format";
import { FileIcon, FolderIcon } from "@/components/files/FileIcon";

interface SearchResponse {
  ok: boolean;
  query: string;
  files: {
    id: string;
    name: string;
    size_bytes: number;
    mime_type: string;
    extension: string | null;
    region: string;
    folder_id: string | null;
    uploader_name: string | null;
    created_at: number;
  }[];
  folders: {
    id: string;
    name: string;
    parent_id: string | null;
    created_at: number;
    file_count: number;
  }[];
  shared: {
    link_id: string;
    token: string;
    file_name: string;
    size_bytes: number;
    extension: string | null;
    region: string;
    sharer_name: string | null;
    status: "active" | "expiring" | "expired" | "revoked";
    shared_at: number;
  }[];
  file_requests: {
    id: string;
    title: string;
    message: string | null;
    created_by_name: string | null;
    created_at: number;
  }[];
}

type Tab = "all" | "files" | "folders" | "shared" | "requests";

export function SearchPage() {
  const { active } = useWorkspace();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryParam = searchParams.get("q") || "";
  const [input, setInput] = useState(queryParam);
  const [tab, setTab] = useState<Tab>("all");

  // Sync input when navigating back
  useEffect(() => {
    setInput(queryParam);
  }, [queryParam]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["search", active?.id, queryParam],
    queryFn: () =>
      api.get<SearchResponse>(
        `/api/search?workspace_id=${active?.id}&q=${encodeURIComponent(queryParam)}`,
      ),
    enabled: !!active && !!queryParam,
  });

  const doSearch = (q: string) => {
    const trimmed = q.trim();
    if (trimmed) {
      setSearchParams({ q: trimmed });
    }
  };

  const files = data?.files ?? [];
  const folders = data?.folders ?? [];
  const shared = data?.shared ?? [];
  const requests = data?.file_requests ?? [];
  const totalResults = files.length + folders.length + shared.length + requests.length;

  const TABS: { id: Tab; label: string; count: number }[] = [
    { id: "all", label: "All", count: totalResults },
    { id: "files", label: "Files", count: files.length },
    { id: "folders", label: "Folders", count: folders.length },
    { id: "shared", label: "Shared", count: shared.length },
    { id: "requests", label: "Requests", count: requests.length },
  ];

  const showFiles = tab === "all" || tab === "files";
  const showFolders = tab === "all" || tab === "folders";
  const showShared = tab === "all" || tab === "shared";
  const showRequests = tab === "all" || tab === "requests";

  return (
    <div className="flex h-full flex-col">
      {/* Search input */}
      <div className="mb-5">
        <div className="relative max-w-xl">
          <Search
            size={18}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSearch(input)}
            placeholder="Search files, folders, shares..."
            autoFocus
            className="w-full rounded-xl border py-3 pl-11 pr-10 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
            style={{ borderColor: "var(--color-border)" }}
          />
          {input && (
            <button
              onClick={() => {
                setInput("");
                setSearchParams({});
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >
              <X size={16} />
            </button>
          )}
        </div>
        {queryParam && data && (
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            {totalResults} result{totalResults !== 1 ? "s" : ""} for "
            <span className="font-medium text-[var(--color-text)]">{queryParam}</span>"
          </p>
        )}
      </div>

      {/* Tabs */}
      {queryParam && (
        <div
          className="mb-4 flex gap-1 border-b"
          style={{ borderColor: "var(--color-border)" }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 pb-2.5 text-sm font-medium transition-colors ${
                tab === t.id
                  ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              }`}
            >
              {t.label}
              {t.count > 0 && (
                <span
                  className={`rounded-full px-1.5 text-xs ${
                    tab === t.id
                      ? "bg-[var(--color-primary)]/10"
                      : "bg-[var(--color-bg-tertiary)]"
                  }`}
                >
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {!queryParam ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Search size={40} className="mb-3 text-[var(--color-text-muted)]" />
            <p className="text-sm text-[var(--color-text-muted)]">
              Search across files, folders, shares, and file requests
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Press {navigator.platform.includes("Mac") ? "⌘K" : "Ctrl+K"} anywhere to open search
            </p>
          </div>
        ) : isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-14 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]"
              />
            ))}
          </div>
        ) : totalResults === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Search size={32} className="mb-2 text-[var(--color-text-muted)]" />
            <p className="text-sm text-[var(--color-text-muted)]">
              No results for "{queryParam}"
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Files */}
            {showFiles && files.length > 0 && (
              <ResultSection title="Files" count={files.length}>
                {files.map((f) => (
                  <div
                    key={f.id}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-4 py-2.5 transition-colors hover:bg-[var(--color-bg-secondary)]"
                  >
                    <FileIcon name={f.name} size={20} className="shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{f.name}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {formatBytes(f.size_bytes)} · {f.region}
                        {f.uploader_name && ` · by ${f.uploader_name}`}
                      </p>
                    </div>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {formatRelative(f.created_at)}
                    </span>
                  </div>
                ))}
              </ResultSection>
            )}

            {/* Folders */}
            {showFolders && folders.length > 0 && (
              <ResultSection title="Folders" count={folders.length}>
                {folders.map((f) => (
                  <div
                    key={f.id}
                    onClick={() => navigate(`/files?folder=${f.id}`)}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-4 py-2.5 transition-colors hover:bg-[var(--color-bg-secondary)]"
                  >
                    <FolderIcon fileCount={f.file_count} size={20} className="shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{f.name}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {f.file_count} file{f.file_count !== 1 ? "s" : ""}
                      </p>
                    </div>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {formatRelative(f.created_at)}
                    </span>
                  </div>
                ))}
              </ResultSection>
            )}

            {/* Shared */}
            {showShared && shared.length > 0 && (
              <ResultSection title="Shared links" count={shared.length}>
                {shared.map((s) => (
                  <div
                    key={s.link_id}
                    onClick={() => navigate("/shared")}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-4 py-2.5 transition-colors hover:bg-[var(--color-bg-secondary)]"
                  >
                    <Link2 size={18} className="shrink-0 text-[var(--color-text-muted)]" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{s.file_name}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {s.region}
                        {s.sharer_name && ` · shared by ${s.sharer_name}`}
                      </p>
                    </div>
                    <span
                      className="rounded-full px-2 py-0.5 text-xs font-medium capitalize"
                      style={{
                        color:
                          s.status === "active"
                            ? "#22c55e"
                            : s.status === "expiring"
                              ? "#f59e0b"
                              : s.status === "revoked"
                                ? "#ef4444"
                                : "#9ca3af",
                        background:
                          (s.status === "active"
                            ? "#22c55e"
                            : s.status === "expiring"
                              ? "#f59e0b"
                              : s.status === "revoked"
                                ? "#ef4444"
                                : "#9ca3af") + "15",
                      }}
                    >
                      {s.status}
                    </span>
                  </div>
                ))}
              </ResultSection>
            )}

            {/* File requests */}
            {showRequests && requests.length > 0 && (
              <ResultSection title="File requests" count={requests.length}>
                {requests.map((r) => (
                  <div
                    key={r.id}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-4 py-2.5 transition-colors hover:bg-[var(--color-bg-secondary)]"
                  >
                    <Mail size={18} className="shrink-0 text-[var(--color-text-muted)]" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{r.title}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {r.created_by_name && `by ${r.created_by_name}`}
                      </p>
                    </div>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {formatRelative(r.created_at)}
                    </span>
                  </div>
                ))}
              </ResultSection>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ResultSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 px-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          {title}
        </h3>
        <span className="rounded-full bg-[var(--color-bg-tertiary)] px-1.5 text-[10px] font-medium text-[var(--color-text-secondary)]">
          {count}
        </span>
      </div>
      <div
        className="rounded-xl border"
        style={{ borderColor: "var(--color-border)" }}
      >
        {children}
      </div>
    </div>
  );
}
