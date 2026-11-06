import { mmss } from '../format';
import { resolveReportLabels, type ReportLabels } from '../labels';
import { validateReport, type ReportDiagnostics, type ReportReason } from './payload';
import type { ReportConfig } from './types';
import { describeUa } from './ua';

export interface ReportPopover {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Swap the config (reasons, submit, diagnostics) without remounting. */
  setConfig(cfg: ReportConfig): void;
  destroy(): void;
}

const DONE_CLOSE_MS = 1800;

const reasonsFor = (l: ReportLabels): Record<ReportReason, { title: string; sub: string; heading: string; note: string; send: string; glyph: string }> => ({
  playback: {
    title: l.playbackTitle,
    sub: l.playbackSub,
    heading: l.playbackHeading,
    note: l.playbackNote,
    send: l.send,
    glyph: '▶',
  },
  copyright: {
    title: l.copyrightTitle,
    sub: l.copyrightSub,
    heading: l.copyrightHeading,
    note: '',
    send: l.copyrightSend,
    glyph: '©',
  },
  abuse: {
    title: l.abuseTitle,
    sub: l.abuseSub,
    heading: l.abuseHeading,
    note: l.abuseNote,
    send: l.send,
    glyph: '!',
  },
});

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function field<T extends HTMLInputElement | HTMLTextAreaElement>(node: T, name: string, placeholder: string): T {
  node.name = name;
  node.placeholder = placeholder;
  node.setAttribute('aria-label', placeholder);
  return node;
}

function chipsFor(d: ReportDiagnostics, l: ReportLabels): string[] {
  const chips = [describeUa(d.ua, l)];
  const media = [d.codec, d.resolution].filter(Boolean).join(' · ');
  if (media) chips.push(media);
  chips.push(l.atTime(mmss(d.position_ms / 1000)));
  chips.push(d.media_error === null ? l.noDecodeError : l.decodeError(d.media_error));
  return chips;
}

interface ReasonStep {
  node: HTMLElement;
  send: HTMLButtonElement;
  challenge: HTMLElement;
  chips: HTMLElement | null;
  reset(): void;
  read(): { details: string; email: string; source_url: string; owner_attested: boolean };
}

