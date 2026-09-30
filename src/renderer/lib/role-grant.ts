/**
 * Who may hand out which role: the desktop copy of the grant rule in
 * apps/api/src/lib/role-rank.ts (permissionsBeyondGrantor). Keep the two in
 * step.
 *
 * The server refuses PUT /api/team/members/:id and POST /api/team/invite with
 * 403 when the chosen role is not grantable by the caller. This exists so the
 * pickers stop offering those roles in the first place, instead of the first
 * feedback being that 403. The API remains the authority.
 *
 * The rule is one sentence: a role may be granted if and only if it is not
 * role_owner AND every permission it grants is one the caller holds. There is
 * no rank ladder, manage_roles is a permission like any other rather than an
 * escalation, and the built-in tiers get no exemption: /api/roles serves the
 * full permission map for Admin, Member and Viewer exactly as it does for a
 * custom role, so the same subset test covers all of them. The caller's own
 * role id plays no part, which is why canGrantRole no longer takes it.
 */

const OWNER_ROLE_ID = "role_owner";

export interface GrantTarget {
  id: string;
  is_builtin?: boolean;
  permissions?: Record<string, boolean>;
}

/**
 * The permissions `targetPerms` grants that `myPerms` does not hold, in the
 * target's key order so a refusal can name them. Empty means within the
 * ceiling. A `false` in the target is never an escalation, and an absent key
 * in the grantor reads as `false`, the same way the server's hasPermission
 * does.
 */
export function permissionsBeyondGrantor(
  myPerms: Record<string, boolean>,
  targetPerms: Record<string, boolean>,
): string[] {
  const beyond: string[] = [];
  for (const [key, granted] of Object.entries(targetPerms)) {
    if (granted === true && myPerms[key] !== true) beyond.push(key);
  }
  return beyond;
}

/**
 * Whether a caller with permission map `myPerms` may put someone into
 * `target` - by invite or by changing an existing member's role.
 *
 * A target without a permission map (an older API payload) is not refused
 * here: there is nothing to compare against, so the picker leaves the role in
 * place and the server, which does know, gives the answer.
 */
export function canGrantRole(
  myPerms: Record<string, boolean>,
  target: GrantTarget,
): boolean {
  if (target.id === OWNER_ROLE_ID) return false;
  return permissionsBeyondGrantor(myPerms, target.permissions ?? {}).length === 0;
}
