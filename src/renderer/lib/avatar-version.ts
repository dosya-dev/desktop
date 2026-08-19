import { create } from "zustand";

/**
 * /api/me/avatar is a fixed endpoint, so browsers reuse a cached image both
 * across avatar changes AND across accounts (Chromium's in-process image
 * cache survives SPA navigation). Every avatar <img> must therefore build
 * its URL with avatarUrl(): the user id makes it per-account, the version
 * (bumped on upload/delete) makes it per-change.
 */
interface AvatarVersionState {
  version: number;
  bump: () => void;
}

export const useAvatarVersion = create<AvatarVersionState>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));

export function avatarUrl(apiBase: string, userId: string, version: number): string {
  return `${apiBase}/api/me/avatar?u=${encodeURIComponent(userId)}&v=${version}`;
}

/**
 * Any user's photo, for comment and activity rows. The user_avatar field on
 * those rows is an R2 object key ("avatars/<id>/avatar.png"), not a fetchable
 * URL - treat it as a "has photo" flag and stream the image through the
 * cookie-authenticated API instead. The user id lives in the path, so caching
 * is already per-account; the version still busts the cache when the signed-in
 * user replaces their own photo.
 */
export function userAvatarUrl(apiBase: string, userId: string, version: number): string {
  return `${apiBase}/api/users/${encodeURIComponent(userId)}/avatar?v=${version}`;
}