export function mountReportPopover(anchor: HTMLElement, initial: ReportConfig, onOpenChange: (open: boolean) => void): ReportPopover {
  let cfg = initial;
  let L = resolveReportLabels(cfg.labels);
  let REASONS = reasonsFor(L);
  let isOpen = false;
  let destroyed = false;
  let sending = false;
  let generation = 0;
  let current: ReportReason | null = null;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;

  const root = el('div', 'dp-report');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', L.report);
  const steps = new Map<string, HTMLElement>();
  const reasonSteps = new Map<ReportReason, ReasonStep>();

  const addStep = (name: string, node: HTMLElement) => {
    node.className = `${node.className} dp-step`.trim();
    node.dataset.step = name;
    node.hidden = true;
    steps.set(name, node);
    root.append(node);
  };
  const show = (name: string) => {
    for (const [k, n] of steps) n.hidden = k !== name;
  };
  const heading = (text: string, back: boolean) => {
    const h = el('h5');
    h.append(el('span', undefined, text));
    if (back) {
      const b = el('button', 'dp-back', L.back);
      b.type = 'button';
      h.append(b);
    }
    return h;
  };

  const clearDone = () => { if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; } };

  const close = () => {
    clearDone();
    if (!isOpen) return;
    isOpen = false;
    anchor.classList.remove('dp-open');
    onOpenChange(false);
  };

  const submit = async (reason: ReportReason) => {
    const s = reasonSteps.get(reason)!;
    if (sending || s.send.disabled) return;
    const v = s.read();
    const res = validateReport({
      reason,
      details: v.details,
      email: v.email,
      source_url: v.source_url,
      owner_attested: v.owner_attested,
      diagnostics: reason === 'playback' ? cfg.diagnostics?.() : undefined,
    });
    if (!res.ok) return;
    const gen = generation;
    sending = true;
    s.send.disabled = true;
    s.send.textContent = L.sending;
    let out: Awaited<ReturnType<ReportConfig['submit']>>;
    try {
      out = await cfg.submit(res.payload, { challengeHost: s.challenge });
    } catch {
      out = { ok: false, error: L.somethingWentWrong };
    }
    sending = false;
    // A config swap rebuilt the steps mid-flight: this result is stale.
    if (destroyed || gen !== generation) return;
    s.send.textContent = REASONS[reason].send;
    if (out.ok) s.reset();
    refresh(reason);
    if (out.ok) {
      const doneStep = steps.get('done')!;
      doneStep.querySelector('a.dp-formal')?.remove();
      if (reason === 'copyright' && cfg.formalNoticeUrl) {
        const link = el('a', 'dp-formal', L.formalNotice);
        link.href = cfg.formalNoticeUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        doneStep.append(link);
      }
      show('done');
      clearDone();
      if (isOpen) doneTimer = setTimeout(close, DONE_CLOSE_MS);
    } else {
      steps.get('error')!.querySelector('.dp-error')!.textContent = out.error;
      show('error');
    }
  };

  const refresh = (reason: ReportReason) => {
    const s = reasonSteps.get(reason)!;
    const v = s.read();
    s.send.disabled = sending || !validateReport({ reason, details: v.details, email: v.email, source_url: v.source_url, owner_attested: v.owner_attested }).ok;
  };

  const buildReason = (reason: ReportReason): ReasonStep => {
    const copy = REASONS[reason];
    const node = el('div');
    node.append(heading(copy.heading, true));
    let chips: HTMLElement | null = null;
    let details: HTMLTextAreaElement | null = null;
    let email: HTMLInputElement | null = null;
    let source: HTMLTextAreaElement | null = null;
    let attested: HTMLInputElement | null = null;

    if (reason === 'playback') {
      chips = el('div', 'dp-chips');
    }
    if (chips) node.append(chips);
    if (reason === 'copyright') {
      email = field(el('input', 'dp-input'), 'email', L.yourEmail);
      email.type = 'email';
      email.autocomplete = 'email';
      source = field(el('textarea', 'dp-input'), 'source_url', L.sourceUrl);
      source.rows = 2;
      const label = el('label', 'dp-ck');
      attested = el('input');
      attested.type = 'checkbox';
      attested.name = 'owner_attested';
      label.append(attested, document.createTextNode(L.ownerAttestation));
      const f1 = el('div', 'dp-f'); f1.append(email);
      const f2 = el('div', 'dp-f'); f2.append(source);
      node.append(f1, f2, label);
    } else {
      details = field(el('textarea', 'dp-input'), 'details', copy.note);
      details.rows = 3;
      const f = el('div', 'dp-f'); f.append(details);
      node.append(f);
    }
    const challenge = el('div', 'dp-challenge');
    const send = el('button', 'dp-send', copy.send);
    send.type = 'button';
    node.append(challenge, send);

    const s: ReasonStep = {
      node, send, challenge, chips,
      reset: () => {
        for (const f of [details, email, source]) if (f) f.value = '';
        if (attested) attested.checked = false;
      },
      read: () => ({
        details: details?.value ?? '',
        email: email?.value ?? '',
        source_url: source?.value ?? '',
        owner_attested: attested?.checked ?? false,
      }),
    };
    reasonSteps.set(reason, s);
    for (const input of [details, email, source, attested]) {
      input?.addEventListener('input', () => refresh(reason));
      input?.addEventListener('change', () => refresh(reason));
    }
    send.addEventListener('click', () => { void submit(reason); });
    node.querySelector('.dp-back')!.addEventListener('click', () => { show('pick'); });
    addStep(reason, node);
    refresh(reason);
    return s;
  };

  const enter = (reason: ReportReason) => {
    current = reason;
    const s = reasonSteps.get(reason)!;
    if (s.chips && cfg.diagnostics) {
      s.chips.replaceChildren(...chipsFor(cfg.diagnostics(), L).map((t) => el('span', undefined, t)));
    }
    show(reason);
    (s.node.querySelector('input:not([type=checkbox]), textarea') as HTMLElement | null)?.focus();
  };

  const build = () => {
    generation++;
    root.replaceChildren();
    steps.clear();
    reasonSteps.clear();

    const pickNode = el('div');
    pickNode.append(heading(L.report, false));
    for (const reason of cfg.reasons) {
      const copy = REASONS[reason];
      const b = el('button', 'dp-opt');
      b.type = 'button';
      b.dataset.reason = reason;
      const glyph = el('i', undefined, copy.glyph);
      glyph.setAttribute('aria-hidden', 'true');
      const text = el('span');
      text.append(document.createTextNode(copy.title), el('small', undefined, copy.sub));
      b.append(glyph, text);
      b.addEventListener('click', () => enter(reason));
      pickNode.append(b);
    }
    addStep('pick', pickNode);
    for (const reason of cfg.reasons) buildReason(reason);

    const done = el('div', 'dp-done');
    done.innerHTML = '<svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="20"/><path d="M13 23l7 7 12-14"/></svg>';
    done.append(el('b', undefined, L.reportedThanks), el('p', undefined, L.reportedFollowUp));
    addStep('done', done);

    const err = el('div');
    err.append(heading(L.report, false), el('p', 'dp-error'));
    const back = el('button', 'dp-back dp-back-error', L.back);
    back.type = 'button';
    back.addEventListener('click', () => { if (current && reasonSteps.has(current)) show(current); else show('pick'); });
    err.append(back);
    addStep('error', err);
    err.querySelector('.dp-error')!.setAttribute('role', 'alert');
    show('pick');
  };

  const onDocClick = (e: MouseEvent) => {
    if (!isOpen) return;
    const t = e.target as Element | null;
    if (!t || !t.closest) return;
    if (t.closest('.dp-report') || t.closest('.dp-report-btn') || t.closest('.dp-report-fail')) return;
    close();
  };
  const onKeydown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      anchor.parentElement?.querySelector<HTMLElement>('.dp-report-btn')?.focus({ preventScroll: true });
    }
  };

  build();
  anchor.append(root);
  root.addEventListener('keydown', onKeydown);
  // Capture: the player stops picture clicks before they bubble to document.
  document.addEventListener('click', onDocClick, { capture: true });

  return {
    open() {
      if (destroyed || isOpen) return;
      isOpen = true;
      clearDone();
      show('pick');
      anchor.classList.add('dp-open');
      onOpenChange(true);
      // preventScroll: opening must never move the host page.
      root.querySelector<HTMLElement>('button.dp-opt')?.focus({ preventScroll: true });
    },
    close,
    isOpen: () => isOpen,
    setConfig(next) {
      const sameReasons = next.reasons.join() === cfg.reasons.join();
      // A new labels object (the host switched language) rebuilds the steps.
      const sameLabels = next.labels === cfg.labels;
      cfg = next;
      L = resolveReportLabels(cfg.labels);
      REASONS = reasonsFor(L);
      // Same reasons and words: keep the form (and any typing) as it is.
      if (sameReasons && sameLabels) return;
      root.setAttribute('aria-label', L.report);
      current = null;
      build();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearDone();
      document.removeEventListener('click', onDocClick, { capture: true });
      root.remove();
      anchor.classList.remove('dp-open');
    },
  };
}
