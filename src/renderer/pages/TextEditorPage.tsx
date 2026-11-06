/**
 * The Markdown and plain-text editor: a full-window page for .md, .markdown
 * and .txt files (design option B, "Split with live preview").
 *
 * Its own route, /text-editor/:fileId, beside the ONLYOFFICE editor at
 * /editor/:fileId, which stays as it is for Office documents. Like that page
 * it renders without the app shell and owns the title-bar strip itself.
 *
 * Saving is explicit (⌘S / Ctrl+S or the Save button) because every save is
 * a new version of the file; between saves the text is kept as a local draft
 * (lib/text-drafts.ts) so a crash loses nothing. Before saving, the file is
 * asked whether it moved on since it was opened, and if it did the user picks
 * Save as copy or Overwrite.
 *
 * Leaving with unsaved changes asks first. React Router's useBlocker needs a
 * data router and the app uses <HashRouter>, so the page installs a guard in
 * lib/nav-guard.ts that every app-level way out consults (menu Back/Forward
 * and Go, Cmd+[ / Cmd+], mouse side buttons, swipes, tray and dosya://
 * links, Sign out), and its own close paths ask directly. Closing the window
 * itself is not intercepted: it only hides to the tray and the text stays.
 * Quitting the app does lose it, so the page tells main whether it has
 * unsaved changes and main holds a quit (Cmd+Q, menu or tray Quit, Restart
 * and install) until this page has asked (src/main/quit-guard.ts).
 *
 * ⌘F / Ctrl+F opens CodeMirror's find and replace bar from anywhere on the
 * page, as does Edit > Find; Escape closes the bar before it means "leave".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bold, Code, Heading, Italic, Link2, List, ListOrdered, ListTodo, Quote, X,
} from "lucide-react";
import { toast } from "sonner";
import { autoDir, useAutoDir } from "@/lib/bidi-ui";
import { api, ApiError } from "@/lib/api-client";
import { fileRawUrl } from "@/lib/file-url";
import { formatRelative } from "@/lib/format";
import { tPlain, useT } from "@/lib/i18n";
import { looksBinary } from "@/lib/text-detect";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { uploadFileInParts } from "@/lib/upload-in-parts";
import { uploadTransport } from "@/lib/upload-transport";
import { LIBRARY_QUERY_ROOT } from "@/lib/library-request";
import { nameTakenInFolder } from "@/lib/blank-files";
import { isSimple, useMenuActions } from "@/lib/menu-bus";
import { setNavGuard } from "@/lib/nav-guard";
import type { MdFormat } from "@/lib/md-format";
import {
  TEXT_EDIT_MAX_BYTES, changedSince, countWords, pickCopyName, textEditorKind, type FileStamp,
} from "@/lib/text-edit";
import { clearDrafts, draftToOffer, saveDraft, type Draft, type DraftStorage } from "@/lib/text-drafts";
import { CodeEditor, type EditorHandle } from "@/components/text-editor/CodeEditor";
import { MarkdownPreview } from "@/components/text-editor/MarkdownPreview";
import { ConfirmDialog } from "@/components/text-editor/ConfirmDialog";

interface EditorFile {
  id: string;
  name: string;
  size_bytes: number;
  mime_type: string;
  lock_mode: string;
  current_version?: number;
  updated_at: number;
  workspace_id: string;
  folder_id: string | null;
}

type ViewMode = "split" | "edit" | "preview";

/** Below this the two panes are too narrow to read; Split falls back to Edit/Preview. */
const NARROW_QUERY = "(max-width: 899px)";
const PREVIEW_DEBOUNCE_MS = 150;
const DRAFT_DEBOUNCE_MS = 400;

const IS_MAC = typeof document !== "undefined"
  && (document.documentElement.dataset.platform === "darwin" || /Mac/i.test(navigator.platform));
const MOD = IS_MAC ? "⌘" : "Ctrl+";

