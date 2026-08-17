---
name: dosya.dev Desktop
description: Native-feeling Electron client for dosya.dev - quiet neutral surfaces, one green accent, eight switchable themes shared with the web app.
colors:
  primary: "oklch(0.6236 0.1833 147.4139)"
  primary-dark: "oklch(0.7007 0.1804 148.9872)"
  brand-green: "#22c55e"
  surface: "oklch(0.9813 0.0100 238.5069)"
  surface-raised: "oklch(0.9396 0.0204 243.4220)"
  ink: "oklch(0.1807 0.0207 239.8394)"
  ink-secondary: "oklch(0.4501 0.0191 239.4931)"
  hairline: "oklch(0.8999 0.0196 240.7516)"
  surface-dark: "oklch(0.1289 0.0199 238.9108)"
  surface-raised-dark: "oklch(0.2414 0.0196 239.1401)"
  ink-dark: "oklch(0.9513 0.0101 238.5127)"
  ink-secondary-dark: "oklch(0.6499 0.0194 240.1577)"
  hairline-dark: "oklch(0.2791 0.0203 242.6079)"
  danger: "oklch(0.6207 0.2306 24.9164)"
  warning: "oklch(0.72 0.16 75)"
  signal-blue: "#3b82f6"
  signal-amber: "#f59e0b"
  signal-red: "#ef4444"
  pure-white: "#ffffff"
  scrim-black: "#000000"
  viewer-charcoal: "#1e1e1e"
  viewer-silver: "#d4d4d4"
typography:
  headline:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.33
  title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.55
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.33
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
    fontSize: "0.75rem"
    fontWeight: 400
  scale:
    nano: "8px"
    micro: "9px"
    tiny: "10px"
    mini: "11px"
    xs: "12px"
    compact: "13px"
    sm: "14px"
    base: "16px"
    lg: "18px"
    xl: "20px"
    2xl: "24px"
    4xl: "36px"
rounded:
  sm: "2px"
  scrollbar: "3px"
  base: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  2xl: "16px"
  full: "9999px"
spacing:
  unit: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  sidebar: "260px"
  titlebar: "52px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.pure-white}"
    rounded: "{rounded.lg}"
    padding: "10px 16px"
  button-secondary:
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.pure-white}"
    rounded: "{rounded.lg}"
    padding: "10px 16px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "24px"
  sidebar-item:
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
---

# Design System: dosya.dev Desktop

## Overview

**Creative North Star: "The Native Workbench"**

The desktop app is an Operate-mode work tool: a file manager, sync monitor, and viewer that people keep open all day. It is designed to read as part of the operating system rather than as a website in a frame - system font stack, a custom 52px title bar with a real drag region, overlay scrollbars, `user-select: none` chrome, and a window body that never scrolls (each page scrolls internally). Visual energy is deliberately low: quiet blue-grey neutral surfaces carry dense information, and a single green accent marks the active and the affirmative.

