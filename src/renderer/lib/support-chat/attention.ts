// Window attention for unseen support replies: "(n) " before the window title
// and, while the window is not focused, a system notification whose click
// brings the app forward into the chat (main sends support-chat:open).
// The support-chat store is the only caller (one owner for cues). The renderer
// title is static (index.html), so the base title is read once and restored.

let base: string | null = null;

export function setAttention(count: number): void {
  if (typeof document === "undefined") return;
  base ??= document.title;
  document.title = count > 0 ? `(${count}) ${base}` : base;
}

export function clearAttention(): void {
  if (typeof document === "undefined" || base === null) return;
  document.title = base;
}

/** A system notification for a reply, only when the app is not the focused window. */
export function notifyReply(title: string, body: string): void {
  if (typeof document === "undefined" || document.hasFocus()) return;
  try {
    window.electronAPI.showSupportChatNotification({ title, body });
  } catch { /* attention is a courtesy */ }
}
