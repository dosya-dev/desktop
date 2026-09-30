import { test } from "node:test";
import assert from "node:assert/strict";

import { canGrantRole, permissionsBeyondGrantor } from "./role-grant.ts";

/**
 * The registry as the API serves it: 35 keys. Every /api/roles payload carries
 * the whole map for every role, built-in tiers included, which is what lets
 * the subset rule below apply to Admin and Viewer exactly as it does to a
 * custom role.
 */
const REGISTRY = [
  "upload_files", "download_files", "delete_own_files", "delete_any_file", "rename_files",
  "create_folders", "rename_folders", "create_share_links", "view_own_shares", "view_all_shares",
  "invite_members", "view_team_members", "manage_roles", "change_workspace_name", "change_workspace_icon",
  "change_max_file_size", "change_storage_per_member", "change_total_storage_cap",
  "change_max_concurrent_uploads", "change_allowed_file_types", "change_blocked_file_types",
  "change_duplicate_scan", "manage_settings", "view_activity", "lock_files", "hide_files",
  "access_dashboard", "access_files", "access_upload", "access_shared", "access_team",
  "access_settings", "access_webdav", "access_s3", "access_sftp",
] as const;

function only(...granted: string[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const key of REGISTRY) map[key] = granted.includes(key);
  return map;
}

/** The seeded owner: every key true. */
const OWNER_PERMS = only(...REGISTRY);
/** The seeded admin: 33 true, lock_files and hide_files false (migrations 0021/0023). */
const ADMIN_PERMS = only(...REGISTRY.filter((k) => k !== "lock_files" && k !== "hide_files"));
const MEMBER_PERMS = only(
  "upload_files", "download_files", "delete_own_files", "rename_files", "create_folders",
  "rename_folders", "create_share_links", "view_own_shares", "view_team_members",
  "access_dashboard", "access_files", "access_upload", "access_shared", "access_team",
);
const VIEWER_PERMS = only("download_files", "view_own_shares", "access_dashboard", "access_files", "access_shared");

const owner = { id: "role_owner", is_builtin: true, permissions: OWNER_PERMS };
const admin = { id: "role_admin", is_builtin: true, permissions: ADMIN_PERMS };
const member = { id: "role_member", is_builtin: true, permissions: MEMBER_PERMS };
const viewer = { id: "role_viewer", is_builtin: true, permissions: VIEWER_PERMS };

test("permissionsBeyondGrantor names the granted keys the grantor lacks, in request order", () => {
  assert.deepEqual(permissionsBeyondGrantor(ADMIN_PERMS, { lock_files: true, upload_files: true, hide_files: true }), ["lock_files", "hide_files"]);
  // A requested false is never an escalation; an absent grantor key reads as false.
  assert.deepEqual(permissionsBeyondGrantor(ADMIN_PERMS, { lock_files: false }), []);
  assert.deepEqual(permissionsBeyondGrantor({}, { upload_files: true }), ["upload_files"]);
});

test("nobody may grant owner, not even an owner holding every permission", () => {
  assert.equal(canGrantRole(OWNER_PERMS, owner), false);
  assert.equal(canGrantRole(ADMIN_PERMS, owner), false);
  assert.equal(canGrantRole({ ...ADMIN_PERMS, manage_roles: true }, owner), false);
});

test("an admin may grant admin, member and viewer", () => {
  for (const target of [admin, member, viewer]) {
    assert.equal(canGrantRole(ADMIN_PERMS, target), true, target.id);
  }
});

test("an admin may not grant a custom role that carries lock_files", () => {
  const locker = { id: "custom_locker", is_builtin: false, permissions: { upload_files: true, lock_files: true } };
  assert.equal(canGrantRole(ADMIN_PERMS, locker), false);
  // The same target is fine for a grantor who holds lock_files.
  assert.equal(canGrantRole({ ...ADMIN_PERMS, lock_files: true }, locker), true);
});

test("a team-manager custom role may not grant viewer when viewer holds download_files", () => {
  // The behaviour change from the rank rule: no role is exempt from the
  // subset test. A caller who cannot download may not hand out a role that can.
  const manager = only("invite_members", "manage_roles", "view_team_members", "access_team");
  assert.equal(canGrantRole(manager, viewer), false);
  assert.equal(canGrantRole(manager, member), false);
  assert.equal(canGrantRole(manager, admin), false);
  // manage_roles is a permission like any other now, not an escalation.
  assert.equal(canGrantRole(manager, { id: "custom_2", is_builtin: false, permissions: { download_files: true } }), false);
  // Within the manager's own holdings the grant goes through.
  assert.equal(canGrantRole(manager, { id: "custom_3", is_builtin: false, permissions: { invite_members: true, access_team: true } }), true);
});

test("an owner holding every permission may grant anything but owner", () => {
  for (const target of [admin, member, viewer]) {
    assert.equal(canGrantRole(OWNER_PERMS, target), true, target.id);
  }
  const locker = { id: "custom_locker", is_builtin: false, permissions: { lock_files: true, hide_files: true } };
  assert.equal(canGrantRole(OWNER_PERMS, locker), true);
});

test("a custom target within the grantor's permissions is allowed", () => {
  const uploader = { id: "custom_uploader", is_builtin: false, permissions: { upload_files: true, invite_members: false } };
  assert.equal(canGrantRole(ADMIN_PERMS, uploader), true);
  assert.equal(canGrantRole(only("upload_files"), uploader), true);
});

test("a target that carries no permission map is not refused on the client", () => {
  // Nothing to compare against (older API payload), so the picker leaves the
  // role in place and the server, which does know, gives the answer.
  assert.equal(canGrantRole(ADMIN_PERMS, { id: "custom_x" }), true);
  assert.equal(canGrantRole(ADMIN_PERMS, { id: "role_owner" }), false);
});
