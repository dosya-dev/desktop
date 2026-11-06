// apps/desktop/src/renderer/components/personas/PersonaView.tsx
//
// Ported from apps/web/src/pages/personas/persona.tsx (design-ref Persona) -
// keep the behaviour and copy in step.
//
// One persona: cover, name (rename inline), photo count, Change cover /
// Merge with… / Remove person, and the photos newest first in month
// sections. Each photo has a menu: "Not <name>", "Set as cover", "Show in
// folder".
//
// Everything comes from this device's engine: the persona and its photos
// (with the face id of this persona in each) from engine.personaPhotos, and
// every action is journaled for the user's other devices. The file names,
// dates and folders come from the photo listing the engine reads from
// (personasPhotoRows); a photo missing there is not readable any more
// (trashed, hidden, locked) and leaves the persona on the next read, so it
// is not shown.
//
// Desktop differences: the viewer is components/files/FileViewer, "Show in
// folder" opens Files with the photo's detail panel (`panel=`, the desktop's
// deep link), and the dialogs and menu are the files surfaces' own.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, EllipsisVertical, GitMerge, ImageIcon, Loader2, Pencil, Plus, Settings, UserRoundX } from "lucide-react";
import { toast } from "sonner";
import type { PersonasEngine } from "@dosya-dev/personas-engine";
import { FileViewer, type ViewerFile } from "@/components/files/FileViewer";
import { FilePreviewImage } from "@/components/files/FilePreviewImage";
import { Modal } from "@/components/files/Modal";
import { useAutoDir } from "@/lib/bidi-ui";
import { useDir, useT } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale-state";
import { personaHref, type FaceBox, type PersonaCard } from "@/lib/personas";
import { personasPhotoRows, type PhotoRow } from "@/lib/personas-device/engine-host";
import type { ReadyStatus } from "@/lib/personas-progress";
import { richText } from "@/lib/rich-text";
import { useExitPresence } from "@/lib/use-exit-presence";
import { FaceAvatar } from "./FaceAvatar";
import { MergeDialog } from "./MergeDialog";
import { PersonaNameField } from "./NameField";
import { BORDER, DANGER_BUTTON, OUTLINE_BUTTON, SMALL } from "./ui";

/** Photos per "Load more". */
const PAGE = 60;
/** The engine's largest page. */
const ENGINE_PAGE_MAX = 500;

type Photo = { file: PhotoRow; face_id: string; box: FaceBox };

type Page = { state: "ready"; persona: PersonaCard; faces: { file_id: string; face_id: string; box: FaceBox }[]; more: boolean } | { state: "gone" };

/** The persona and its first `count` photos (the engine pages by cursor). */
function readPage(engine: Pick<PersonasEngine, "personaPhotos">, pid: string, count: number): Page {
  try {
    let cursor: string | null = null;
    let persona: PersonaCard | null = null;
    const faces: { file_id: string; face_id: string; box: FaceBox }[] = [];
    do {
      const p = engine.personaPhotos(pid, cursor, Math.min(ENGINE_PAGE_MAX, count - faces.length));
      persona = p.persona;
      faces.push(...p.files);
      cursor = p.next;
    } while (cursor && faces.length < count);
    return { state: "ready", persona: persona!, faces, more: cursor !== null };
  } catch {
    return { state: "gone" };
  }
}

/** The viewer wants a full file row; the listing's rows carry the file fields. */
function toViewerFile(r: PhotoRow): ViewerFile {
  return {
    id: r.id, name: r.name ?? "", size_bytes: r.size_bytes ?? 0, mime_type: r.mime_type ?? "", extension: r.extension ?? "",
    region: r.region ?? "", created_at: r.created_at ?? 0, updated_at: r.updated_at ?? r.created_at ?? 0,
    current_version: r.current_version ?? 1, lock_mode: r.lock_mode ?? "none", is_hidden: r.is_hidden ?? 0,
    uploader_name: null, share_count: 0, comment_count: 0,
  };
}

const dateOf = (r: PhotoRow) => Number(r.taken_at ?? r.created_at ?? 0);

/** Year-month key in the viewer's own time zone. */
const monthKey = (unix: number) => { const d = new Date(unix * 1000); return `${d.getFullYear()}-${d.getMonth()}`; };

/** Files with the photo shown: its folder, and the photo's detail panel open. */
const showInFolderHref = (f: PhotoRow) =>
  `/files?${f.folder_id ? `folder=${encodeURIComponent(f.folder_id)}&` : ""}panel=${encodeURIComponent(f.id)}`;

