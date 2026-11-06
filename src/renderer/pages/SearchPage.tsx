import { useState, useEffect, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Search,
  FileText,
  FolderOpen,
  Link2,
  Mail,
  X,
  LayoutGrid,
  LayoutList,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { useWorkspace } from "@/lib/workspace-context";
import { usePermissions } from "@/lib/use-permissions";
import { formatBytes, formatDate, formatRelative } from "@/lib/format";
import { intlLocale } from "@/lib/locale-state";
import { FileIcon, FolderIcon } from "@/components/files/FileIcon";
import { FilePreviewImage } from "@/components/files/FilePreviewImage";
import { FaceAvatar } from "@/components/personas/FaceAvatar";
import { isImage } from "@/lib/file-type";
import { useT } from "@/lib/i18n";
import { richText } from "@/lib/rich-text";
import type { MessageKey } from "../../i18n/keys";
import { useAutoDir } from "@/lib/bidi-ui";
import { CONTENT_DEBOUNCE_MS, searchContentWithRetry, type ContentHit } from "@/lib/ai-search";
import { personaHref, type PersonaCard } from "@/lib/personas";
import { usePersonasVisible } from "@/lib/use-personas-access";

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

/** AI search results: hidden = not available here (no plan, off, error). */
type ContentState = { state: "hidden" } | { state: "loading" } | { state: "busy" } | { state: "ok"; files: ContentHit[] };

/** How file results are laid out: rows, or square tiles led by the preview. */
type ViewMode = "list" | "grid";
const VIEW_STORAGE_KEY = "dosya_search_view";
function loadSavedView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "grid" ? "grid" : "list";
  } catch { return "list"; }
}

const TAB_LABELS: Record<Tab, MessageKey> = {
  all: "common.label.all",
  files: "common.label.files",
  folders: "common.label.folders",
  shared: "common.label.shared",
  requests: "search.label.requests",
};

/** A share link's status badge, keyed by the server's status value. */
const SHARE_STATUS: Record<SearchResponse["shared"][number]["status"], MessageKey> = {
  active: "shared-links.label.active",
  expiring: "shared-links.label.expiring",
  expired: "shared-links.status.expired",
  revoked: "shared-links.label.revoked",
};

/**
 * /search: the name search with content results beside it, and the People
 * this device's Personas finds by name. Ported from apps/web/src/pages/search.tsx
 * (and the web global search's People group). There is no person filter: an
 * old `person=` link is a plain search.
 */
