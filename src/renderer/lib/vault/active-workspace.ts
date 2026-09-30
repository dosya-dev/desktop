/**
 * The active storage workspace id, published by WorkspaceProvider for code
 * that lives outside React (the Vault store). Display-only input: it decides
 * which Spaces show under "My Spaces" and which workspace a new Space is
 * scoped to. It never feeds any security decision.
 */
let activeId: string | null = null;

export function setActiveGlobalWorkspaceId(id: string | null): void {
  activeId = id;
}

export function getActiveGlobalWorkspaceId(): string | null {
  return activeId;
}
