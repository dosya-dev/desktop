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