export function PersonaView({ wsId, personaId, engine, status }: {
  wsId: string;
  personaId: string;
  engine: PersonasEngine;
  /** The engine's status: a new object after every change, so the page reads the engine again. */
  status?: ReadyStatus;
}) {
  const t = useT();
  const ownDir = useAutoDir();
  const navigate = useNavigate();
  const [count, setCount] = useState(PAGE);
  const [renaming, setRenaming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [pickingCover, setPickingCover] = useState(false);
  const [viewing, setViewing] = useState<ViewerFile | null>(null);
  // Bumped after an action, so the page reads the engine again even when no status change follows.
  const [version, setVersion] = useState(0);
  const [rows, setRows] = useState<ReadonlyMap<string, PhotoRow> | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- status and version are change signals
  const page = useMemo(() => readPage(engine, personaId, count), [engine, personaId, count, status, version]);

  // The listing is cached for a few minutes and shared with the engine; the
  // same Map comes back until it is made again.
  useEffect(() => {
    let cancelled = false;
    personasPhotoRows(wsId).then(
      (r) => { if (!cancelled) setRows((prev) => (prev === r ? prev : r)); },
      () => { if (!cancelled) setRows((prev) => prev ?? new Map()); },
    );
    return () => { cancelled = true; };
  }, [wsId, status]);

  const photos = useMemo<Photo[]>(() => {
    if (page.state !== "ready" || !rows) return [];
    const out: Photo[] = [];
    for (const f of page.faces) {
      const file = rows.get(f.file_id);
      if (file) out.push({ file, face_id: f.face_id, box: f.box });
    }
    return out;
  }, [page, rows]);

  const months = useMemo(() => {
    const locale = intlLocale("en");
    const out: { key: string; label: string; photos: Photo[] }[] = [];
    for (const p of photos) {
      const at = dateOf(p.file);
      const key = monthKey(at);
      let m = out.find((x) => x.key === key);
      if (!m) {
        m = { key, label: new Date(at * 1000).toLocaleDateString(locale, { month: "long", year: "numeric" }), photos: [] };
        out.push(m);
      }
      m.photos.push(p);
    }
    return out;
  }, [photos]);

  // The Remove dialog behaves like the other dialogs: Escape closes it (not
  // while the removal is running), Cancel takes focus when it opens, and
  // focus goes back to the button that opened it when it closes.
  const removeCancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!removeOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    removeCancelRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [removeOpen]);
  useEffect(() => {
    if (!removeOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !removing) { e.stopPropagation(); setRemoveOpen(false); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [removeOpen, removing]);

  if (page.state === "gone") {
    return (
      <div className="mx-auto max-w-5xl">
        <BackLink />
        <p role="alert" className="mt-6 text-sm text-[var(--color-text-secondary)]">{t("personas.error.personaIsNoLongerHere")}</p>
      </div>
    );
  }

  const { persona } = page;
  const name = persona.name;
  const changed = () => setVersion((v) => v + 1);

  const perform = async (run: () => Promise<unknown>) => {
    try {
      await run();
      changed();
    } catch {
      toast.error(t("personas.error.couldNotUpdatePersona"));
    }
  };
  const notThis = (p: Photo) => perform(() => engine.notThisPerson(p.face_id));
  const makeCover = (p: Photo) => {
    setPickingCover(false);
    return perform(() => engine.setCover(persona.id, p.face_id));
  };

  const remove = async () => {
    setRemoving(true);
    try {
      await engine.removePersona(persona.id);
      setRemoveOpen(false);
      navigate("/personas");
    } catch {
      toast.error(t("personas.error.couldNotUpdatePersona"));
    } finally {
      setRemoving(false);
    }
  };

  const viewerFiles = photos.map((p) => toViewerFile(p.file));

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackLink />
        <Link to="/personas/settings" className={`${OUTLINE_BUTTON} ${SMALL}`} style={BORDER}>
          <Settings size={14} aria-hidden="true" />
          {t("personas.action.personasSettings")}
        </Link>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <FaceAvatar fileId={persona.cover_file_id} box={persona.cover_box} name={name} className="size-20" />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <PersonaNameField
              engine={engine}
              personaId={persona.id}
              initial={name ?? ""}
              onSaved={() => { setRenaming(false); changed(); }}
              onCancel={() => setRenaming(false)}
              className="max-w-xs"
            />
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              <h1 className="truncate text-xl font-semibold tracking-tight" dir={name ? ownDir : undefined}>{name ?? t("personas.label.unnamed")}</h1>
              <button
                type="button"
                onClick={() => setRenaming(true)}
                aria-label={name ? t("personas.action.renameName", { name }) : t("personas.action.addAName")}
                title={name ? t("common.action.rename") : t("personas.action.addAName")}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]"
              >
                {name ? <Pencil size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
              </button>
            </div>
          )}
          <p className="text-sm text-[var(--color-text-secondary)]">{t("personas.label.photoCount", { count: persona.photo_count })}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={`${OUTLINE_BUTTON} ${SMALL} ${pickingCover ? "bg-[var(--color-bg-secondary)]" : ""}`}
            style={BORDER}
            onClick={() => setPickingCover((v) => !v)}
            aria-pressed={pickingCover}
          >
            <ImageIcon size={14} aria-hidden="true" /> {t("personas.action.changeCover")}
          </button>
          <button type="button" className={`${OUTLINE_BUTTON} ${SMALL}`} style={BORDER} onClick={() => setMerging(true)}>
            <GitMerge size={14} aria-hidden="true" /> {t("personas.action.mergeWith")}
          </button>
          <button type="button" className={`${DANGER_BUTTON} ${SMALL}`} style={{ background: "var(--color-danger)" }} onClick={() => setRemoveOpen(true)}>
            <UserRoundX size={14} aria-hidden="true" /> {t("personas.action.removePerson")}
          </button>
        </div>
      </div>

      {pickingCover && (
        <div role="status" className="mt-4 flex items-center gap-3 rounded-lg border bg-[var(--color-bg-secondary)] px-3.5 py-2 text-sm" style={BORDER}>
          <span className="flex-1">{t("personas.description.pickAPhotoForTheCover")}</span>
          <button type="button" className="rounded-md px-2 py-1 text-sm font-medium hover:bg-[var(--color-bg-tertiary)]" onClick={() => setPickingCover(false)}>{t("common.cancel")}</button>
        </div>
      )}

      {!rows && (
        <div className="flex justify-center py-16" role="status" aria-label={t("common.status.loading")}>
          <Loader2 size={20} className="animate-spin text-[var(--color-text-muted)]" aria-hidden="true" />
        </div>
      )}
      {rows && photos.length === 0 && <p className="mt-8 text-sm text-[var(--color-text-secondary)]">{t("personas.description.noPhotosToShow")}</p>}

      {months.map((m) => (
        <section key={m.key} aria-labelledby={`month-${m.key}`} className="mt-8">
          <h2 id={`month-${m.key}`} className="mb-3 text-sm font-semibold">
            {m.label}<span className="font-normal text-[var(--color-text-muted)]"> · {m.photos.length.toLocaleString(intlLocale("en"))}</span>
          </h2>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-1.5">
            {m.photos.map((p) => (
              <PhotoTile
                key={p.file.id}
                file={p.file}
                personaName={name}
                picking={pickingCover}
                onOpen={() => (pickingCover ? void makeCover(p) : setViewing(toViewerFile(p.file)))}
                onNotThis={() => void notThis(p)}
                onCover={() => void makeCover(p)}
                onShowInFolder={() => navigate(showInFolderHref(p.file))}
              />
            ))}
          </ul>
        </section>
      ))}

      {page.more && (
        <div className="mt-6 flex justify-center">
          <button type="button" className={`${OUTLINE_BUTTON} ${SMALL}`} style={BORDER} onClick={() => setCount((c) => c + PAGE)}>
            {t("common.action.loadMore")}
          </button>
        </div>
      )}

      <MergeDialog
        open={merging}
        engine={engine}
        target={persona}
        onClose={() => setMerging(false)}
        onMerged={(survivor) => {
          setMerging(false);
          changed();
          if (survivor !== persona.id) navigate(personaHref(survivor));
        }}
      />

      {removeOpen && (
        <Modal onClose={() => { if (!removing) setRemoveOpen(false); }} maxWidth={384}>
          <div role="dialog" aria-modal="true" aria-labelledby="remove-persona-title">
            <h2 id="remove-persona-title" className="text-lg font-semibold">{t("common.heading.areYouSure")}</h2>
            <p className="mt-2 text-sm leading-normal text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">
              {name
                ? richText(t, "personas.description.youAreRemovingNameTheirFaceDataIsDeleted", {}, { name: <strong className="font-semibold text-[var(--color-text)]" dir={ownDir}>{name}</strong> })
                : t("personas.description.youAreRemovingThisPersonTheirFaceDataIsDeleted")}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button ref={removeCancelRef} type="button" className={OUTLINE_BUTTON} style={BORDER} onClick={() => setRemoveOpen(false)} disabled={removing}>{t("common.cancel")}</button>
              <button type="button" className={DANGER_BUTTON} style={{ background: "var(--color-danger)" }} onClick={() => void remove()} disabled={removing}>
                {removing && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {t("personas.action.removePerson")}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {viewing && (
        <FileViewer
          file={viewing}
          files={viewerFiles}
          workspaceId={wsId}
          onClose={() => setViewing(null)}
          onNavigate={setViewing}
        />
      )}
    </div>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link to="/personas" className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">
      <ArrowLeft size={14} className="rtl:-scale-x-100" aria-hidden="true" />
      {t("common.label.personas")}
    </Link>
  );
}

function PhotoTile({ file, personaName, picking, onOpen, onNotThis, onCover, onShowInFolder }: {
  file: PhotoRow;
  personaName: string | null;
  picking: boolean;
  onOpen: () => void;
  onNotThis: () => void;
  onCover: () => void;
  onShowInFolder: () => void;
}) {
  const t = useT();
  const name = file.name ?? "";
  return (
    // The tile itself must not clip: the photo menu hangs off it (absolutely
    // positioned, 160 px or wider in German) and would lose its start side
    // and last item under an overflow-hidden tile. The image button clips.
    <li className="group relative aspect-square">
      <button
        type="button"
        onClick={onOpen}
        aria-label={picking ? t("personas.action.useNameAsCover", { name }) : name}
        className={`size-full overflow-hidden rounded-lg bg-[var(--color-bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)] ${picking ? "cursor-crosshair hover:opacity-80" : ""}`}
      >
        <FilePreviewImage
          fileId={file.id}
          fileName={name}
          size={256}
          alt=""
          className="size-full object-cover"
          fallback={<ImageIcon size={24} className="m-auto text-[var(--color-text-muted)]" aria-hidden="true" />}
        />
      </button>
      <PhotoMenu
        items={[
          { label: personaName ? t("personas.action.notName", { name: personaName }) : t("personas.action.notThisPerson"), onPick: onNotThis },
          { label: t("personas.action.setAsCover"), onPick: onCover },
          { label: t("personas.action.showInFolder"), onPick: onShowInFolder },
        ]}
      />
    </li>
  );
}

/**
 * The three-dot menu on a photo tile. Escape and an outside click close it
 * (the NewMenu pattern); the arrow keys move between the items.
 */
function PhotoMenu({ items }: { items: { label: string; onPick: () => void }[] }) {
  const t = useT();
  const dir = useDir();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Matches the 120ms exit in .anim-popover[data-closing] (index.css).
  const { mounted, closing } = useExitPresence(open, 120);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % list.length;
    else if (e.key === "ArrowUp") next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
    else if (e.key === "Tab") { setOpen(false); return; }
    if (next < 0) return;
    e.preventDefault();
    list[next].focus();
  };

  return (
    <div ref={wrapRef} className="absolute top-1.5 inset-e-1.5">
      <button
        type="button"
        aria-label={t("personas.action.photoOptions")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex size-7 items-center justify-center rounded-md bg-[var(--color-bg)]/85 text-[var(--color-text)] shadow-sm backdrop-blur-sm transition-opacity hover:bg-[var(--color-bg)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${open ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}
      >
        <EllipsisVertical size={16} aria-hidden="true" />
      </button>
      {mounted && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("personas.action.photoOptions")}
          data-closing={closing ? "" : undefined}
          onKeyDown={onMenuKey}
          className="anim-popover absolute inset-e-0 top-full z-50 mt-1 min-w-40 rounded-lg border bg-[var(--color-bg)] py-1 text-start shadow-lg"
          style={{ borderColor: "var(--color-border)", transformOrigin: dir === "rtl" ? "top left" : "top right" }} // rtl-ok: mirrored
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); item.onPick(); }}
              className="flex w-full items-center whitespace-nowrap px-3 py-1.5 text-sm hover:bg-[var(--color-bg-secondary)] focus:bg-[var(--color-bg-secondary)] focus:outline-none"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