function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function draftStorage(): DraftStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function errorText(err: unknown): string | undefined {
  return err instanceof Error && err.message ? err.message : undefined;
}

// ── Route ────────────────────────────────────────────────

export function TextEditorPage() {
  const { fileId = "" } = useParams();
  // Keyed: "Save as copy" moves to the copy's route, and that is a new file.
  return <TextEditorLoader key={fileId} fileId={fileId} />;
}

type Load =
  | { state: "loading" }
  | { state: "error"; message: string; raw?: boolean; file?: EditorFile }
  | { state: "ready"; file: EditorFile; text: string };

function TextEditorLoader({ fileId }: { fileId: string }) {
  const ownDir = useAutoDir();
  const t = useT();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [folderName, setFolderName] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoad({ state: "loading" });
    (async () => {
      let file: EditorFile | undefined;
      try {
        const res = await api.get<{ ok: boolean; file?: EditorFile; error?: string }>(`/api/files/${fileId}`);
        if (!res.ok || !res.file) throw new Error(res.error || t("common.error.failedToLoadFileContent"));
        file = res.file;
        if (cancelled) return;
        // Same gates as the entry points (canEditText), asked again here
        // because a route can be reached from a stale list or a deep link.
        if (!textEditorKind(file.name)) throw new Error(t("editor.error.thisFileCannotBeEditedHere"));
        if (file.lock_mode === "full_lock") throw new Error(t("file-security.label.lockedWithAPassword"));
        if (file.size_bytes > TEXT_EDIT_MAX_BYTES) throw new Error(t("editor.error.filesOver2MBCanBeViewedButNotEdited"));
        // no-cache: /raw is cached for an hour, and editing a stale copy would
        // save it over the newer version. This revalidates (a 304 is cheap).
        const raw = await fetch(fileRawUrl({ fileId: file.id }), { credentials: "include", cache: "no-cache" });
        if (!raw.ok) throw new Error(t("common.error.failedToLoadFileContent"));
        const text = await raw.text();
        if (looksBinary(text.slice(0, 8192))) throw new Error(t("common.error.thisFileIsNotTextPreviewable"));
        if (!cancelled) setLoad({ state: "ready", file, text });
      } catch (err) {
        if (!cancelled) setLoad({ state: "error", message: errorText(err) ?? t("common.error.failedToLoadFileContent"), raw: err instanceof ApiError, file });
      }
    })();
    return () => { cancelled = true; };
  }, [fileId, attempt, t]);

  // The folder's name for the breadcrumb: the listing answers with its trail.
  const folderId = load.state === "ready" ? load.file.folder_id : null;
  const workspaceId = load.state === "ready" ? load.file.workspace_id : null;
  useEffect(() => {
    if (!folderId || !workspaceId) return;
    let cancelled = false;
    const params = new URLSearchParams({ workspace_id: workspaceId, folder_id: folderId, per_page: "1" });
    api.get<{ breadcrumbs?: { id: string; name: string }[] }>(`/api/files?${params}`)
      .then((res) => {
        const last = res.breadcrumbs?.[res.breadcrumbs.length - 1];
        if (!cancelled && last) setFolderName(last.name);
      })
      .catch(() => { /* the breadcrumb simply stays shorter */ });
    return () => { cancelled = true; };
  }, [folderId, workspaceId]);

  if (load.state === "ready") {
    return <TextEditor file={load.file} initialText={load.text} folderName={folderName} />;
  }
  return (
    <EditorShell name={load.state === "error" ? load.file?.name ?? null : null} folderId={load.state === "error" ? load.file?.folder_id ?? null : null}>
      {load.state === "loading" ? (
        <p className="text-sm text-[var(--color-text-muted)]">{t("editor.status.loadingEditor")}</p>
      ) : (
        <div className="max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-8 text-center">
          <p dir={load.raw ? ownDir : undefined} className="mb-4 text-sm text-[var(--color-text-secondary)]">{load.message}</p>
          <button
            type="button"
            onClick={() => setAttempt((a) => a + 1)}
            className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
          >
            {t("common.action.tryAgain")}
          </button>
        </div>
      )}
    </EditorShell>
  );
}

