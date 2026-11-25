/**
 * The ONLYOFFICE editor, ported from apps/web/src/pages/editor.tsx.
 *
 * The whole server side already existed - /api/files/:id/editor-config mints the
 * signed config and an opaque download token - so this is a front end and
 * nothing more.
 *
 * It needs the document server named in the renderer's CSP: api.js is loaded
 * from there and the editor then iframes it. See src/main/session.ts, where
 * script-src names docsBase's api.js file and frame-src docsBase. Without
 * that the script is blocked silently and the page simply never becomes an
 * editor.
 *
 * api.js runs in THIS document, the one that holds window.electronAPI, so it
 * is pinned with SRI: the integrity value comes from the API
 * (documentServerApiIntegrity, the api Worker's ONLYOFFICE_API_JS_SRI var, so
 * a Document Server upgrade needs no desktop release), the script is fetched
 * in CORS mode, and with no value the editor refuses to load at all.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Eye } from 'lucide-react';
import { api, ApiError } from "@/lib/api-client";
import { t as translate, useT } from "@/lib/i18n";
import { useAutoDir } from "@/lib/bidi-ui";

interface EditorConfigResponse {
  ok: boolean;
  documentServerUrl: string;
  /** SRI for api.js. Missing or malformed = the editor stays shut (fail closed). */
  documentServerApiIntegrity?: string;
  config: {
    documentType: string;
    type: string;
    document: {
      fileType: string;
      key: string;
      title: string;
      url: string;
      permissions: { edit: boolean };
    };
    editorConfig: { mode: 'edit' | 'view'; callbackUrl?: string };
    token: string;
  };
}

declare global {
  interface Window {
    DocsAPI?: {
      DocEditor: new (elementId: string, config: unknown) => { destroyEditor?: () => void };
    };
  }
}

const SCRIPT_ID = 'onlyoffice-docsapi';

/** One or more space-separated SRI hashes (two during a Document Server upgrade). */
function isSriValue(value: string): boolean {
  return value.length > 0 && value.split(/\s+/).every((h) => /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(h));
}

function loadDocsApi(serverUrl: string, integrity: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const sri = (integrity ?? '').trim();
    if (!isSriValue(sri)) { reject(new Error('api.js integrity value missing')); return; }
    if (window.DocsAPI) { resolve(); return; }
    let existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    // Never reuse a tag pinned to a different hash.
    if (existing && existing.integrity !== sri) { existing.remove(); existing = null; }
    const script = existing ?? document.createElement('script');

    // Shared settle handler for both the fresh-tag and existing-tag paths.
    // A script element fires load/error only once per src, so a failed tag
    // left in the DOM would never fire again - the next loadDocsApi() call
    // would attach listeners that never settle and "Try again" would hang
    // forever. Removing the tag on error guarantees the next call finds no
    // existing tag and creates a genuinely fresh one.
    const onLoad = () => {
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
      script.remove();
      reject(new Error(translate("editor.error.documentServerUnreachable")));
    };
    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);

    if (!existing) {
      script.id = SCRIPT_ID;
      script.integrity = sri;
      script.crossOrigin = 'anonymous';
      script.src = `${serverUrl}/web-apps/apps/api/documents/api.js`;
      document.head.appendChild(script);
    }
  });
}

export function EditorPage() {
  const ownDir = useAutoDir();
  const t = useT();
  const { fileId } = useParams();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [title, setTitle] = useState<string | null>(null);
  // Starts unknown (not defaulted to 'view') so the read-only badge never
  // flashes before the config fetch resolves - it renders only once the
  // real mode is known, independent of whether the DocsAPI script/editor
  // has finished mounting below.
  const [mode, setMode] = useState<'edit' | 'view' | null>(null);
  const [attempt, setAttempt] = useState(0);


  useEffect(() => {
    let cancelled = false;
    let editor: { destroyEditor?: () => void } | null = null;
    setState('loading');
    setError('');
    (async () => {
      try {
        const res = await api.get<EditorConfigResponse>(`/api/files/${fileId}/editor-config`);
        if (cancelled) return;
        setTitle(res.config.document.title);
        setMode(res.config.editorConfig.mode);
        await loadDocsApi(res.documentServerUrl, res.documentServerApiIntegrity);
        if (cancelled || !window.DocsAPI) return;
        editor = new window.DocsAPI.DocEditor('oo-editor', res.config);
        setState('ready');
      } catch (e) {
        if (!cancelled) {
          // Server text as sent; our own fallback is chosen at render, so it
          // follows a language switch.
          setError(e instanceof ApiError ? e.message : '');
          setState('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      editor?.destroyEditor?.();
    };
  }, [fileId, attempt]);

  return (
    <div className="h-screen flex flex-col bg-background" data-testid="editor-page">
      {/* Same reason as the file viewer: this page renders without the app
          shell, so its header owns the top-left corner the traffic lights
          occupy. */}
      <header className="titlebar-inset flex items-center gap-3 pe-4 py-2 border-b shrink-0">
        <Link to="/files" className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-muted)] hover:text-foreground">
          <ArrowLeft className="size-4 rtl:-scale-x-100" /> {t("common.label.files")}
        </Link>
        <span className="text-sm font-medium truncate">{title ?? ''}</span>
        {mode === 'view' && (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted text-[var(--color-text-muted)]">
            <Eye className="size-3" /> {t("editor.status.readOnly")}
          </span>
        )}
      </header>
      <div className="flex-1 min-h-0 relative">
        {state === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
            {t("editor.status.loadingEditor")}
          </div>
        )}
        {state === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-background border rounded-xl p-8 text-center max-w-sm">
              <p dir={error ? ownDir : undefined} className="text-sm text-[var(--color-text-muted)] mb-4">
                {error || t("editor.error.theDocumentEditorCouldNotBeLoaded")}
              </p>
              <button
                type="button"
                onClick={() => setAttempt((a) => a + 1)}
                className="px-4 py-2 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90"
              >
                {t("common.action.tryAgain")}
              </button>
            </div>
          </div>
        )}
        {/* The ONLYOFFICE frame lays itself out; the page direction must not reach it. */}
        <div dir="ltr" className="w-full h-full">
          <div id="oo-editor" className="w-full h-full" />
        </div>
      </div>
    </div>
  );
}
