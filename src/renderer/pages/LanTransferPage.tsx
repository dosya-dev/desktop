import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Wifi,
  ArrowUpDown,
  Plus,
  LogIn,
  Copy,
  Check,
  Loader2,
  MonitorSmartphone,
} from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { toast } from "sonner";

type Mode = "idle" | "hosting" | "joining";

export function LanTransferPage() {
  const [mode, setMode] = useState<Mode>("idle");
  const [roomCode, setRoomCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [peerConnected, setPeerConnected] = useState(false);

  const createMut = useMutation({
    mutationFn: () => api.post<{ ok: boolean; room_code: string }>("/api/lan-transfer/create"),
    onSuccess: (data) => {
      setRoomCode(data.room_code);
      setMode("hosting");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to create room"),
  });

  const joinMut = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/api/lan-transfer/join", { room_code: joinCode }),
    onSuccess: () => {
      setMode("joining");
      setPeerConnected(true);
      toast.success("Connected to peer");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to join room"),
  });

  const copyCode = () => {
    navigator.clipboard.writeText(roomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex h-full flex-col items-center justify-center">
      <div className="w-full max-w-md space-y-6">
        {/* Header */}
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-primary)]/10">
            <ArrowUpDown size={28} className="text-[var(--color-primary)]" />
          </div>
          <h1 className="text-2xl font-semibold">LAN Transfer</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Transfer files directly between devices on the same network. Fast, private, peer-to-peer.
          </p>
        </div>

        {mode === "idle" && (
          <div className="space-y-3">
            {/* Create room */}
            <button
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending}
              className="flex w-full items-center gap-4 rounded-xl border p-5 text-left hover:bg-[var(--color-bg-secondary)] transition-colors"
              style={{ borderColor: "var(--color-border)" }}
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-primary)]/10">
                <Plus size={20} className="text-[var(--color-primary)]" />
              </div>
              <div>
                <p className="text-sm font-semibold">Create a room</p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Get a code to share with the other device
                </p>
              </div>
            </button>

            {/* Join room */}
            <div
              className="rounded-xl border p-5"
              style={{ borderColor: "var(--color-border)" }}
            >
              <div className="mb-3 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50">
                  <LogIn size={20} className="text-blue-600" />
                </div>
                <div>
                  <p className="text-sm font-semibold">Join a room</p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Enter the code from the other device
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  maxLength={6}
                  placeholder="6-digit code"
                  className="flex-1 rounded-lg border px-3 py-2 text-center text-lg font-mono tracking-wider outline-none focus:border-[var(--color-primary)]"
                  style={{ borderColor: "var(--color-border)" }}
                />
                <button
                  onClick={() => joinMut.mutate()}
                  disabled={joinCode.length !== 6 || joinMut.isPending}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  style={{ background: "var(--color-primary)" }}
                >
                  {joinMut.isPending ? <Loader2 size={16} className="animate-spin" /> : "Join"}
                </button>
              </div>
            </div>

            {/* How it works */}
            <div className="rounded-xl bg-[var(--color-bg-secondary)] p-4">
              <p className="mb-2 text-xs font-semibold text-[var(--color-text-secondary)]">How it works</p>
              <ol className="space-y-1.5 text-xs text-[var(--color-text-muted)]">
                <li>1. One device creates a room and gets a 6-digit code</li>
                <li>2. The other device joins using that code</li>
                <li>3. Files transfer directly between devices (P2P)</li>
                <li>4. No files are stored on the server</li>
              </ol>
            </div>
          </div>
        )}

        {mode === "hosting" && (
          <div className="space-y-4">
            <div
              className="rounded-xl border p-6 text-center"
              style={{ borderColor: "var(--color-border)" }}
            >
              <p className="mb-2 text-sm text-[var(--color-text-secondary)]">
                Share this code with the other device
              </p>
              <div className="mb-3 flex items-center justify-center gap-3">
                <span className="text-4xl font-bold tracking-[0.2em] font-mono">
                  {roomCode}
                </span>
                <button
                  onClick={copyCode}
                  className="rounded-lg border p-2 hover:bg-[var(--color-bg-secondary)]"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  {copied ? <Check size={16} className="text-[var(--color-primary)]" /> : <Copy size={16} />}
                </button>
              </div>
              {!peerConnected ? (
                <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
                  <Loader2 size={14} className="animate-spin" />
                  Waiting for the other device to join...
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-primary)]">
                  <MonitorSmartphone size={16} />
                  Device connected! Ready to transfer.
                </div>
              )}
            </div>

            <button
              onClick={() => { setMode("idle"); setRoomCode(""); setPeerConnected(false); }}
              className="w-full rounded-lg border px-4 py-2 text-sm hover:bg-[var(--color-bg-secondary)]"
              style={{ borderColor: "var(--color-border)" }}
            >
              Cancel
            </button>
          </div>
        )}

        {mode === "joining" && (
          <div className="space-y-4">
            <div
              className="rounded-xl border p-6 text-center"
              style={{ borderColor: "var(--color-border)" }}
            >
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-primary)]/10">
                <MonitorSmartphone size={24} className="text-[var(--color-primary)]" />
              </div>
              <p className="text-sm font-semibold">Connected!</p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                You can now transfer files between devices. Drag files here or use the file browser.
              </p>
            </div>

            <button
              onClick={() => { setMode("idle"); setJoinCode(""); setPeerConnected(false); }}
              className="w-full rounded-lg border px-4 py-2 text-sm hover:bg-[var(--color-bg-secondary)]"
              style={{ borderColor: "var(--color-border)" }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
