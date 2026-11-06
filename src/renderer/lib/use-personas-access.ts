// apps/desktop/src/renderer/lib/use-personas-access.ts
//
// Ported from apps/web/src/hooks/use-personas-access.ts - keep the two in step.
//
// Whether the Personas entry points show (the Files sidebar row, the search
// page's people). Personas runs on each member's own devices and is free on
// every plan, so it shows for every signed-in user; `ask` lets a caller hold
// it back (a role that may not see files has no photos to read). Nothing is
// asked of a server. The signed-in user is the one AuthProvider handed to
// Personas (lib/personas-device/teardown.ts).
import { useSyncExternalStore } from "react";
import { personasUser, subscribePersonasUser } from "@/lib/personas-device/teardown";

export function usePersonasVisible(ask = true): boolean {
  const signedIn = useSyncExternalStore(subscribePersonasUser, () => personasUser() !== null, () => false);
  return signedIn && ask;
}