/** Header and empty body for the loading and error states. */
function EditorShell({ name, folderId, children }: { name: string | null; folderId: string | null; children: React.ReactNode }) {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const close = () => ((location.state as { back?: boolean } | null)?.back
    ? navigate(-1)
    : navigate(folderId ? `/files?folder=${encodeURIComponent(folderId)}` : "/files"));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div className="flex h-screen flex-col bg-[var(--color-bg)]" data-testid="text-editor-page">
      <header className="titlebar-inset titlebar-drag flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-2.5">
        <div className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-muted)]">
          {t("common.label.files")}
          {name && <> / <span className="font-mono font-semibold text-[var(--color-text)]">{name}</span></>}
        </div>
        <button
          type="button"
          onClick={close}
          aria-label={t("common.close")}
          title={t("common.tooltip.closeEsc")}
          className="titlebar-no-drag flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-primary)]"
        >
          <X size={16} />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">{children}</div>
    </div>
  );
}

// ── Editor ───────────────────────────────────────────────

const TOOLS: ({ kind: MdFormat; icon: typeof Bold; label: Parameters<ReturnType<typeof useT>>[0]; key?: string } | "sep")[] = [
  { kind: "bold", icon: Bold, label: "editor.tooltip.bold", key: "B" },
  { kind: "italic", icon: Italic, label: "editor.tooltip.italic", key: "I" },
  { kind: "heading", icon: Heading, label: "editor.tooltip.heading" },
  "sep",
  { kind: "bullet", icon: List, label: "editor.tooltip.bulletList" },
  { kind: "numbered", icon: ListOrdered, label: "editor.tooltip.numberedList" },
  { kind: "task", icon: ListTodo, label: "editor.tooltip.taskList" },
  "sep",
  { kind: "link", icon: Link2, label: "editor.tooltip.link", key: "K" },
  { kind: "code", icon: Code, label: "editor.tooltip.code" },
  { kind: "quote", icon: Quote, label: "editor.tooltip.quote" },
];

