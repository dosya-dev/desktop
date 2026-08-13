// Types mirror GET /api/workspace-dashboard (apps/api/src/lib/workspace-dashboard.ts).
export interface DashboardSource {
  kind: 'plan' | 'package' | 'custom' | 'referral';
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

// Per-workspace segment palette (matches the dashboard team-usage bar).
export const WS_SEGMENT_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#14b8a6'];

// Source-dot palette for the "where your space comes from" list.
export const SOURCE_DOT: Record<string, string> = {
  plan: '#3b82f6', package: '#8b5cf6', custom: '#f59e0b', referral: '#22c55e',
};

/** Overall usage-bar color, matching the sidebar/billing thresholds. */
export function storageColor(pct: number): string {
  return pct > 90 ? '#ef4444' : pct > 70 ? '#D97706' : '#22c55e';
}

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
