import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "./api-client";
import {
  readCache,
  writeCache,
  applyTheme,
  applyThemeAnimated,
  subscribeThemeChange,
  type ThemePref,
} from "./theme";

/**
 * The one way a surface changes the theme. Applies instantly (with the wipe),
 * caches locally, saves to the account (PUT /api/me/appearance) so the choice
 * follows the user across devices, and rolls back if the save fails - the
 * rollback is instant because a second wipe in the other direction reads as a
 * bug rather than a revert. Extracted from ProfilePage's Appearance section
 * when the titlebar gained a theme menu, so the two surfaces cannot drift.
 */
export function useThemePref() {
  const [pref, setPref] = useState<ThemePref>(() => readCache());

  // Stay in sync when another surface (the other picker, account reconcile
  // on login) applies a theme.
  useEffect(() => subscribeThemeChange((next) => setPref(next)), []);

  const save = useCallback(async (next: ThemePref) => {
    // Captured before writeCache so a failed save restores what the user had.
    const prev = readCache();
    setPref(next);
    applyThemeAnimated(next);
    writeCache(next);
    try {
      await api.put("/api/me/appearance", next);
    } catch (e) {
      setPref(prev);
      applyTheme(prev);
      writeCache(prev);
      toast.error(e instanceof ApiError ? e.message : "Your theme could not be saved");
    }
  }, []);

  return { pref, save };
}