export function SearchPage() {
  const ownDir = useAutoDir();
  const t = useT();
  const { active } = useWorkspace();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryParam = searchParams.get("q") || "";
  const [input, setInput] = useState(queryParam);
  const [tab, setTab] = useState<Tab>("all");
  const [view, setViewState] = useState<ViewMode>(loadSavedView);
  const setView = (v: ViewMode) => {
    setViewState(v);
    try { localStorage.setItem(VIEW_STORAGE_KEY, v); } catch { /* private mode: the choice lives for this page only */ }
  };

  // Sync input when navigating back
  useEffect(() => {
    setInput(queryParam);
  }, [queryParam]);

  // Live search: react to typing after a pause, not only to a secret Enter.
  useEffect(() => {
    const trimmed = input.trim();
    if (trimmed === queryParam) return;
    const timer = setTimeout(() => {
      if (trimmed) setSearchParams({ q: trimmed }, { replace: true });
      else if (queryParam) setSearchParams({}, { replace: true });
    }, 250);
    return () => clearTimeout(timer);
  }, [input, queryParam, setSearchParams]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["search", active?.id, queryParam],
    queryFn: () =>
      api.get<SearchResponse>(
        `/api/search?workspace_id=${active?.id}&q=${encodeURIComponent(queryParam)}`,
      ),
    enabled: !!active && !!queryParam,
  });

  // Content search (AI search, ported from apps/web pages/search.tsx) runs
  // beside the name search and never holds it up. It has its own debounce
  // (CONTENT_DEBOUNCE_MS after `q` settles) and its own AbortController per
  // change. Only a successful, complete answer can say "no content matches":
  // a partial one (keyword-only while paused or degraded) that found nothing
  // proves nothing, so the section is hidden. A 429 shows the busy line and
  // retries once; 402/409 (no AI search here) and anything else hide it.
  const wsId = active?.id;
  const [content, setContent] = useState<ContentState>({ state: "hidden" });
  useEffect(() => {
    const q = queryParam.trim();
    if (!wsId || q.length < 2) { setContent({ state: "hidden" }); return; }
    const ctrl = new AbortController();
    setContent({ state: "loading" });
    const timer = setTimeout(() => {
      searchContentWithRetry(wsId, q, {
        signal: ctrl.signal,
        onBusy: () => { if (!ctrl.signal.aborted) setContent({ state: "busy" }); },
      }).then((r) => {
        if (ctrl.signal.aborted) return;
        setContent(r.kind === "ok" && !(r.partial && r.files.length === 0) ? { state: "ok", files: r.files } : { state: "hidden" });
      }).catch(() => { if (!ctrl.signal.aborted) setContent({ state: "hidden" }); });
    }, CONTENT_DEBOUNCE_MS);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [wsId, queryParam]);
  const contentHits = content.state === "ok" ? content.files.length : 0;
  const contentPending = content.state === "loading" || content.state === "busy";
  const openFile = (folderId: string | null) => navigate(folderId ? `/files?folder=${folderId}` : "/files");

  // People (Personas): named people whose name starts with the typed text,
  // found by this device's engine (nothing is sent anywhere); choosing one
  // goes to their persona page. Only for a role that may see files (the
  // sidebar's gate), on the same settled query as the name search; only the
  // latest answer lands. The engine is loaded on demand, so the search page
  // does not carry it.
  const { can, permissions } = usePermissions();
  const mayAskPeople = usePersonasVisible(permissions !== undefined && can("access_files"));
  const [people, setPeople] = useState<PersonaCard[]>([]);
  const peopleSeq = useRef(0);
  useEffect(() => {
    const q = queryParam.trim();
    const seq = ++peopleSeq.current;
    setPeople([]);
    if (!wsId || !mayAskPeople || q.length < 2) return;
    void (async () => {
      try {
        const engine = (await import("@/lib/personas-device/engine-host")).personasEngine(wsId);
        const st = await engine.status();
        if (seq !== peopleSeq.current) return;
        setPeople(st.state === "ready" ? engine.findByName(q, 5).filter((p) => p.name) : []);
      } catch {
        // Off, locked, offline: no People row, nothing said.
      }
    })();
  }, [wsId, mayAskPeople, queryParam]);

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

  const TABS: { id: Tab; count: number }[] = [
    { id: "all", count: totalResults },
    { id: "files", count: files.length },
    { id: "folders", count: folders.length },
    { id: "shared", count: shared.length },
    { id: "requests", count: requests.length },
  ];

  const showFiles = tab === "all" || tab === "files";
  const showFolders = tab === "all" || tab === "folders";
  const showShared = tab === "all" || tab === "shared";
  const showRequests = tab === "all" || tab === "requests";

  return (
    <div className="flex h-full flex-col" data-testid="search-page">
      {/* Search input */}
      <div className="mb-5">
        <div className="relative max-w-xl">
          <Search
            size={18}
            className="absolute inset-s-3.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSearch(input)}
            placeholder={t("search.placeholder.searchFilesFoldersShares")}
            autoFocus
            className="w-full rounded-xl border py-3 ps-11 pe-10 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]"
            style={{ borderColor: "var(--color-border)" }}
          />
          {input && (
            <button
              onClick={() => {
                setInput("");
                setSearchParams({});
              }}
              className="absolute inset-e-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >
              <X size={16} />
            </button>
          )}
        </div>
        {queryParam && data && (
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            {richText(t, "search.description.resultForQueryParam", { totalResults }, {
              queryParam: <span className="font-medium text-[var(--color-text)]">{queryParam}</span>,
            })}
          </p>
        )}
        {queryParam && wsId && people.length > 0 && (
          <div data-people-suggestions className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="me-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{t("personas.label.people")}</span>
            {people.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => navigate(personaHref(p.id))}
                className="inline-flex items-center gap-1.5 rounded-full border bg-[var(--color-bg)] py-0.5 ps-0.5 pe-2.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]"
                style={{ borderColor: "var(--color-border)" }}
              >
                <FaceAvatar fileId={p.cover_file_id} box={p.cover_box} name={p.name} className="size-5" />
                <span className="max-w-32 truncate" dir={ownDir}>{p.name}</span>
                <span className="text-[var(--color-text-muted)]">{t("personas.action.goToPerson")}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Tabs */}
      {queryParam && (
        <div
          className="mb-4 flex gap-1 border-b"
          style={{ borderColor: "var(--color-border)" }}
        >
          {TABS.map((tb) => (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              className={`flex items-center gap-1.5 px-3 pb-2.5 text-sm font-medium transition-colors ${
                tab === tb.id
                  ? "border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              }`}
            >
              {t(TAB_LABELS[tb.id])}
              {tb.count > 0 && (
                <span
                  className={`rounded-full px-1.5 text-xs ${
                    tab === tb.id
                      ? "bg-[var(--color-primary)]/10"
                      : "bg-[var(--color-bg-tertiary)]"
                  }`}
                >
                  {tb.count}
                </span>
              )}
            </button>
          ))}
          <div
            className="mb-1.5 ms-auto flex shrink-0 self-start overflow-hidden rounded-md border"
            style={{ borderColor: "var(--color-border)" }}
            role="group"
          >
            <button
              type="button"
              onClick={() => setView("list")}
              aria-label={t("files.accessibility.listView")}
              aria-pressed={view === "list"}
              title={t("files.accessibility.listView")}
              className={`p-1.5 ${view === "list" ? "bg-[var(--color-bg-tertiary)]" : ""}`}
            >
              <LayoutList size={16} />
            </button>
            <button
              type="button"
              onClick={() => setView("grid")}
              aria-label={t("files.accessibility.gridView")}
              aria-pressed={view === "grid"}
              title={t("files.accessibility.gridView")}
              className={`p-1.5 ${view === "grid" ? "bg-[var(--color-bg-tertiary)]" : ""}`}
            >
              <LayoutGrid size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {!queryParam ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Search size={40} className="mb-3 text-[var(--color-text-muted)]" />
            <p className="text-sm text-[var(--color-text-muted)]">
              {t("search.description.searchAcrossFilesFoldersSharesAndFileRequests")}
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {navigator.platform.includes("Mac")
                ? t("search.label.pressKAnywhereToOpenSearch")
                : t("search.label.pressCtrlKAnywhereToOpenSearch")}
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
          contentHits > 0 || contentPending ? null : (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <Search size={32} className="mb-2 text-[var(--color-text-muted)]" />
              <p className="text-sm text-[var(--color-text-muted)]">
                {t("search.description.noResultsForQueryParam", { queryParam })}
              </p>
            </div>
          )
        ) : (
          <div className="space-y-6">
            {/* Files */}
            {showFiles && files.length > 0 && (
              <ResultSection title={t("common.label.files")} count={files.length}>
                <FileResults view={view}>
                  {files.map((f) => (
                    <FileResultItem
                      key={f.id}
                      view={view}
                      id={f.id}
                      name={f.name}
                      meta={f.uploader_name
                        ? t("search.description.sizebytesRegionByUploaderName", {
                            sizeBytes: formatBytes(f.size_bytes), region: f.region, uploaderName: f.uploader_name,
                          })
                        : `${formatBytes(f.size_bytes)} · ${f.region}`}
                      trailing={formatRelative(f.created_at)}
                      onOpen={() => openFile(f.folder_id)}
                    />
                  ))}
                </FileResults>
              </ResultSection>
            )}

            {/* Folders */}
            {showFolders && folders.length > 0 && (
              <ResultSection title={t("common.label.folders")} count={folders.length}>
                {folders.map((f) => (
                  <button
                    type="button"
                    key={f.id}
                    onClick={() => navigate(`/files?folder=${f.id}`)}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-2.5 text-start transition-colors hover:bg-[var(--color-bg-secondary)]"
                  >
                    <FolderIcon fileCount={f.file_count} size={20} className="shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p dir={ownDir} className="truncate text-sm font-medium" title={f.name}>{f.name}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {t("common.label.fileSentenceCase", { fileCount: f.file_count })}
                      </p>
                    </div>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {formatRelative(f.created_at)}
                    </span>
                  </button>
                ))}
              </ResultSection>
            )}

            {/* Shared */}
            {showShared && shared.length > 0 && (
              <ResultSection title={t("search.tooltip.sharedLinks")} count={shared.length}>
                {shared.map((s) => (
                  <button
                    type="button"
                    key={s.link_id}
                    onClick={() => navigate("/shared")}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-2.5 text-start transition-colors hover:bg-[var(--color-bg-secondary)]"
                  >
                    <Link2 size={18} className="shrink-0 text-[var(--color-text-muted)]" />
                    <div className="min-w-0 flex-1">
                      <p dir={ownDir} className="truncate text-sm font-medium">{s.file_name}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {s.region}
                        {s.sharer_name && ` ${t("search.description.sharedBySharerName", { sharerName: s.sharer_name })}`}
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
                      {SHARE_STATUS[s.status] ? t(SHARE_STATUS[s.status]) : s.status}
                    </span>
                  </button>
                ))}
              </ResultSection>
            )}

            {/* File requests */}
            {showRequests && requests.length > 0 && (
              <ResultSection title={t("navigation.label.fileRequests")} count={requests.length}>
                {requests.map((r) => (
                  <button
                    type="button"
                    key={r.id}
                    onClick={() => navigate("/file-requests")}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-2.5 text-start transition-colors hover:bg-[var(--color-bg-secondary)]"
                  >
                    <Mail size={18} className="shrink-0 text-[var(--color-text-muted)]" />
                    <div className="min-w-0 flex-1">
                      <p dir={ownDir} className="truncate text-sm font-medium">{r.title}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {r.created_by_name && t("search.description.byCreatedByName", { createdByName: r.created_by_name })}
                      </p>
                    </div>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {formatRelative(r.created_at)}
                    </span>
                  </button>
                ))}
              </ResultSection>
            )}
          </div>
        )}

        {queryParam && showFiles && content.state !== "hidden" && (
          <ContentResults content={content} view={view} onOpen={(f) => openFile(f.folder_id)} />
        )}
      </div>
    </div>
  );
}

/** "In file contents": the AI search hits for the query, with their loading and busy lines. */
function ContentResults({ content, view, onOpen }: { content: Exclude<ContentState, { state: "hidden" }>; view: ViewMode; onOpen: (f: ContentHit) => void }) {
  const t = useT();
  return (
    <div className="mt-6" data-content-results>
      <div className="mb-1 flex items-center gap-2 px-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          {t("search.label.inFileContents")}
        </h3>
        {content.state === "ok" && content.files.length > 0 && (
          <span className="rounded-full bg-[var(--color-bg-tertiary)] px-1.5 text-[10px] font-medium text-[var(--color-text-secondary)]">
            {content.files.length}
          </span>
        )}
      </div>
      <div className="rounded-xl border" style={{ borderColor: "var(--color-border)" }}>
        {content.state === "loading" ? (
          <p className="px-4 py-2.5 text-xs text-[var(--color-text-muted)]">{t("search.status.searchingFileContents")}</p>
        ) : content.state === "busy" ? (
          <p role="status" className="px-4 py-2.5 text-xs text-[var(--color-text-muted)]">{t("search.status.contentSearchIsBusyRetrying")}</p>
        ) : content.files.length === 0 ? (
          <p className="px-4 py-2.5 text-xs text-[var(--color-text-muted)]">{t("search.label.noContentMatches")}</p>
        ) : (
          <FileResults view={view}>
            {content.files.map((f) => (
              <FileResultItem
                key={f.id}
                view={view}
                id={f.id}
                name={f.name}
                testId="content-hit"
                // An image's "text" is the vision model's description or OCR
                // attempt ("No text is present in the image"), which is index
                // material, not something to read under a photo. Documents
                // keep their snippet: it says where the match is.
                snippet={isImageHit(f) ? null : (
                  f.snippet ? (
                    <>
                      {f.snippet}
                      {f.page != null && (
                        <span className="ms-1 whitespace-nowrap">· {t("search.label.pagePage", { page: f.page.toLocaleString(intlLocale("en")) })}</span>
                      )}
                    </>
                  ) : null
                )}
                onOpen={() => onOpen(f)}
              />
            ))}
          </FileResults>
        )}
      </div>
    </div>
  );
}

/** The indexer decides "image" by MIME type; the name's extension is the fallback. */
function isImageHit(f: ContentHit): boolean {
  return (f.mime_type ?? "").startsWith("image/") || isImage(f.name);
}

/** Rows stack; tiles flow into a responsive square grid inside the section box. */
function FileResults({ view, children }: { view: ViewMode; children: React.ReactNode }) {
  return view === "grid"
    ? <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3 p-3" data-view="grid">{children}</div>
    : <div data-view="list">{children}</div>;
}

/**
 * One file result, as a row (preview, name, one line under it, a trailing
 * note) or as a tile (square preview, name, the same line clamped under it).
 * Both forms share the preview so the thumbnail chain (server thumb, retry,
 * raw, HEIC decode) is the same whichever the user picked.
 */
function FileResultItem({ view, id, name, meta, trailing, snippet, testId, onOpen }: {
  view: ViewMode; id: string; name: string; meta?: string; trailing?: React.ReactNode; snippet?: React.ReactNode; testId?: string; onOpen: () => void;
}) {
  const ownDir = useAutoDir();
  if (view === "grid") {
    return (
      <button
        type="button"
        onClick={onOpen}
        data-testid={testId ?? "file-tile"}
        className="flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-xl p-1.5 text-start transition-colors hover:bg-[var(--color-bg-secondary)]"
      >
        <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg bg-[var(--color-bg-tertiary)]">
          <FilePreviewImage
            fileId={id}
            fileName={name}
            size={256}
            className="h-full w-full object-cover"
            fallback={<FileIcon name={name} size={40} className="shrink-0" />}
          />
        </div>
        <p dir={ownDir} className="w-full truncate px-0.5 text-xs font-medium" title={name}>{name}</p>
        {meta && <p className="w-full truncate px-0.5 text-xs text-[var(--color-text-muted)]">{meta}</p>}
        {trailing && <p className="w-full truncate px-0.5 text-xs text-[var(--color-text-muted)]">{trailing}</p>}
        {snippet && <p dir={ownDir} className="line-clamp-2 w-full px-0.5 text-xs text-[var(--color-text-muted)]">{snippet}</p>}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={testId ?? "file-row"}
      className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-2.5 text-start transition-colors hover:bg-[var(--color-bg-secondary)]"
    >
      <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--color-bg-tertiary)]">
        <FilePreviewImage
          fileId={id}
          fileName={name}
          size={128}
          className="h-full w-full object-cover"
          fallback={<FileIcon name={name} size={20} className="shrink-0" />}
        />
      </div>
      <div className="min-w-0 flex-1">
        <p dir={ownDir} className="truncate text-sm font-medium" title={name}>{name}</p>
        {meta && <p className="text-xs text-[var(--color-text-muted)]">{meta}</p>}
        {snippet && <p dir={ownDir} className="line-clamp-2 text-xs text-[var(--color-text-muted)]">{snippet}</p>}
      </div>
      {trailing && <span className="text-xs text-[var(--color-text-muted)]">{trailing}</span>}
    </button>
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
