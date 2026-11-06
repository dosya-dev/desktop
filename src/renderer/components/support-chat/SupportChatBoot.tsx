import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import { supportChatEnabled, useSupportChat } from "@/lib/support-chat/store";

/** Where a notification click and the Help & contact row land. */
export const LIVE_CHAT_PATH = "/profile?tab=help&chat=1";

/**
 * Mounted once in the signed-in shell. Boots the chat store when the server
 * admits this user (features.support_chat), resets it on sign-out or when the
 * account changes, and opens the chat when a reply notification is clicked.
 */
export function SupportChatBoot() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const enabled = supportChatEnabled(user);
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!enabled) return;
    useSupportChat.getState().boot();
    return () => useSupportChat.getState().__reset();
  }, [enabled, userId]);

  useEffect(() => {
    if (!enabled) return;
    try {
      return window.electronAPI.onSupportChatOpen(() => navigate(LIVE_CHAT_PATH));
    } catch {
      return undefined;
    }
  }, [enabled, navigate]);

  return null;
}
