// Ported from apps/web/src/components/vcard-viewer.tsx (read-only) - keep in sync with the web copy.
// The desktop viewer is read-only: ContactEditor/EditList and the save path are
// intentionally absent.
import { useEffect, useMemo, useState } from "react";
import {
  Phone, Mail, MapPin, Globe, Cake, StickyNote, Building2, Copy, Check, Search,
} from "lucide-react";
import { colorFor, initials } from "@/lib/file-type";
import { parseVCards, type ParsedVCard } from "@/lib/vcard";

interface Props {
  file: { id: string; name: string; mime_type: string };
  rawUrl: string;
}

export function VCardView({ file, rawUrl }: Props) {
  const [cards, setCards] = useState<ParsedVCard[] | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setState("loading"); setSelected(0);
    let cancelled = false;
    fetch(rawUrl, { credentials: "include" })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((text) => {
        if (cancelled) return;
        const parsed = parseVCards(text);
        setCards(parsed);
        setState(parsed.length ? "ok" : "error");
      })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [rawUrl]);

  const filtered = useMemo(() => {
    if (!cards) return [];
    const q = query.trim().toLowerCase();
    if (!q) return cards.map((c, i) => ({ c, i }));
    return cards.map((c, i) => ({ c, i })).filter(({ c }) =>
      c.fullName.toLowerCase().includes(q) ||
      c.emails.some((e) => e.value.toLowerCase().includes(q)) ||
      c.phones.some((p) => p.value.toLowerCase().includes(q)) ||
      (c.org ?? "").toLowerCase().includes(q));
  }, [cards, query]);

  if (state === "loading") {
    return <div className="text-sm text-[var(--color-text-muted)]">Loading contact…</div>;
  }
  if (state === "error" || !cards) {
    return (
      <div className="rounded-xl border bg-[var(--color-bg)] p-10 text-center" style={{ borderColor: "var(--color-border)", minWidth: 280 }}>
        <p className="mb-3 text-4xl font-bold tracking-wider text-[var(--color-text-muted)]/40">VCF</p>
        <p className="text-sm text-[var(--color-text-muted)] break-all">{file.name}</p>
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">This contact file couldn't be read.</p>
      </div>
    );
  }

  const card = cards[selected];
  const multi = cards.length > 1;

  return (
    <div className="flex h-full w-full min-h-0 gap-4 self-stretch">
      {multi && (
        <div className="flex w-60 shrink-0 flex-col overflow-hidden rounded-xl border bg-[var(--color-bg)]" style={{ borderColor: "var(--color-border)" }}>
          <div className="border-b p-2" style={{ borderColor: "var(--color-border)" }}>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search contacts"
                className="h-8 w-full rounded-lg border pl-8 pr-2 text-xs outline-none focus:border-[var(--color-primary)]"
                style={{ borderColor: "var(--color-border)" }}
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5">
            {filtered.map(({ c, i }) => (
              <button
                key={i}
                onClick={() => setSelected(i)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${i === selected ? "bg-[var(--color-bg-tertiary)]" : "hover:bg-[var(--color-bg-secondary)]"}`}
              >
                <Avatar card={c} px={28} />
                <span className="truncate text-xs font-medium">{c.fullName || "(no name)"}</span>
              </button>
            ))}
            {filtered.length === 0 && <p className="py-4 text-center text-xs text-[var(--color-text-muted)]">No matches</p>}
          </div>
        </div>
      )}

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-md">
          <ContactCard card={card} />
        </div>
      </div>
    </div>
  );
}

// ── Avatar ─────────────────────────────────────────────────
// Size is inline (not a Tailwind `size-N` class) because Tailwind can't generate
// classes from a template literal.
function Avatar({ card, px }: { card: ParsedVCard; px: number }) {
  const box = { width: px, height: px };
  if (card.photo) return <img src={card.photo.dataUrl} alt="" style={box} className="shrink-0 rounded-full object-cover" />;
  const color = colorFor(card.fullName || "contact");
  return (
    <div className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white" style={{ ...box, background: color, fontSize: px * 0.4 }}>
      {initials(card.fullName)}
    </div>
  );
}

// ── Read-only card ─────────────────────────────────────────
function ContactCard({ card }: { card: ParsedVCard }) {
  return (
    <div className="overflow-hidden rounded-2xl border bg-[var(--color-bg)]" style={{ borderColor: "var(--color-border)" }}>
      <div className="flex flex-col items-center gap-2 bg-[var(--color-bg-secondary)] p-6 pb-5 text-center">
        <Avatar card={card} px={80} />
        <div>
          <h2 className="text-lg font-semibold">{card.fullName || "(no name)"}</h2>
          {(card.title || card.org) && (
            <p className="text-sm text-[var(--color-text-muted)]">
              {[card.title, card.org].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1 p-4">
        {card.phones.map((p, i) => (
          <FieldRow key={`p${i}`} icon={<Phone size={16} />} type={p.type} value={p.value} href={`tel:${p.value.replace(/\s/g, "")}`} />
        ))}
        {card.emails.map((e, i) => (
          <FieldRow key={`e${i}`} icon={<Mail size={16} />} type={e.type} value={e.value} href={`mailto:${e.value}`} />
        ))}
        {card.addresses.map((a, i) => (
          <FieldRow key={`a${i}`} icon={<MapPin size={16} />} type={a.type} value={a.value} href={`https://maps.google.com/?q=${encodeURIComponent(a.value)}`} external />
        ))}
        {card.urls.map((u, i) => (
          <FieldRow key={`u${i}`} icon={<Globe size={16} />} type="url" value={u} href={/^https?:\/\//.test(u) ? u : `https://${u}`} external />
        ))}
        {card.org && !card.title && (
          <FieldRow icon={<Building2 size={16} />} type="organization" value={card.org} />
        )}
        {card.birthday && (
          <FieldRow icon={<Cake size={16} />} type="birthday" value={card.birthday} />
        )}
        {card.note && (
          <div className="flex gap-3 px-2 py-2.5">
            <StickyNote size={16} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
            <p className="whitespace-pre-wrap break-words text-sm">{card.note}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function FieldRow({ icon, type, value, href, external }: { icon: React.ReactNode; type: string; value: string; href?: string; external?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
  };
  return (
    <div className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-[var(--color-bg-secondary)]">
      <span className="shrink-0 text-[var(--color-text-muted)]">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="mb-0.5 text-[11px] capitalize leading-none text-[var(--color-text-muted)]">{type}</p>
        {href
          ? <a href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})} className="break-all text-sm text-[var(--color-primary)] hover:underline">{value}</a>
          : <p className="break-all text-sm">{value}</p>}
      </div>
      <button onClick={copy} title="Copy" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-[var(--color-bg-tertiary)] group-hover:opacity-100">
        {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} className="text-[var(--color-text-muted)]" />}
      </button>
    </div>
  );
}
