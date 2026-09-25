import { CHART, quotaState } from "./palette";
// Types mirror GET /api/workspace-dashboard (apps/api/src/lib/workspace-dashboard.ts).
export interface DashboardSource {
  kind: 'plan' | 'package' | 'custom' | 'license' | 'referral';
  label: string;
  bytes: number;
  meta: Record<string, unknown>;
}

export interface OwnedWorkspace {
  id: string;
  name: string;
  icon_initials: string;
  icon_color: string;
  icon_image_url: string | null;
  used_bytes: number;
  share_pct: number;
}

export interface SharedWorkspace {
  id: string;
  name: string;
  icon_initials: string;
  icon_color: string;
  icon_image_url: string | null;
  role_id: string;
  owner_name: string;
}

export interface WorkspaceDashboardData {
  total: { limit_bytes: number; used_bytes: number; free_bytes: number };
  sources: DashboardSource[];
  owned: OwnedWorkspace[];
  shared: SharedWorkspace[];
}

// The segment and threshold colours now come from the shared palette
// (packages/brand). They used to be three hardcoded copies of an 8-hue array whose
// worst pair was indistinguishable under red-green colour blindness; the shared set is
// five hues verified against simulated deutan, protan and tritan vision.
export const WS_SEGMENT_COLORS = CHART.light;

/** Series colour for the nth workspace in the stacked bar. */
export function segmentColor(index: number, scheme: Scheme = "light"): string {
  const series = CHART[scheme];
  return series[index % series.length];
}

/** Overall usage-bar colour. One rule, shared with the sidebar and billing. */
export function storageColor(pct: number, scheme: Scheme = "light"): string {
  const state = quotaState(pct);
  return STORAGE_STATE_COLOR[scheme][state];
}

const STORAGE_STATE_COLOR = {
  light: { ok: "#15803d", warn: "#b45309", critical: "#d42121" },
  dark: { ok: "#4ade80", warn: "#fcd34d", critical: "#f87171" },
} as const;

type Scheme = "light" | "dark";
export const SOURCE_DOT: Record<string, string> = {
  plan: '#3b82f6', package: '#8b5cf6', custom: '#f59e0b', license: '#ec4899', referral: '#22c55e',
};

export interface StackSegment {
  id: string;
  name: string;
  widthPct: number; // share of the FILLED portion of the bar
}

/** Segments for the stacked usage bar: each owned workspace's share of the used space. */
export function stackedSegments(owned: OwnedWorkspace[], usedBytes: number): StackSegment[] {
  if (usedBytes <= 0) return [];
  return owned
    .filter((w) => w.used_bytes > 0)
    .map((w) => ({
      id: w.id,
      name: w.name,
      widthPct: (w.used_bytes / usedBytes) * 100,
    }));
}

const ROLE_LABELS: Record<string, string> = {
  role_owner: 'Owner', role_admin: 'Admin', role_member: 'Member', role_viewer: 'Viewer',
};

/**
 * Human label for a workspace role id.
 *
 * The fallback is "Custom role", not "Member": a workspace-defined role has an
 * id like `role_a1b2c3` that is not in the map above, and calling it "Member"
 * asserted a builtin role the person does not hold.
 */
export function roleLabel(roleId: string): string {
  return ROLE_LABELS[roleId] ?? 'Custom role';
}
