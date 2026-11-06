// apps/desktop/src/renderer/lib/family-api.ts
import { api } from "@/lib/api-client";

/** Mirrors apps/web/src/api/family.ts; the places fields are optional for API builds without them. */
export type FamilyRole = "none" | "payer" | "member";
export type FamilyMemberView = {
  id: string; email: string; name: string | null;
  status: "invited" | "active"; joined_at: number | null; expires_at: number | null;
  over_free?: boolean;
  /** Their active reservation in bytes, or null (always null for invitations and an unpaid pool). Older APIs omit it. */
  reserved_bytes?: number | null;
  /** Active members only: what they take from the pool, as the upload gates count it. */
  used_bytes?: number;
  /** Payer view, active members only: the most that can be reserved for them now (0 when the payer's plan lapsed). */
  max_reservable_bytes?: number;
  /** The member's user id (their usage row's id), null for an invitation. Older APIs omit it. */
  user_id?: string | null;
};
export type FamilyUsageRow = {
  id: string; name: string; is_you: boolean; is_payer: boolean; used_bytes: number; used_label: string;
  /** Their active reservation in bytes, or null. Older APIs omit it. */
  reserved_bytes?: number | null;
};
export type FamilyView = {
  ok: true;
  role: FamilyRole;
  limit: number;
  included?: number;
  extra_places?: number;
  can_buy_places?: boolean;
  over_capacity?: boolean;
  eligible: boolean;
  ineligible_reason: "free_plan" | "is_member" | null;
  pool: {
    used_bytes: number; limit_bytes: number; used_label: string; limit_label: string;
    /** Sum of active reservations. Older APIs omit it. */
    reserved_bytes?: number;
    /** Reserved but not yet used. */
    held_bytes?: number;
    /** What people without a reservation can still use. */
    free_bytes?: number;
  };
  /** Active reservations add up to more than the pool (the plan shrank). Older APIs omit it. */
  reservations_exceed_pool?: boolean;
  plan: { id: string; name: string };
  payer: { name: string } | null;
  members: FamilyMemberView[] | null;
  usage?: FamilyUsageRow[];
  own_used_bytes?: number;
  own_used_label?: string;
  /** Member view only: the caller's own active reservation, or null. */
  own_reserved_bytes?: number | null;
};

export const FAMILY_KEY = ["family"] as const;

export const getFamily = () => api.get<FamilyView>("/api/family");
export const inviteFamilyMember = (email: string) => api.post<{ ok: true }>("/api/family/invites", { email });
export const revokeFamilyInvite = (id: string) => api.delete<{ ok: true }>(`/api/family/invites/${id}`);
export const removeFamilyMember = (id: string) => api.delete<{ ok: true }>(`/api/family/members/${id}`);
/** Reservations are whole binary gigabytes. */
export const GB = 1_073_741_824;
/** Hold `gb` whole GB for an active member (family_members.id); null removes the reservation. */
export const setFamilyReservation = (memberId: string, gb: number | null) =>
  api.put<{ ok: true }>(`/api/family/members/${memberId}/reservation`, { gb });
export const leaveFamily = () => api.post<{ ok: true }>("/api/family/leave");

/**
 * Whether the app shows a Family entry at all. A free user with nobody to
 * manage sees nothing: the only thing to say to them is "buy a plan", and the
 * store builds may not say that.
 */
export function showsFamilyEntry(view: FamilyView | undefined | null): boolean {
  if (!view) return false;
  return view.role === "member" || view.role === "payer" || view.eligible || (view.members ?? []).length > 0;
}
