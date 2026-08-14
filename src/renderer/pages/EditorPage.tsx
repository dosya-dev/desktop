/**
 * The ONLYOFFICE editor, ported from apps/web/src/pages/editor.tsx.
 *
 * The whole server side already existed - /api/files/:id/editor-config mints the
 * signed config and an opaque download token - so this is a front end and
 * nothing more.
 *
 * It needs the document server named in the renderer's CSP: api.js is loaded
 * from there and the editor then iframes it. See src/main/session.ts, where
 * both script-src and frame-src carry docsBase. Without that the script is
 * blocked silently and the page simply never becomes an editor.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Eye } from 'lucide-react';
import { api, ApiError } from "@/lib/api-client";

interface EditorConfigResponse {
  ok: boolean;
  documentServerUrl: string;
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

function loadDocsApi(serverUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.DocsAPI) { resolve(); return; }
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
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
      reject(new Error('Document server unreachable'));
    };
    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);

    if (!existing) {
      script.id = SCRIPT_ID;
      script.src = `${serverUrl}/web-apps/apps/api/documents/api.js`;
      document.head.appendChild(script);
    }
  });
}

export function EditorPage() {
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
        await loadDocsApi(res.documentServerUrl);
        if (cancelled || !window.DocsAPI) return;
        editor = new window.DocsAPI.DocEditor('oo-editor', res.config);
        setState('ready');
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : "The document editor could not be loaded.");
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
    <div className="h-screen flex flex-col bg-background">
      <header className="flex items-center gap-3 px-4 py-2 border-b shrink-0">
        <Link to="/files" className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-muted)] hover:text-foreground">
          <ArrowLeft className="size-4" /> Files
        </Link>
        <span className="text-sm font-medium truncate">{title ?? ''}</span>
        {mode === 'view' && (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted text-[var(--color-text-muted)]">
            <Eye className="size-3" /> Read-only
          </span>
        )}
      </header>
      <div className="flex-1 min-h-0 relative">
        {state === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
            Loading editor...
          </div>
        )}
        {state === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-background border rounded-xl p-8 text-center max-w-sm">
              <p className="text-sm text-[var(--color-text-muted)] mb-4">
                {error || 'The document editor could not be loaded.'}
              </p>
              <button
                type="button"
                onClick={() => setAttempt((a) => a + 1)}
                className="px-4 py-2 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90"
              >
                Try again
              </button>
            </div>
          </div>
        )}
        <div id="oo-editor" className="w-full h-full" />
      </div>
    </div>
  );
}