The theme system is a deliberate mirror of the web app (`apps/web`). Eight selectable themes (Default, Mono, Claude, Amber, Ocean, Bubblegum, Vercel, Neo-Brutalism) x light/dark/system are defined as `[data-theme]` blocks in `src/renderer/styles/index.css`, with values copied verbatim from `apps/web/src/index.css` (the Default theme's oklch values are byte-identical between the two apps). The desktop consumes a smaller vocabulary than the web: seven shadcn-style tokens per theme (`--background`, `--foreground`, `--primary`, `--secondary`, `--muted-foreground`, `--border`, `--destructive`) are aliased once in `:root` onto the `--color-*` names that every component actually uses (`--color-bg`, `--color-bg-secondary`, `--color-bg-tertiary`, `--color-border`, `--color-text`, `--color-text-secondary`, `--color-text-muted`, `--color-primary`, `--color-primary-hover`, `--color-danger`, `--color-danger-hover`, `--color-warning`). Derived shades are computed with `color-mix()`, never hardcoded. Dark mode is a `.dark` class toggled by `lib/theme.ts`, not a media query, so the JS-selected mode always wins.

**Key Characteristics:**
- Quiet, dense, utilitarian; information first, decoration nowhere
- One green accent (oklch 0.62/0.18/147 light, 0.70/0.18/149 dark - the #22c55e family) on cool blue-grey neutrals
- Native desktop feel: system fonts, custom TitleBar, 6px overlay scrollbars, no text selection in chrome
- Theme-proof components: everything routes through `var(--color-*)` aliases so all 8 themes and both modes work untouched
- Flat surfaces separated by 1px hairline borders; shadows reserved for overlays
- Full `prefers-reduced-motion` kill switch on all animation and transitions

## Colors

A cool blue-grey neutral ramp with one saturated green voice, plus a small fixed signal set for states that must read the same in every theme.

### Primary
- **Brand Green** (`--color-primary`, oklch(0.6236 0.1833 147.4139) light / oklch(0.7007 0.1804 148.9872) dark): the only accent. Primary buttons, active nav pill (at 10% alpha), focus borders and rings, selection rings, toggle-on state, sync-idle badge, links and active icons. The raw hex `#22c55e` appears where a theme-independent green is required (workspace accent set, dashboard chart segments).
- **Primary Hover** (`--color-primary-hover`, `color-mix(in oklab, var(--primary) 85%, var(--foreground))`): computed, never a second green token.

### Neutral
- **Surface** (`--color-bg`, oklch(0.9813 0.0100 238.5069) light / oklch(0.1289 0.0199 238.9108) dark): the window base, cards, modals, flyouts.
- **Surface Raised** (`--color-bg-secondary`, oklch(0.9396 0.0204 243.4220) light / oklch(0.2414 0.0196 239.1401) dark): hover fills, secondary panels, input wells.
- **Surface Tertiary** (`--color-bg-tertiary`, `color-mix(in oklab, var(--secondary), var(--foreground) 8%)`): pressed/selected fills one step deeper.
- **Ink** (`--color-text`, oklch(0.1807 0.0207 239.8394) light / oklch(0.9513 0.0101 238.5127) dark): primary text.
- **Ink Secondary** (`--color-text-secondary`, oklch(0.4501 0.0191 239.4931) light / oklch(0.6499 0.0194 240.1577) dark): supporting text, inactive icons.
- **Ink Muted** (`--color-text-muted`, `color-mix(in oklab, var(--muted-foreground) 62%, var(--background))`): metadata, placeholders, scrollbar thumbs. The most-used text color in the app.
- **Hairline** (`--color-border`, oklch(0.8999 0.0196 240.7516) light / oklch(0.2791 0.0203 242.6079) dark): all structural borders and dividers.

### Signal (theme-independent status hues)
- **Danger** (`--color-danger`, oklch(0.6207 0.2306 24.9164), same value in light and dark): destructive buttons, delete affordances, failed states. Raw `#ef4444` is its hex sibling in chart/status maps.
- **Warning** (`--color-warning`, oklch(0.72 0.16 75)): non-fatal conditions - a degraded watcher, a skipped file - deliberately distinct from danger so degradation never reads as failure. Raw `#f59e0b` carries the same meaning in status maps (sync offline/rate-limited, expiring links).
- **Info Blue** (`#3b82f6` family, `bg-blue-50 text-blue-600` while syncing): in-flight activity. Blue means "working", green means "done/idle".
- **Workspace Accent Set** (`#22c55e #3b82f6 #f59e0b #ef4444 #8b5cf6 #ec4899 #06b6d4 #14b8a6`, `WS_SEGMENT_COLORS` in `lib/workspace-dashboard.ts`): the categorical palette for workspace colors and dashboard chart segments. Fixed hexes by design - a user's workspace color must not shift with the theme.
- **Role Badge Set** (`ROLE_LABELS` in `TeamPage`): owner `#22c55e`, admin `#3b82f6`, member `#6b7280`, viewer `#a16207`; `#6b7280` doubles as the neutral fallback dot in dashboard breakdowns.
- **Danger Tint** (`rgb(254 242 242)`, Tailwind red-50): the wash behind the account-deletion banner; the light-red surface family (`bg-red-50 text-red-600`) also tints the paused sync chip.

### Named Rules
**The Alias-Only Rule.** Components never touch `--background`/`--primary` directly and never hardcode a theme color; they consume only the `--color-*` aliases (or Tailwind `[var(--color-*)]` arbitrary values). This is what makes all 8 themes x 2 modes work without per-component changes.

**The One Voice Rule.** Green is the only accent voice in chrome. When a second hue appears it is a status code (blue = in flight, amber = degraded, red = failed/destructive), never decoration.

**The Fixed Islands Exception.** Four surfaces intentionally ignore the theme: (1) the plain-text/code viewer is always a charcoal terminal (`#1e1e1e` background, `#d4d4d4` text, `white/10` hairlines) in both modes; (2) MapLibre photo pins use fixed light neutrals (`#dfe3e8`, `#eef2f7`, `#d9dee4`, `#eef2f6`, `#64748b`) with 3px white frames and a white tail; (3) the per-filetype icon set (`assets/file-icons/*.svg`) and provider logos (Google, Dropbox, OneDrive) keep their own brand colors; (4) the in-file find highlight uses fixed amber (`rgba(255,213,0,0.35)` for matches, `rgba(255,153,0,0.85)` with `#1a1a1a` text for the current match) - chosen for visibility against any theme, ported from the web app.

**Known inconsistency - native checkboxes.** Grid-view selection checkboxes, modals, and forms tint native controls with `accent-[var(--color-primary)]`, but the list-view checkboxes in `FileBrowserPage` (table header + rows) and `DuplicatesPage` are bare `<input type="checkbox">` and render in the OS/Chromium default blue. This is documented reality, not a rule: when touching those surfaces, adding the accent class is the correcting direction.

**Focus visibility note.** The styled focus treatment is primary-colored (see Components). Unstyled native controls fall back to the OS focus ring, which can render amber/orange against the green accent depending on system settings; a design critique judged that contrast helpful ("aids visibility - keep it"). The durable requirement is a visible, high-contrast focus indicator on every control - not any particular hue.

## Typography

**UI Font:** system-ui (with -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)
**Mono Font:** Tailwind default mono stack (ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New")

**Character:** Whatever the OS speaks. No webfonts are loaded; the app inherits the platform's rendering and feels native on macOS, Windows, and Linux. Mono is reserved for filenames in the viewer chrome, code/text content, hashes, and keyboard shortcuts.

### Hierarchy
- **Headline** (600, 1.5rem/24px): page titles ("Settings", "Sync").
- **Title** (600, 1.125rem/18px): section headers, modal titles, empty-state headings.
- **Body** (400-500, 0.875rem/14px): the default UI size - inputs, buttons, rows, nav items.
- **Label** (500, 0.75rem/12px): metadata, table headers, badges, timestamps; uppercase with `tracking-wide` for group headers (e.g. the sidebar's "Workspace").
- **Micro** (500-600, 8-11px arbitrary steps `text-[8px]` through `text-[11px]`, plus 13px): dense chrome only - badge counts, kbd hints, flyout headers, sync-status chips. Real and intentional in a desktop-density tool; do not promote them to body copy.
- **Display sizes** (1.25rem/20px, 2.25rem/36px) appear rarely: stats, onboarding, big empty states.

**Weights:** 500 (medium) is the workhorse; 600 (semibold) for headings and emphasis; 700 (bold) sparingly for counts; 400 only for body paragraphs.

### Named Rules
**The Fourteen-Pixel Rule.** Body text is `text-sm` (14px). `text-base` (16px) is effectively absent from the app (7 uses) - new UI copy defaults to 14px, labels to 12px.

## Layout

A fixed application frame, not a document. The window is `overflow: hidden`; only page content scrolls.

- **TitleBar:** 52px tall (`--titlebar-height`), full-width drag region (`.titlebar-drag` / `.titlebar-no-drag` opt-outs). On macOS, content keeps left clearance of 80px (`--titlebar-inset-left`, set via `:root[data-platform="darwin"]`) for the OS traffic lights; full-window surfaces (viewer, editor) apply `.titlebar-inset`. Windows/Linux draw their own controls on the right inside the TitleBar.
- **Sidebar:** 260px (`--sidebar-width`), collapsible to a 60px icon rail with fixed-position flyouts. Nav scrolls independently; the storage widget and profile stay pinned below.
- **Content:** pages own their scroll areas; two-pane layouts (browser + detail panel) split inside the content region.
- **Spacing rhythm:** Tailwind's 4px grid. Controls sit at 8-12px internal padding, cards at 16-24px, page gutters at 24px. Density is a feature - rows are compact (py-2), gaps are 4-8px.
- **Scrollbars:** 6px overlay style, transparent track, `--color-text-muted` thumb with 3px radius.
- **Auth/onboarding pages** (login, signup, verify) center a single card over the faint `.bg-grid` backdrop (a purple-tinted 800px grid SVG at 10% opacity) - the one place the marketing world leaks in, intentionally.

## Elevation & Depth

Flat by default. Resting surfaces are separated by hairline borders (`1px solid var(--color-border)`) and background steps (bg -> bg-secondary -> bg-tertiary), not shadows. Shadows exist only to mark things that float above the page.

### Shadow Vocabulary
- **Overlay** (`shadow-xl`, Tailwind): modals and dialogs, always paired with a `bg-black/30` scrim.
- **Popover** (`shadow-lg`): dropdowns, context menus, sidebar flyouts, the notification panel.
- **Whisper** (`shadow-sm`): rare; small raised affordances. Not used on cards at rest.
- **Pin shadow** (`filter: drop-shadow(0 2px 3px rgba(0,0,0,.35))`): map photo pins floating over the map canvas.

### Named Rules
**The Overlay-Only Shadow Rule.** If it doesn't float (modal, menu, flyout, pin), it doesn't cast a shadow. In-flow cards and panels are flat with hairline borders.

## Shapes

Soft-rectangle language on a tight radius ramp; circles only for status and identity.

- **8px (`rounded-lg`) is the default control radius** - buttons, inputs, nav items, menu items, thumbnails (309 uses, the clear incumbent).
- **12px (`rounded-xl`)** for containers: modals, cards, detail panels, grid tiles.
- **4-6px (`rounded`/`rounded-md`)** for small chips, kbd hints, badges; **2px (`rounded-sm`)** rare.
- **16px (`rounded-2xl`)** for hero-ish tiles and the 64px map pin frame (which adds a 3px solid white border and a triangular white tail; approximate-location pins switch the frame to `dashed` at 0.92 opacity so IP-derived positions are never disguised as GPS-exact).
- **Full pill (`rounded-full`)** for avatars, dots, toggle switches, count badges, icon buttons.
- Borders are always 1px hairlines except the pin frame (3px white) and drag-drop targets (`border-2 border-dashed border-[var(--color-primary)]`).

## Components

### Buttons
- **Shape:** gently rounded (8px), `text-sm font-medium`.
- **Primary:** solid `--color-primary` with white text, `px-4 py-2.5`; loading/hover state swaps to `--color-primary-hover`; `disabled:opacity-50`.
- **Secondary:** transparent with 1px `--color-border`, ink text, hover fills `--color-bg-secondary`.
- **Danger:** solid `--color-danger` with white text for destructive confirmations.
- **Ghost/icon:** no border, hover fills `black/5` or `--color-bg-secondary`; used throughout the TitleBar and toolbars.
- **Focus:** `focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]` - a 1px primary ring hugging the control, no offset glow.

### Inputs / Fields
- **Style:** 1px `--color-border` stroke, app background, 8px radius, `px-3 py-2 text-sm`, `outline-none`.
- **Focus:** border and 1px ring both shift to `--color-primary`.
- **Placeholder/help:** `--color-text-muted`.

### Cards / Containers
- **Corner style:** 12px; **background:** `--color-bg` (or `--color-bg-secondary` for wells); **border:** 1px hairline; **shadow:** none at rest (see Elevation); **padding:** 16-24px.

### Modals
- Centered `rounded-xl bg-[var(--color-bg)] p-6 shadow-xl` over a `bg-black/30` scrim (shared `Modal` shell in `components/files/Modal.tsx`, default max-width 448px).

### Navigation (Sidebar)
- Rows are `rounded-lg px-3 py-2 text-sm font-medium` in `--color-text-secondary`; icons 16-18px.
- **The travelling pill:** the active state is a single absolutely-positioned `rounded-lg bg-[var(--color-primary)]/10` pill that animates `top/height/left/width` over 200ms ease-out between rows (`motion-reduce:transition-none` drops the travel). Rows paint no active background of their own.
- Group headers: 11px uppercase `tracking-wide` muted labels.

### Toggle Switch
- 24x44px (`h-6 w-11`) pill; track `--color-primary` when on, `--color-border` when off; white thumb; `transition-colors`.

### Status Chips (TitleBar sync state)
- Micro pills (`rounded-lg px-2.5 py-1 text-xs font-medium`) whose tint is the status code: `bg-[var(--color-primary)]/10 text-[var(--color-primary)]` idle, `bg-blue-50 text-blue-600` syncing (with spinning icon), `bg-red-50 text-red-600` paused.

### Context Menus
- Popover surfaces (`shadow-lg`, 8px radius, hairline border) entering with `ctx-in`: 120ms-scale fade from `scale(0.95) translateY(-4px)`.

### Signature: the Code Viewer Island
- Plain-text/code content renders on a fixed charcoal terminal surface (`#1e1e1e`, `text-[#d4d4d4]`, mono, 11px chrome header with `text-white/40`) regardless of theme or mode - content fidelity over theme purity.

### Signature: Map Photo Pins
- 64px rounded-square photo frames (16px radius, 3px white border, white tail, drop shadow), shimmer skeleton while loading (`#d9dee4`->`#eef2f6` gradient sweep), white count badge with hard text-shadow, dashed frame for approximate locations.

### Theme Sweep
- User-initiated theme changes paint the new theme over the old with a left-to-right `clip-path` wipe (520ms, `cubic-bezier(0.65, 0, 0.35, 1)`) via the View Transitions API; boot and login reconciliation apply instantly; reduced-motion users always get the instant swap.

## Do's and Don'ts

### Do:
- **Do** route every color through the `--color-*` aliases (Tailwind form: `text-[var(--color-text-muted)]`, `bg-[var(--color-bg-secondary)]`). If a new shade is needed, derive it with `color-mix()` from existing tokens.
- **Do** keep green singular: `--color-primary` marks the active nav item, the affirmative button, the on-state - and nothing decorative.
- **Do** default new text to 14px (`text-sm`), metadata to 12px (`text-xs`), and use the documented micro steps (8-11px) only inside dense chrome.
- **Do** use the standard focus treatment (primary border + 1px primary ring) on any new focusable control.
- **Do** keep new surfaces flat with 1px hairline borders; reserve `shadow-lg`/`shadow-xl` for things that genuinely float.
- **Do** respect `prefers-reduced-motion` on any new animation (the global kill switch in `index.css` handles CSS; JS-driven motion like the theme sweep and sidebar pill must check it explicitly, as they already do).
- **Do** add `accent-[var(--color-primary)]` to native checkboxes/radios/ranges - the list-view checkboxes that lack it are a known gap, not a pattern to copy.

### Don't:
- **Don't** hardcode theme-dependent hexes in components - a color that must survive all 8 themes is either a `--color-*` alias or belongs to the documented Fixed Islands (viewer charcoal, map pin neutrals, file-icon set, provider brand marks, find-highlight amber, workspace accent set).
- **Don't** import rules from the repo-root DESIGN.md - that file documents the marketing site (different world, different fonts, different palette). This file governs `apps/desktop`.
- **Don't** add a second accent hue, gradients, or decorative color to chrome; blue/amber/red are status codes only.
- **Don't** introduce webfonts; the system stack is the identity.
- **Don't** put shadows on in-flow cards or grow radii past 12px for containers (16px is reserved for the pin frame and hero tiles).
- **Don't** edit theme token values in `styles/index.css` unilaterally - they mirror `apps/web/src/index.css` and `apps/web/src/lib/themes.ts` (and the API allow-list in `apps/api/src/lib/appearance.ts`); parity is the contract.