function TextEditor({ file, initialText, folderName }: { file: EditorFile; initialText: string; folderName: string | null }) {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const isMarkdown = textEditorKind(file.name) === "markdown";
  const mimeType = file.mime_type || (isMarkdown ? "text/markdown" : "text/plain");
  const filesHref = file.folder_id ? `/files?folder=${encodeURIComponent(file.folder_id)}` : "/files";

  const editorRef = useRef<EditorHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const [text, setText] = useState(initialText);
  const [savedText, setSavedText] = useState(initialText);
  const dirty = text !== savedText;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // What the open text was based on; the conflict check compares against it.
  const stampRef = useRef<FileStamp>({ current_version: file.current_version, updated_at: file.updated_at });
  const [lastSaved, setLastSaved] = useState({ version: file.current_version ?? null, atSec: file.updated_at });
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [conflict, setConflict] = useState<{ detail: string | null } | null>(null);
  const [leave, setLeave] = useState<{ go: () => void } | null>(null);
  const [quitAsk, setQuitAsk] = useState(false);
  const dialogOpenRef = useRef(false);
  dialogOpenRef.current = conflict !== null || leave !== null || quitAsk;

  // CodeMirror's find bar labels, keyed by the English names it uses.
  const searchPhrases = useMemo(() => ({
    Find: t("common.placeholder.find"),
    Replace: t("editor.placeholder.replace"),
    next: t("editor.action.findNext"),
    previous: t("editor.action.findPrevious"),
    all: t("editor.action.selectAllMatches"),
    "match case": t("editor.label.matchCase"),
    regexp: t("editor.label.regularExpression"),
    "by word": t("editor.label.wholeWord"),
    replace: t("editor.action.replace"),
    "replace all": t("editor.action.replaceAll"),
    close: t("editor.accessibility.closeFind"),
  }), [t]);

  const draftFile = useMemo(() => ({ workspaceId: file.workspace_id, fileId: file.id }), [file.workspace_id, file.id]);
  const draftRef = useCallback(
    () => ({ ...draftFile, version: stampRef.current.current_version ?? 0 }),
    [draftFile],
  );
  const [offeredDraft, setOfferedDraft] = useState<Draft | null>(() => {
    const s = draftStorage();
    return s ? draftToOffer(s, { ...draftFile, version: file.current_version ?? 0 }, { text: initialText, updatedAtSec: file.updated_at }) : null;
  });

  const [view, setView] = useState<ViewMode>("split");
  const narrow = useMediaQuery(NARROW_QUERY);
  const effectiveView: ViewMode = !isMarkdown ? "edit" : narrow && view === "split" ? "edit" : view;

  const debouncedText = useDebouncedValue(text, PREVIEW_DEBOUNCE_MS);
  const words = useMemo(() => countWords(debouncedText), [debouncedText]);

  // "saved 2m ago" has to keep moving while the page stays open.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // ── Drafts ───────────────────────────────────────────

  useEffect(() => {
    if (!dirty) return;
    const id = window.setTimeout(() => {
      const s = draftStorage();
      if (s) saveDraft(s, draftRef(), text, Date.now());
    }, DRAFT_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [text, dirty, draftRef]);

  const dropDrafts = useCallback(() => {
    const s = draftStorage();
    if (s) clearDrafts(s, draftFile);
  }, [draftFile]);

  // ── Leaving ──────────────────────────────────────────

  const requestLeave = useCallback((go: () => void) => {
    if (dirtyRef.current) setLeave({ go });
    else go();
  }, []);

  useEffect(() => {
    if (!dirty) return;
    return setNavGuard((proceed) => {
      setLeave({ go: proceed });
      return true;
    });
  }, [dirty]);

  // Quitting the app (not closing the window) would lose the changes: main
  // holds the quit while this says dirty, and asks here first.
  useEffect(() => {
    window.electronAPI?.setEditorDirty?.(dirty);
  }, [dirty]);
  useEffect(() => () => window.electronAPI?.setEditorDirty?.(false), []);
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onQuitConfirmRequested) return;
    return api.onQuitConfirmRequested(() => {
      if (!dirtyRef.current) {
        api.answerQuitConfirm("quit");
        return;
      }
      setLeave(null);
      setConflict(null);
      setQuitAsk(true);
      api.answerQuitConfirm("shown");
    });
  }, []);
  const answerQuit = (answer: "quit" | "cancel") => {
    setQuitAsk(false);
    window.electronAPI?.answerQuitConfirm?.(answer);
  };

  const close = useCallback(() => {
    requestLeave(() => ((location.state as { back?: boolean } | null)?.back ? navigate(-1) : navigate(filesHref)));
  }, [requestLeave, location.state, navigate, filesHref]);

  const openVersions = () => {
    const params = new URLSearchParams();
    if (file.folder_id) params.set("folder", file.folder_id);
    params.set("panel", file.id);
    params.set("versions", "1");
    requestLeave(() => navigate(`/files?${params}`));
  };

  // ── Saving ───────────────────────────────────────────

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["files"] });
    void queryClient.invalidateQueries({ queryKey: [LIBRARY_QUERY_ROOT] });
  }, [queryClient]);

  const save = useCallback(async (force = false) => {
    if (savingRef.current) return;
    const content = editorRef.current?.getText() ?? text;
    savingRef.current = true;
    setSaving(true);
    try {
      if (!force) {
        const latest = await api.get<{ ok: boolean; file?: EditorFile }>(`/api/files/${file.id}`);
        if (latest.ok && latest.file && changedSince(stampRef.current, latest.file)) {
          // Who and when, if the version list answers; the dialog works without it.
          let detail: string | null = null;
          try {
            const v = await api.get<{ versions?: { version_number: number; uploader_name: string | null; created_at: number }[] }>(`/api/files/${file.id}/versions`);
            const top = v.versions?.[0];
            if (top) {
              detail = t("editor.description.nameSavedVersionWhen", {
                hasName: top.uploader_name ? "yes" : "no",
                name: top.uploader_name ?? "",
                version: top.version_number,
                when: formatRelative(top.created_at),
              });
            }
          } catch { /* detail stays out */ }
          setConflict({ detail });
          return;
        }
      }
      const out = await uploadFileInParts(
        {
          file: new Blob([content], { type: mimeType }),
          fileName: file.name,
          mimeType,
          workspaceId: file.workspace_id,
          fileId: file.id,
        },
        uploadTransport,
      );
      const nowSec = Math.floor(Date.now() / 1000);
      const version = typeof out.version === "number" ? out.version : null;
      stampRef.current = { current_version: version ?? undefined, updated_at: nowSec };
      setLastSaved({ version, atSec: nowSec });
      setSavedText(content);
      dropDrafts();
      setOfferedDraft(null);
      invalidate();
      toast.success(t("editor.status.savedAsANewVersion"));
    } catch (err) {
      toast.error(t("common.error.couldNotSaveThisFile"), { description: err instanceof ApiError && err.message ? autoDir(err.message) : errorText(err) });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [file.id, file.name, file.workspace_id, mimeType, text, t, dropDrafts, invalidate]);

  const saveAsCopy = useCallback(async () => {
    setConflict(null);
    if (savingRef.current) return;
    const content = editorRef.current?.getText() ?? text;
    savingRef.current = true;
    setSaving(true);
    try {
      const name = await pickCopyName(
        file.name,
        (candidate) => nameTakenInFolder(api.get, file.workspace_id, file.folder_id, candidate),
        // A file name is data: never the isolating translator.
        (base, n) => tPlain("editor.label.copyName", { name: base, count: n }),
      );
      const out = await uploadFileInParts(
        {
          file: new Blob([content], { type: mimeType }),
          fileName: name,
          mimeType,
          workspaceId: file.workspace_id,
          folderId: file.folder_id ?? null,
        },
        uploadTransport,
      );
      // The edit now lives in the copy; this file's draft is done with.
      dropDrafts();
      setSavedText(content);
      dirtyRef.current = false;
      invalidate();
      toast.success(t("files.status.createdName", { name }));
      if (out.fileId) navigate(`/text-editor/${out.fileId}`, { replace: true, state: location.state });
    } catch (err) {
      toast.error(t("common.error.couldNotSaveThisFile"), { description: err instanceof ApiError && err.message ? autoDir(err.message) : errorText(err) });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [file.name, file.workspace_id, file.folder_id, mimeType, text, t, dropDrafts, invalidate, navigate, location.state]);

  // ── Find ─────────────────────────────────────────────

  // The find bar lives in the source pane; Preview alone hides that pane, so
  // asking for find there brings the source back first, then opens the bar.
  const [findRequest, setFindRequest] = useState<{ replace: boolean } | null>(null);
  const openFind = useCallback((replace = false) => {
    if (dialogOpenRef.current) return;
    setFindRequest({ replace });
    setView((v) => (v === "preview" ? (narrow ? "edit" : "split") : v));
  }, [narrow]);
  useEffect(() => {
    if (!findRequest || effectiveView === "preview") return;
    editorRef.current?.openSearch({ replace: findRequest.replace });
    setFindRequest(null);
  }, [findRequest, effectiveView]);

  // ── Keys ─────────────────────────────────────────────

  // ⌘S / Ctrl+S, ⌘F / Ctrl+F and Escape, heard first (capture) wherever focus
  // is, so the save never reaches anything else and find opens from the
  // toolbar or the preview too. Dialogs own Escape while they are open.
  const latest = useRef({ save, close, openFind });
  latest.current = { save, close, openFind };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        if (!dialogOpenRef.current) void latest.current.save();
        return;
      }
      // Option+F types "ƒ" on a Mac, so the replace chord is matched by code.
      if (mod && !e.shiftKey && (e.key.toLowerCase() === "f" || (e.altKey && e.code === "KeyF"))) {
        e.preventDefault();
        e.stopPropagation();
        latest.current.openFind(e.altKey);
        return;
      }
      if (e.key === "Escape" && !dialogOpenRef.current) {
        e.preventDefault();
        // An open find bar takes Escape first; leaving is the next press.
        if (editorRef.current?.closeSearch()) {
          e.stopPropagation();
          return;
        }
        latest.current.close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Everything typed in here stays here: no document-level shortcut handler
  // (select all, delete, ...) may act on a keystroke meant for the text.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const stop = (e: KeyboardEvent) => e.stopPropagation();
    el.addEventListener("keydown", stop);
    return () => el.removeEventListener("keydown", stop);
  }, []);

  // Edit > Find (⌘F) is a menu accelerator, and on macOS the accelerator wins:
  // the key arrives here as the menu action, never as a keydown. Either way it
  // opens this document's find bar, not the app-wide search.
  useMenuActions((action) => {
    if (!isSimple(action, "find")) return false;
    openFind();
    return true;
  });

  // ── Scroll sync (proportional) ───────────────────────

  useEffect(() => {
    if (effectiveView !== "split") return;
    const ed = editorRef.current?.scroller();
    const pv = previewRef.current;
    if (!ed || !pv) return;
    let driver: "editor" | "preview" = "editor";
    const follow = (from: HTMLElement, to: HTMLElement) => {
      const max = from.scrollHeight - from.clientHeight;
      const ratio = max > 0 ? from.scrollTop / max : 0;
      to.scrollTop = ratio * Math.max(0, to.scrollHeight - to.clientHeight);
    };
    const onEditorScroll = () => { if (driver === "editor") follow(ed, pv); };
    const onPreviewScroll = () => { if (driver === "preview") follow(pv, ed); };
    const driveEditor = () => { driver = "editor"; };
    const drivePreview = () => { driver = "preview"; };
    ed.addEventListener("scroll", onEditorScroll, { passive: true });
    pv.addEventListener("scroll", onPreviewScroll, { passive: true });
    for (const ev of ["wheel", "pointerdown", "keydown"] as const) ed.addEventListener(ev, driveEditor, { passive: true });
    for (const ev of ["wheel", "pointerdown"] as const) pv.addEventListener(ev, drivePreview, { passive: true });
    return () => {
      ed.removeEventListener("scroll", onEditorScroll);
      pv.removeEventListener("scroll", onPreviewScroll);
      for (const ev of ["wheel", "pointerdown", "keydown"] as const) ed.removeEventListener(ev, driveEditor);
      for (const ev of ["wheel", "pointerdown"] as const) pv.removeEventListener(ev, drivePreview);
    };
  }, [effectiveView]);

  // ── Render ───────────────────────────────────────────

  const viewOptions: ViewMode[] = narrow ? ["edit", "preview"] : ["split", "edit", "preview"];
  const viewLabel = (v: ViewMode) => (v === "split" ? t("editor.label.split") : v === "edit" ? t("files.edit") : t("editor.label.preview"));
  const savedInfo = lastSaved.version != null
    ? t("editor.status.versionSavedWhen", { version: lastSaved.version, when: formatRelative(lastSaved.atSec) })
    : null;

  const ghost = "flex items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-primary)]";

  return (
    <>
      <div ref={rootRef} className="flex h-screen flex-col bg-[var(--color-bg)]" data-testid="text-editor-page">
        {/* Covers the title bar, so it is the drag region and keeps clear of
            the traffic lights (macOS) and caption buttons (Windows); every
            control opts out of the drag or its clicks would be swallowed. */}
        <header className="titlebar-inset titlebar-drag flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-2.5">
          <nav aria-label={t("editor.accessibility.location")} data-testid="editor-breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
            <button type="button" onClick={() => requestLeave(() => navigate("/files"))} className="titlebar-no-drag shrink-0 rounded hover:text-[var(--color-text)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-primary)]">
              {t("common.label.files")}
            </button>
            {folderName && (
              <>
                <span aria-hidden>/</span>
                <button type="button" onClick={() => requestLeave(() => navigate(filesHref))} className="titlebar-no-drag min-w-0 truncate rounded hover:text-[var(--color-text)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-primary)]">
                  {folderName}
                </button>
              </>
            )}
            <span aria-hidden>/</span>
            <span className="min-w-0 truncate font-mono font-semibold text-[var(--color-text)]" aria-current="page">{file.name}</span>
            {dirty && (
              <span
                data-testid="unsaved-dot"
                role="img"
                aria-label={t("editor.status.unsavedChanges")}
                title={t("editor.status.unsavedChanges")}
                className="h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--color-warning)]"
              />
            )}
          </nav>
          <div className="titlebar-no-drag flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={openVersions}
              className="flex h-7 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] focus:outline-none focus-visible:border-[var(--color-primary)] focus-visible:ring-1 focus-visible:ring-[var(--color-primary)]"
            >
              {t("files.label.versionHistory")}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              aria-label={saving ? t("editor.status.saving") : t("common.save")}
              aria-keyshortcuts={IS_MAC ? "Meta+S" : "Control+S"}
              className="flex h-7 items-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-2.5 text-xs font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 disabled:opacity-50"
            >
              {saving ? t("editor.status.saving") : t("common.save")}
              <kbd aria-hidden className="font-mono text-[10px] font-normal opacity-70">{IS_MAC ? "⌘S" : "Ctrl+S"}</kbd>
            </button>
            <button type="button" onClick={close} aria-label={t("common.close")} title={t("common.tooltip.closeEsc")} className={`h-7 w-7 ${ghost}`}>
              <X size={15} />
            </button>
          </div>
        </header>

        {isMarkdown && (
          <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-[var(--color-border)] px-2">
            <div role="toolbar" aria-label={t("editor.accessibility.formatting")} className="flex items-center gap-0.5">
              {TOOLS.map((tool, i) => {
                if (tool === "sep") return <span key={`sep${i}`} aria-hidden className="mx-1.5 h-4 w-px bg-[var(--color-border)]" />;
                const Icon = tool.icon;
                const label = t(tool.label);
                const name = tool.key ? `${label} (${MOD}${tool.key})` : label;
                return (
                  <button
                    key={tool.kind}
                    type="button"
                    aria-label={name}
                    title={name}
                    aria-keyshortcuts={tool.key ? `${IS_MAC ? "Meta" : "Control"}+${tool.key}` : undefined}
                    // Keep the editor's selection: a click must not move focus.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => editorRef.current?.format(tool.kind)}
                    disabled={effectiveView === "preview"}
                    className={`h-[26px] w-[30px] disabled:opacity-40 ${ghost}`}
                  >
                    <Icon size={15} strokeWidth={2} />
                  </button>
                );
              })}
            </div>
            <div className="flex-1" />
            <div role="group" aria-label={t("editor.accessibility.layout")} className="inline-flex overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
              {viewOptions.map((v) => {
                const pressed = effectiveView === v;
                return (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => setView(v)}
                    className={`px-3 py-1 text-xs font-medium focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)] ${pressed ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text)]" : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"}`}
                  >
                    {viewLabel(v)}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {offeredDraft && (
          <div role="status" className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-2 text-sm text-[var(--color-text)]">
            <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--color-warning)]" aria-hidden />
            <span className="min-w-0 flex-1">{t("editor.status.youHaveUnsavedChangesFromEarlier")}</span>
            <button
              type="button"
              onClick={() => { editorRef.current?.setText(offeredDraft.text); setOfferedDraft(null); editorRef.current?.focus(); }}
              className="rounded-lg bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
            >
              {t("files.action.restore")}
            </button>
            <button
              type="button"
              onClick={() => { dropDrafts(); setOfferedDraft(null); }}
              className="rounded-lg border border-[var(--color-border)] px-3 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] focus:outline-none focus-visible:border-[var(--color-primary)] focus-visible:ring-1 focus-visible:ring-[var(--color-primary)]"
            >
              {t("editor.action.discard")}
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* Hidden, never unmounted: CodeMirror holds the text and its undo history. */}
          <div
            data-testid="source-pane"
            className={
              effectiveView === "preview" ? "hidden"
                : effectiveView === "split" ? "min-w-0 flex-1 basis-1/2 border-e border-[var(--color-border)]"
                  : "min-w-0 flex-1"
            }
          >
            <CodeEditor
              ref={editorRef}
              initialText={initialText}
              markdown={isMarkdown}
              label={file.name}
              phrases={searchPhrases}
              onChange={setText}
              onCursor={setCursor}
            />
          </div>
          {isMarkdown && effectiveView !== "edit" && (
            <div className="min-w-0 flex-1 basis-1/2">
              <MarkdownPreview ref={previewRef} text={debouncedText} label={t("editor.label.preview")} />
            </div>
          )}
        </div>

        <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-[var(--color-border)] px-3 font-mono text-[11px] tabular-nums text-[var(--color-text-muted)]">
          <span>{isMarkdown ? t("common.label.markdown") : t("editor.label.plainText")}</span>
          <span>{t("editor.status.wordCount", { count: words })}</span>
          <span>{t("editor.status.lineColumn", { line: cursor.line, column: cursor.col })}</span>
          <span className="flex-1" />
          {dirty && <span>{t("editor.status.unsavedChanges")}</span>}
          {savedInfo && <span className="text-[var(--color-primary)]">{savedInfo}</span>}
        </footer>
      </div>

      {conflict && (
        <ConfirmDialog
          id="conflict-dialog"
          title={t("common.heading.areYouSure")}
          description={t("editor.description.thisFileChangedSinceYouOpenedIt")}
          detail={conflict.detail}
          onCancel={() => setConflict(null)}
          actions={[
            { label: t("common.cancel"), onClick: () => setConflict(null) },
            { label: t("editor.action.overwrite"), onClick: () => { setConflict(null); void save(true); } },
            { label: t("editor.action.saveAsCopy"), onClick: () => void saveAsCopy(), tone: "primary", autoFocus: true },
          ]}
        />
      )}
      {quitAsk && (
        <ConfirmDialog
          id="quit-dialog"
          title={t("common.heading.areYouSure")}
          description={t("editor.description.youHaveUnsavedChangesInNameTheyWillBeLostIfYouQuit", { name: file.name })}
          onCancel={() => answerQuit("cancel")}
          actions={[
            { label: t("editor.action.keepEditing"), onClick: () => answerQuit("cancel"), autoFocus: true },
            { label: t("editor.action.quitAnyway"), tone: "danger", onClick: () => answerQuit("quit") },
          ]}
        />
      )}
      {leave && (
        <ConfirmDialog
          id="leave-dialog"
          title={t("common.heading.areYouSure")}
          description={t("editor.description.youHaveUnsavedChangesTheyWillBeLost")}
          onCancel={() => setLeave(null)}
          actions={[
            { label: t("editor.action.keepEditing"), onClick: () => setLeave(null), autoFocus: true },
            {
              label: t("editor.action.discardChanges"),
              tone: "danger",
              onClick: () => {
                const go = leave.go;
                dropDrafts();
                setLeave(null);
                go();
              },
            },
          ]}
        />
      )}
    </>
  );
}

