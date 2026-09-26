import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowUpDown,
  Check,
  Copy,
  Loader2,
  MonitorSmartphone,
  Plus,
  Upload,
  FileCheck2,
} from "lucide-react";
import { ApiError } from "@/lib/api-client";
import { LanSession, type LanState } from "@/lib/lan-peer";
import { ipcSink, signalTransport } from "@/lib/lan-transport";
import { formatBytes } from "@/lib/format";

type Mode = "idle" | "hosting" | "joining";

interface ReceivedFile {
  name: string;
  path: string;
}

export function LanTransferPage() {
  const [mode, setMode] = useState<Mode>("idle");
  const [roomCode, setRoomCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [peerConnected, setPeerConnected] = useState(false);
  const [received, setReceived] = useState<ReceivedFile[]>([]);
  const [sending, setSending] = useState<{ name: string; sent: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const sessionRef = useRef<LanSession | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // One place to wire a new session's callbacks, whichever side opened it.
  const adopt = useCallback((session: LanSession) => {
    session.onState = (state: LanState) => setPeerConnected(state === "connected");
    session.onFileReceived = (file) => {
      setReceived((prev) => [...prev, file]);
      toast.success(`Received "${file.name}"`);
    };
    session.onError = (message) => toast.error(message);
    sessionRef.current = session;
  }, []);

  // The room holds this machine's SDP and ICE for ten minutes. Leaving the
  // page drops it rather than letting it sit there describing the LAN.
  useEffect(() => () => { void sessionRef.current?.close(); }, []);

  const createMut = useMutation({
    mutationFn: () => LanSession.host({ transport: signalTransport, sink: ipcSink }),
    onSuccess: (session) => {
      adopt(session);
      setRoomCode(session.roomCode);
      setMode("hosting");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to create room"),
  });

  const joinMut = useMutation({
    mutationFn: () => LanSession.join({ transport: signalTransport, sink: ipcSink }, joinCode),
    onSuccess: (session) => {
      adopt(session);
      setMode("joining");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to join room"),
  });

  const leave = () => {
    void sessionRef.current?.close();
    sessionRef.current = null;
    setMode("idle");
    setRoomCode("");
    setJoinCode("");
    setPeerConnected(false);
    setReceived([]);
    setSending(null);
  };

  const copyCode = () => {
    navigator.clipboard.writeText(roomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const sendFiles = async (files: File[]) => {
    const session = sessionRef.current;
    if (!session || !peerConnected) {
      toast.error("The other device is not connected yet");
      return;
    }
    // One at a time: the channel carries one file's frames at a time, and a
    // single progress bar is the honest thing to show for a serial send.
    for (const file of files) {
      setSending({ name: file.name, sent: 0, total: file.size });
      session.onSendProgress = (sent, total) => setSending({ name: file.name, sent, total });
      try {
        await session.sendFile(file);
        toast.success(`Sent "${file.name}"`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `Could not send "${file.name}"`);
        break;
      }
    }
    setSending(null);
  };

  const connected = peerConnected;

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
            <button
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending}
              className="flex w-full items-center gap-4 rounded-xl border p-5 text-left hover:bg-[var(--color-bg-secondary)] transition-colors"
              style={{ borderColor: "var(--color-border)" }}
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-primary)]/10">
                {createMut.isPending
                  ? <Loader2 size={20} className="animate-spin text-[var(--color-primary)]" />
                  : <Plus size={20} className="text-[var(--color-primary)]" />}
              </div>
              <div>
                <p className="text-sm font-semibold">Create a room</p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Get a code to share with the other device
                </p>
              </div>
            </button>

            <div className="rounded-xl border p-5" style={{ borderColor: "var(--color-border)" }}>
              <p className="text-sm font-semibold">Join a room</p>
              <p className="mb-3 text-xs text-[var(--color-text-muted)]">
                Enter the code from the other device
              </p>
              <div className="flex gap-2">
                <input
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="6-digit code"
                  inputMode="numeric"
                  className="flex-1 rounded-lg border px-3 py-2 font-mono text-sm"
                  style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}
                />
                <button
                  onClick={() => joinMut.mutate()}
                  disabled={joinCode.length !== 6 || joinMut.isPending}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
                  style={{ background: "var(--color-primary)" }}
                >
                  {joinMut.isPending ? "Joining..." : "Join"}
                </button>
              </div>
            </div>

            <div className="rounded-xl border p-5" style={{ borderColor: "var(--color-border)" }}>
              <p className="mb-2 text-sm font-semibold">How it works</p>
              <ul className="space-y-1 text-xs text-[var(--color-text-muted)]">
                <li>1. One device creates a room and gets a 6-digit code</li>
                <li>2. The other device joins using that code</li>
                <li>3. Files go straight between the two devices, never through our servers</li>
                <li>4. Both devices must be on the same network</li>
              </ul>
            </div>
          </div>
        )}

        {mode === "hosting" && (
          <div className="space-y-4">
            <div className="rounded-xl border p-6 text-center" style={{ borderColor: "var(--color-border)" }}>
              <p className="mb-2 text-sm text-[var(--color-text-secondary)]">
                Share this code with the other device
              </p>
              <div className="mb-3 flex items-center justify-center gap-3">
                <span className="text-4xl font-bold tracking-[0.2em] font-mono">{roomCode}</span>
                <button
                  onClick={copyCode}
                  aria-label="Copy code"
                  className="rounded-lg border p-2 hover:bg-[var(--color-bg-secondary)]"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  {copied ? <Check size={16} className="text-[var(--color-primary)]" /> : <Copy size={16} />}
                </button>
              </div>
              <ConnectionLine connected={connected} />
            </div>
            {connected && <TransferPanel />}
            <button
              onClick={leave}
              className="w-full rounded-lg border px-4 py-2 text-sm hover:bg-[var(--color-bg-secondary)]"
              style={{ borderColor: "var(--color-border)" }}
            >
              {connected ? "Disconnect" : "Cancel"}
            </button>
          </div>
        )}

        {mode === "joining" && (
          <div className="space-y-4">
            <div className="rounded-xl border p-6 text-center" style={{ borderColor: "var(--color-border)" }}>
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-primary)]/10">
                <MonitorSmartphone size={24} className="text-[var(--color-primary)]" />
              </div>
              <ConnectionLine connected={connected} />
            </div>
            {connected && <TransferPanel />}
            <button
              onClick={leave}
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

  function ConnectionLine({ connected: isOn }: { connected: boolean }) {
    return isOn ? (
      <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-primary)]">
        <MonitorSmartphone size={16} />
        Device connected
      </div>
    ) : (
      <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Loader2 size={14} className="animate-spin" />
        Waiting for the other device to join...
      </div>
    );
  }

  function TransferPanel() {
    return (
      <div className="space-y-3">
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const files = [...e.dataTransfer.files];
            if (files.length) void sendFiles(files);
          }}
          onClick={() => fileInputRef.current?.click()}
          className="cursor-pointer rounded-xl border border-dashed p-6 text-center transition-colors"
          style={{
            borderColor: dragOver ? "var(--color-primary)" : "var(--color-border)",
            background: dragOver ? "var(--color-bg-secondary)" : "transparent",
          }}
        >
          <Upload size={22} className="mx-auto mb-2 text-[var(--color-text-muted)]" />
          <p className="text-sm font-medium">Drop files to send</p>
          <p className="text-xs text-[var(--color-text-muted)]">or click to choose them</p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (files.length) void sendFiles(files);
            }}
          />
        </div>

        {sending && (
          <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="truncate font-medium">{sending.name}</span>
              <span className="text-[var(--color-text-muted)]">
                {formatBytes(sending.sent)} of {formatBytes(sending.total)}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg-secondary)]">
              <div
                className="h-full rounded-full transition-[width]"
                style={{
                  width: `${sending.total ? Math.round((sending.sent / sending.total) * 100) : 100}%`,
                  background: "var(--color-primary)",
                }}
              />
            </div>
          </div>
        )}

        {received.length > 0 && (
          <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)" }}>
            <p className="mb-2 text-xs font-semibold text-[var(--color-text-secondary)]">Received</p>
            <ul className="space-y-1">
              {received.map((f) => (
                <li key={f.path} className="flex items-center gap-2 text-xs">
                  <FileCheck2 size={14} className="shrink-0 text-[var(--color-primary)]" />
                  <span className="truncate font-medium">{f.name}</span>
                  <span className="truncate text-[var(--color-text-muted)]">{f.path}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
}
