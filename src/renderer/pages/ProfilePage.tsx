import { useState, useRef, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  User,
  Lock,
  Key,
  Monitor,
  Bell,
  Trash2,
  Pencil,
  Copy,
  Download,
  CreditCard,
  ChevronRight,
  ExternalLink,
  HelpCircle,
  Shield,
  Smartphone,
  Laptop,
  Globe,
  AlertTriangle,
  Save,
  Eye,
  EyeOff,
  Info,
  RefreshCw,
  CheckCircle,
  Loader2,
  ArrowDownCircle,
  XCircle,
  Palette,
  Users,
  Check,
  Minus,
  Plus,
} from "lucide-react";
import { api, ApiError, apiRequest } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useAvatarVersion, avatarUrl } from "@/lib/avatar-version";
import { formatDate } from "@/lib/format";
import {
  DELETE_CODE_LENGTH, normaliseDeleteCode, isCompleteDeleteCode,
  deleteCooldownRemaining, deletionDaysRemaining, classifyDeleteFailure,
  type AccountDeletePreview, type DeleteFailure,
} from "@dosya-dev/shared";
import { formatters, useLocale, useT } from "@/lib/i18n";
import { aboutRows, detailsText, type AboutInfo, type AboutRow, type SyncSummaryInput } from "@/lib/about-info";
import { AcknowledgementsList } from "@/components/AcknowledgementsList";
import { LOCALE_LABELS, intlTag } from "../../i18n/locales";
import { steppedZoom, ZOOM_STEPS } from "@/lib/pinch-zoom";
import { makeT } from "../../i18n/translator";
import en from "../../i18n/messages/en.json";
import appIcon from "@/assets/app-icon.png";
import { richText } from "@/lib/rich-text";
import { passwordError } from "@/lib/password-error";
import type { MessageKey } from "../../i18n/keys";
import type { T } from "../../i18n/translator";
import { toast } from "sonner";
import { autoDir } from "@/lib/bidi-ui";
import { THEMES, type Mode } from "@/lib/themes";
import { useThemePref } from "@/lib/use-theme-pref";
import { webAppUrl } from "../lib/web-app-url";
import { useDistribution } from "../lib/use-distribution";
import { FAMILY_KEY, getFamily, showsFamilyEntry } from "@/lib/family-api";
import { FamilySection } from "@/components/family/FamilySection";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { showsBillingTab, showsUpdateControls } from "../lib/store-surfaces";
import { supportChatEnabled, useSupportChat } from "@/lib/support-chat/store";
import { ChatView } from "@/components/support-chat/ChatView";
import { PresenceDot } from "@/components/support-chat/PersonaAvatar";
import { UnreadBadge } from "@/components/support-chat/UnreadBadge";
import { LIVE_CHAT_PATH } from "@/components/support-chat/SupportChatBoot";

type Tab = "identity" | "appearance" | "password" | "api-keys" | "sessions" | "notifications" | "billing" | "family" | "about" | "help" | "delete";

const TABS: { id: Tab; label: MessageKey; icon: React.ReactNode; danger?: boolean }[] = [
  { id: "identity", label: "profile.heading.identity", icon: <User size={16} /> },
  { id: "appearance", label: "common.label.appearance", icon: <Palette size={16} /> },
  { id: "password", label: "profile.heading.password2FA", icon: <Lock size={16} /> },
  { id: "api-keys", label: "profile.heading.apiKeys", icon: <Key size={16} /> },
  { id: "sessions", label: "profile.heading.sessions", icon: <Monitor size={16} /> },
  { id: "notifications", label: "common.heading.notifications", icon: <Bell size={16} /> },
  { id: "billing", label: "profile.heading.billing", icon: <CreditCard size={16} /> },
  { id: "family", label: "profile.label.family", icon: <Users size={16} /> },
  { id: "about", label: "profile.heading.about", icon: <Info size={16} /> },
  { id: "help", label: "profile.heading.helpContact", icon: <HelpCircle size={16} /> },
  { id: "delete", label: "profile.heading.deleteAccount", icon: <AlertTriangle size={16} />, danger: true },
];

function isTab(v: string | null): v is Tab {
  return v !== null && TABS.some((tb) => tb.id === v);
}

/** classifyDeleteFailure()'s advice in the chosen language; server text (a blocker sentence, an unknown error) stays as sent. */
function deleteFailureText(t: T, f: DeleteFailure): string {
  switch (f.kind) {
    case "code_burned": return t("profile.error.tooManyTriesOnThatCodeRequestANew");
    case "rate_limited": return t("profile.error.tooManyAttemptsWaitAFewMinutesThenTry");
    case "wrong_code": return t("profile.error.thatCodeIsNotRightOrItHasExpired");
    case "blocked": return f.message;
    default: return f.message === "Could not delete your account. Please try again."
      ? t("profile.error.couldNotDeleteYourAccountPleaseTryAgain")
      : f.message;
  }
}

export function ProfilePage() {
  const t = useT();
  const { user, refreshUser } = useAuth();
  const queryClient = useQueryClient();
  // `?tab=about` lands the user on a section: the menu's Check for Updates
  // sends them to About to watch the check it just started.
  const location = useLocation();
  const requestedTab = new URLSearchParams(location.search).get("tab");
  // `?tab=help&chat=1` shows the live chat in place of the Help & contact list.
  const chatRequested = new URLSearchParams(location.search).get("chat") === "1";
  const chatUnread = useSupportChat((s) => s.unread);
  const chatOn = supportChatEnabled(user);
  const [tab, setTab] = useState<Tab>(() => (isTab(requestedTab) ? requestedTab : "identity"));
  useEffect(() => { if (isTab(requestedTab)) setTab(requestedTab); }, [requestedTab]);
  const [apiBase, setApiBase] = useState("");
  const distribution = useDistribution();
  // Prefetched so the rail knows whether to offer the tab; a free user with
  // nobody to manage gets no Family tab (nothing to do but buy, which the
  // store builds may not offer).
  const family = useQuery({ queryKey: FAMILY_KEY, queryFn: getFamily, staleTime: 30_000 });
  const showFamily = showsFamilyEntry(family.data);
  const activeTab: Tab = tab === "family" && !showFamily ? "identity" : tab;

  useEffect(() => {
    window.electronAPI.getApiBase().then(setApiBase);
  }, []);

  return (
    <div className="flex h-full gap-6" data-testid="profile-page">
      {/* Sidebar */}
      <div className="w-48 space-y-1">
        {/* No Billing tab on the Mac App Store build: Guideline 3.1.1, see
            store-surfaces.ts. The whole strip waits for the channel to arrive
            over IPC rather than rendering with the default: distribution is
            null for the first frame, showsBillingTab() is true for null, and a
            Billing tab that flashes once on a store build is exactly the
            surface the guideline is about. The empty rail holds its own width,
            so nothing jumps when the tabs appear. */}
        {distribution !== null &&
          TABS.filter((tb) => (tb.id !== "billing" || showsBillingTab(distribution)) && (tb.id !== "family" || showFamily)).map((tb) => (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                activeTab === tb.id
                  ? tb.danger
                    ? "bg-red-50 font-medium text-[var(--color-danger)]"
                    : "bg-[var(--color-primary)]/10 font-medium text-[var(--color-primary)]"
                  : tb.danger
                    ? "text-[var(--color-danger)] hover:bg-red-50"
                    : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
              }`}
            >
              {tb.icon}
              {t(tb.label)}
              {tb.id === "help" && chatOn && chatUnread > 0 && <UnreadBadge count={chatUnread} className="ms-auto" />}
            </button>
          ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === "identity" && <IdentitySection apiBase={apiBase} />}
        {activeTab === "appearance" && <AppearanceSection />}
        {activeTab === "password" && <PasswordSection />}
        {activeTab === "api-keys" && <ApiKeysSection />}
        {activeTab === "sessions" && <SessionsSection />}
        {activeTab === "notifications" && <NotificationsSection />}
        {activeTab === "billing" && showsBillingTab(distribution) && <BillingSection />}
        {activeTab === "family" && showFamily && <FamilySection showWebLink={distribution !== null && showsBillingTab(distribution)} />}
        {activeTab === "about" && <AboutSection />}
        {activeTab === "help" && <HelpSection chat={chatOn && chatRequested} chatOn={chatOn} />}
        {activeTab === "delete" && <DeleteSection />}
      </div>
    </div>
  );
}

// ── Appearance Section ──────────────────────────────────────────────
// Same 8 themes × light/dark/system offered on the web. Apply/persist/rollback
// live in useThemePref, shared with the titlebar's ThemeMenu so the two
// surfaces cannot drift.

const MODES: { value: Mode; label: MessageKey }[] = [
  { value: "light", label: "common.option.light" },
  { value: "dark", label: "common.option.dark" },
  { value: "system", label: "common.option.system" },
];

function AppearanceSection() {
  const t = useT();
  const { pref, save } = useThemePref();

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold">{t("common.label.appearance")}</h2>

      <LanguageSwitch />

      <ZoomControl />

      {/* Mode */}
      <div>
        <p className="text-sm font-medium mb-1">{t("profile.label.mode")}</p>
        <p className="mb-3 text-xs text-[var(--color-text-secondary)]">{t("profile.description.lightDarkOrFollowYourSystem")}</p>
        <div
          className="inline-flex gap-1 rounded-lg p-1"
          style={{ background: "var(--color-bg-tertiary)" }}
        >
          {MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => save({ ...pref, mode: m.value })}
              className={`rounded-md px-4 py-1.5 text-xs font-medium transition-colors ${
                pref.mode === m.value
                  ? ""
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              }`}
              style={
                pref.mode === m.value
                  ? { background: "var(--color-bg)", boxShadow: "0 1px 2px rgba(0,0,0,0.08)" }
                  : undefined
              }
            >
              {t(m.label)}
            </button>
          ))}
        </div>
      </div>

      {/* Theme */}
      <div>
        <p className="text-sm font-medium mb-1">{t("profile.label.theme")}</p>
        <p className="mb-3 text-xs text-[var(--color-text-secondary)]">
          {t("profile.description.appliesInstantlyAndSavesToYourAccountSoIt")}
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {THEMES.map((th) => (
            <button
              key={th.id}
              onClick={() => save({ ...pref, theme: th.id })}
              className="overflow-hidden rounded-lg border text-start transition-all"
              style={{
                borderColor: pref.theme === th.id ? "var(--color-primary)" : "var(--color-border)",
                boxShadow: pref.theme === th.id ? "0 0 0 1px var(--color-primary)" : undefined,
              }}
            >
              <div className="flex h-11 items-center gap-1.5 px-2.5" style={{ background: th.swatch.bg }}>
                <span className="h-4 w-4 rounded" style={{ background: th.swatch.primary }} />
                <span className="h-1.5 max-w-[42px] flex-1 rounded" style={{ background: th.swatch.accent }} />
              </div>
              <div className="flex items-center justify-between px-2.5 py-1.5 text-[11px] font-medium">
                {t(th.labelKey)}
                {pref.theme === th.id && <Check size={12} style={{ color: "var(--color-primary)" }} />}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/**
 * The interface zoom: the same zoom as the trackpad pinch and View > Zoom In /
 * Zoom Out, shown as a percentage with step buttons, for people who need the
 * app larger and for mouse users who cannot pinch. Main clamps and saves it.
 */
function ZoomControl() {
  const t = useT();
  const { locale } = useLocale();
  const [zoom, setZoom] = useState<number | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getZoom) return;
    let live = true;
    const read = () => api.getZoom().then((f) => { if (live) setZoom(f); }).catch(() => {});
    read();
    // A pinch or ⌘+ / ⌘− elsewhere resizes the viewport; follow it.
    window.addEventListener("resize", read);
    return () => { live = false; window.removeEventListener("resize", read); };
  }, []);

  if (zoom === null) return null;
  const apply = (factor: number) => { void window.electronAPI.setZoom(factor).then(setZoom).catch(() => {}); };
  const percent = new Intl.NumberFormat(intlTag(locale), { style: "percent", maximumFractionDigits: 0 }).format(zoom);
  const mod = IS_MAC ? "⌘" : "Ctrl+";
  const stepButton = "flex h-8 w-8 items-center justify-center rounded-lg border hover:bg-[var(--color-bg-secondary)] disabled:opacity-40";

  return (
    <div>
      <p className="mb-1 text-sm font-medium">{t("profile.label.zoom")}</p>
      <p className="mb-3 text-xs text-[var(--color-text-secondary)]">
        {t("profile.description.zoomHint", { zoomIn: `${mod}+`, zoomOut: `${mod}−` })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => apply(steppedZoom(zoom, -1))}
          disabled={zoom <= ZOOM_STEPS[0] + 0.005}
          aria-label={t("menus.action.zoomOut")}
          title={t("menus.action.zoomOut")}
          className={stepButton}
          style={{ borderColor: "var(--color-border)" }}
        >
          <Minus size={14} />
        </button>
        <span className="min-w-[4.5rem] text-center font-mono text-sm tabular-nums" aria-live="polite" data-testid="zoom-percent">
          {percent}
        </span>
        <button
          onClick={() => apply(steppedZoom(zoom, 1))}
          disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.005}
          aria-label={t("menus.action.zoomIn")}
          title={t("menus.action.zoomIn")}
          className={stepButton}
          style={{ borderColor: "var(--color-border)" }}
        >
          <Plus size={14} />
        </button>
        <button
          onClick={() => apply(1)}
          disabled={Math.abs(zoom - 1) < 0.005}
          className="rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-bg-secondary)] disabled:opacity-40"
          style={{ borderColor: "var(--color-border)" }}
        >
          {t("menus.action.actualSize")}
        </button>
      </div>
    </div>
  );
}

// ── Identity Section ────────────────────────────────────────────────

function IdentitySection({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { user, refreshUser } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const fileRef = useRef<HTMLInputElement>(null);
  const avatarVersion = useAvatarVersion((s) => s.version);
  const bumpAvatar = useAvatarVersion((s) => s.bump);

  // Email change state
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailStep, setEmailStep] = useState<"request" | "verify">("request");
  const [verifyCode, setVerifyCode] = useState("");

  const nameMut = useMutation({
    mutationFn: () => api.put("/api/me/name", { name }),
    onSuccess: () => { refreshUser(); toast.success(t("profile.label.nameUpdated")); },
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.failed")),
  });

  const avatarMut = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("avatar", file);
      return apiRequest("/api/me/avatar", { method: "POST", body: fd });
    },
    onSuccess: () => { bumpAvatar(); refreshUser(); toast.success(t("profile.label.avatarUpdated")); },
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.failed")),
  });

  const deleteAvatarMut = useMutation({
    mutationFn: () => api.delete("/api/me/avatar"),
    onSuccess: () => { bumpAvatar(); refreshUser(); toast.success(t("profile.label.avatarRemoved")); },
  });

  // Phase 1: request email change → sends code to new email
  const requestEmailMut = useMutation({
    mutationFn: () => api.put("/api/me/email", { email: newEmail, current_password: emailPassword }),
    onSuccess: () => {
      setEmailStep("verify");
      toast.success(t("profile.label.verificationCodeSentToYourNewEmail"));
    },
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.failed")),
  });

  // Phase 2: verify 6-digit code → swaps email
  const confirmEmailMut = useMutation({
    mutationFn: () => api.post("/api/me/email/confirm", { code: verifyCode }),
    onSuccess: () => {
      refreshUser();
      setShowEmailModal(false);
      resetEmailModal();
      toast.success(t("profile.label.emailAddressUpdated"));
    },
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.failed")),
  });

  function resetEmailModal() {
    setNewEmail("");
    setEmailPassword("");
    setVerifyCode("");
    setEmailStep("request");
  }

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold">{t("profile.heading.identity")}</h2>

      {/* Avatar */}
      <div className="flex items-center gap-5">
        <div className="relative group">
          {/* `apiBase` is primed over IPC and is "" on the first render. An
              avatar URL built from it is relative, resolves against
              app://bundle, and the protocol handler answers unknown paths
              with index.html - so the <img> would request the whole app
              bundle and fail to decode it. Same guard as ActivityPage. */}
          {user?.avatar_url && apiBase ? (
            <img
              src={avatarUrl(apiBase, user.id, avatarVersion)}
              alt={user.name}
              className="h-20 w-20 rounded-full object-cover"
            />
          ) : (
            <div
              className="flex h-20 w-20 items-center justify-center rounded-full text-2xl font-semibold text-[var(--color-primary-fg)]"
              style={{ background: "var(--color-primary)" }}
            >
              {user?.name?.charAt(0).toUpperCase() || "?"}
            </div>
          )}
          <button
            onClick={() => fileRef.current?.click()}
            className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Pencil size={16} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) avatarMut.mutate(file);
              e.target.value = "";
            }}
          />
        </div>
        <div>
          <p className="text-sm font-medium">{user?.name}</p>
          <p className="text-xs text-[var(--color-text-muted)]">
            {t("common.label.pngJPEGWebPOrGIFMax2MB")}
          </p>
          {user?.avatar_url && (
            <button
              onClick={() => deleteAvatarMut.mutate()}
              className="mt-1 text-xs text-[var(--color-danger)] hover:underline"
            >
              {t("profile.action.removeAvatar")}
            </button>
          )}
        </div>
      </div>

      {/* Name */}
      <div>
        <label className="mb-1 block text-sm font-medium">{t("profile.label.fullName")}</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
            style={{ borderColor: "var(--color-border)" }}
          />
          <button
            onClick={() => nameMut.mutate()}
            disabled={!name.trim() || name === user?.name || nameMut.isPending}
            className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
            style={{ background: "var(--color-primary)" }}
          >
            {nameMut.isPending ? t("profile.status.saving") : t("common.save")}
          </button>
        </div>
      </div>

      {/* Email */}
      <div>
        <label className="mb-1 block text-sm font-medium">{t("common.label.email")}</label>
        <div className="flex gap-2">
          <input
            type="email"
            value={user?.email ?? ""}
            disabled
            className="flex-1 rounded-lg border bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text-secondary)]"
            style={{ borderColor: "var(--color-border)" }}
          />
          <button
            onClick={() => setShowEmailModal(true)}
            className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-[var(--color-bg-secondary)]"
            style={{ borderColor: "var(--color-border)" }}
          >
            {t("profile.action.change")}
          </button>
        </div>
      </div>

      {/* Member since */}
      <div className="rounded-lg bg-[var(--color-bg-secondary)] px-4 py-3 text-sm text-[var(--color-text-secondary)]">
        {user?.created_at ? t("profile.label.memberSinceDate", { date: formatDate(user.created_at) }) : t("profile.label.memberSince")}
      </div>

      {/* Change Email Modal */}
      {showEmailModal && (
        <Modal onClose={() => { setShowEmailModal(false); resetEmailModal(); }}>
          {emailStep === "request" ? (
            <>
              <h3 className="mb-2 text-lg font-semibold">{t("profile.heading.changeEmail")}</h3>
              <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
                {t("profile.description.a6DigitVerificationCodeWillBeSentTo")}
              </p>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-sm font-medium">{t("profile.label.newEmail")}</label>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    autoFocus
                    placeholder={t("common.placeholder.youExampleCom")}
                    className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
                    style={{ borderColor: "var(--color-border)" }}
                  />
                </div>
                <PasswordInput label={t("profile.label.currentPassword")} value={emailPassword} onChange={setEmailPassword} autoComplete="current-password" />
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => { setShowEmailModal(false); resetEmailModal(); }} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>{t("common.cancel")}</button>
                <button
                  onClick={() => requestEmailMut.mutate()}
                  disabled={!newEmail.trim() || !emailPassword || requestEmailMut.isPending}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
                  style={{ background: "var(--color-primary)" }}
                >
                  {requestEmailMut.isPending ? t("common.status.sending") : t("profile.action.sendCode")}
                </button>
              </div>
            </>
          ) : (
            <>
              <h3 className="mb-2 text-lg font-semibold">{t("profile.heading.verifyNewEmail")}</h3>
              <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
                {richText(t, "profile.description.enterThe6DigitCodeSentToNewEmail", {}, { newEmail: <span className="font-medium">{newEmail}</span> })}
              </p>
              <div>
                <label className="mb-1 block text-sm font-medium">{t("common.label.verificationCode")}</label>
                <input
                  type="text"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  maxLength={6}
                  autoFocus
                  placeholder="000000"
                  className="w-full rounded-lg border px-3 py-2 text-center text-lg font-mono tracking-[0.3em] outline-none focus:border-[var(--color-primary)]"
                  style={{ borderColor: "var(--color-border)" }}
                />
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setEmailStep("request")} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>{t("common.back")}</button>
                <button
                  onClick={() => confirmEmailMut.mutate()}
                  disabled={verifyCode.length !== 6 || confirmEmailMut.isPending}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
                  style={{ background: "var(--color-primary)" }}
                >
                  {confirmEmailMut.isPending ? t("common.status.verifying") : t("profile.action.verifyUpdate")}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

// ── Password & 2FA Section ──────────────────────────────────────────

function PasswordSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const [showPwModal, setShowPwModal] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");

  // 2FA state
  const [tfaModal, setTfaModal] = useState<"setup-totp" | "verify-totp" | "recovery" | "disable" | "regen" | null>(null);
  const [totpSecret, setTotpSecret] = useState("");
  const [totpUri, setTotpUri] = useState("");
  const [totpQr, setTotpQr] = useState("");
  const [totpCode, setTotpCode] = useState("");

  // Generate the authenticator QR locally (main process) whenever a new
  // otpauth URI is issued. The secret never leaves the device.
  useEffect(() => {
    if (!totpUri) { setTotpQr(""); return; }
    let cancelled = false;
    window.electronAPI.generateTotpQr(totpUri)
      .then((url) => { if (!cancelled) setTotpQr(url); })
      .catch(() => { if (!cancelled) setTotpQr(""); });
    return () => { cancelled = true; };
  }, [totpUri]);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [disablePw, setDisablePw] = useState("");
  const [regenPw, setRegenPw] = useState("");

  const { data: tfaStatus, refetch: refetchTfa } = useQuery({
    queryKey: ["2fa-status"],
    queryFn: () => api.get<{ ok: boolean; method: string | null; totp_enabled: boolean; recovery_codes_remaining: number }>("/api/me/2fa/status"),
  });

  const changePwMut = useMutation({
    mutationFn: () => api.put("/api/me/password", { current_password: currentPw, new_password: newPw }),
    onSuccess: () => {
      setShowPwModal(false); setCurrentPw(""); setNewPw(""); setConfirmPw("");
      toast.success(t("profile.label.passwordChangedOtherSessionsHaveBeenRevoked"));
    },
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.failed")),
  });

  const setupTotpMut = useMutation({
    mutationFn: () => api.post<{ ok: boolean; secret: string; uri: string }>("/api/me/2fa/setup-totp"),
    onSuccess: (data) => { setTotpSecret(data.secret); setTotpUri(data.uri); setTfaModal("verify-totp"); },
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.failed")),
  });

  const verifyTotpMut = useMutation({
    mutationFn: () => api.post<{ ok: boolean; recovery_codes: string[] }>("/api/me/2fa/verify-totp", { code: totpCode }),
    onSuccess: (data) => { setRecoveryCodes(data.recovery_codes); setTotpCode(""); setTfaModal("recovery"); refetchTfa(); },
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("profile.error.invalidCode")),
  });

  const enableEmailMut = useMutation({
    mutationFn: () => api.post("/api/me/2fa/enable-email"),
    onSuccess: () => { toast.success(t("profile.label.emailBased2FAEnabled")); refetchTfa(); },
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.failed")),
  });

  const disableMut = useMutation({
    mutationFn: () => api.post("/api/me/2fa/disable", { password: disablePw }),
    onSuccess: () => { setTfaModal(null); setDisablePw(""); toast.success(t("profile.label.twoFactorAuthenticationDisabled")); refetchTfa(); },
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.failed")),
  });

  const regenMut = useMutation({
    mutationFn: () => api.post<{ ok: boolean; recovery_codes: string[] }>("/api/me/2fa/recovery-codes", { password: regenPw }),
    onSuccess: (data) => { setRecoveryCodes(data.recovery_codes); setRegenPw(""); setTfaModal("recovery"); },
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.failed")),
  });

  const pwError = newPw ? passwordError(newPw) : null;
  const mismatch = confirmPw && newPw !== confirmPw;

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold">{t("profile.heading.password2FA")}</h2>

      {/* Change password */}
      <div className="rounded-xl border p-5" style={{ borderColor: "var(--color-border)" }}>
        <h3 className="mb-1 text-sm font-semibold">{t("common.label.password")}</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">{t("profile.description.changeYourPasswordThisWillRevokeAllOtherSessions")}</p>
        <button onClick={() => setShowPwModal(true)} className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>{t("profile.action.changePassword")}</button>
      </div>

      {/* 2FA */}
      <div className="rounded-xl border p-5" style={{ borderColor: "var(--color-border)" }}>
        <h3 className="mb-3 text-sm font-semibold">{t("common.heading.twoFactorAuthentication")}</h3>

        {tfaStatus?.method ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Shield size={16} className="text-[var(--color-primary)]" />
              <span className="font-medium">
                {tfaStatus.totp_enabled ? t("profile.label.authenticatorAppEnabled") : t("profile.label.emailBased2FAEnabled")}
              </span>
            </div>
            {tfaStatus.totp_enabled && (
              <p className="text-xs text-[var(--color-text-muted)]">
                {t("profile.description.recoverycodesremainingRecoveryCodesRemaining", { recoveryCodesRemaining: tfaStatus.recovery_codes_remaining })}
              </p>
            )}
            <div className="flex gap-2">
              {tfaStatus.totp_enabled && (
                <button onClick={() => setTfaModal("regen")} className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>
                  {t("profile.action.regenerateRecoveryCodes")}
                </button>
              )}
              <button onClick={() => setTfaModal("disable")} className="rounded-lg border px-3 py-1.5 text-xs font-medium text-[var(--color-danger)] hover:bg-red-50" style={{ borderColor: "var(--color-border)" }}>
                {t("profile.action.disable2FA")}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-[var(--color-text-muted)]">{t("profile.description.twoFactorAuthenticationIsNotEnabledEnableItForExtraSecurity")}</p>
            <div className="flex gap-2">
              <button onClick={() => setupTotpMut.mutate()} disabled={setupTotpMut.isPending} className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
                {setupTotpMut.isPending ? t("profile.status.settingUp") : t("profile.action.setUpAuthenticatorApp")}
              </button>
              <button onClick={() => enableEmailMut.mutate()} disabled={enableEmailMut.isPending} className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>
                {enableEmailMut.isPending ? t("profile.status.enabling") : t("profile.action.useEmailInstead")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Change Password Modal */}
      {showPwModal && (
        <Modal onClose={() => setShowPwModal(false)}>
          <h3 className="mb-4 text-lg font-semibold">{t("profile.heading.changePassword")}</h3>
          <div className="space-y-3">
            <PasswordInput label={t("profile.label.currentPassword")} value={currentPw} onChange={setCurrentPw} autoComplete="current-password" />
            <div>
              <PasswordInput label={t("common.label.newPassword")} value={newPw} onChange={setNewPw} autoComplete="new-password" />
              {pwError && <p className="mt-1 text-xs text-[var(--color-danger)]">{pwError}</p>}
            </div>
            <div>
              <PasswordInput label={t("profile.label.confirmNewPassword")} value={confirmPw} onChange={setConfirmPw} autoComplete="new-password" />
              {mismatch && <p className="mt-1 text-xs text-[var(--color-danger)]">{t("common.error.passwordsDonTMatch")}</p>}
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => setShowPwModal(false)} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>{t("common.cancel")}</button>
            <button onClick={() => changePwMut.mutate()} disabled={!currentPw || !newPw || !!pwError || mismatch || changePwMut.isPending} className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
              {changePwMut.isPending ? t("profile.status.changing") : t("profile.action.changePassword")}
            </button>
          </div>
        </Modal>
      )}

      {/* TOTP Verify Modal */}
      {tfaModal === "verify-totp" && (
        <Modal onClose={() => setTfaModal(null)}>
          <h3 className="mb-2 text-lg font-semibold">{t("profile.heading.setUpAuthenticator")}</h3>
          <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
            {t("profile.description.scanThisQRCodeWithYourAuthenticatorAppGoogle")}
          </p>
          <div className="mb-4 flex justify-center rounded-lg bg-[var(--color-bg-tertiary)] p-4">
            {totpQr ? (
              <img src={totpQr} alt={t("profile.accessibility.authenticatorQRCode")} className="h-44 w-44" />
            ) : (
              <div className="flex h-44 w-44 items-center justify-center text-xs text-[var(--color-text-muted)]">
                {t("profile.status.generatingQR")}
              </div>
            )}
          </div>
          <details className="mb-4">
            <summary className="cursor-pointer text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">{t("profile.action.canTScanEnterKeyManually")}</summary>
            <div className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--color-bg-tertiary)] px-3 py-2">
              <code className="flex-1 break-all text-xs font-mono">{totpSecret}</code>
              <button onClick={() => { navigator.clipboard.writeText(totpSecret); toast.success(t("common.status.copied")); }} className="rounded p-1 hover:bg-black/5"><Copy size={12} /></button>
            </div>
          </details>
          <div className="mb-4">
            <label className="mb-1 block text-sm font-medium">{t("common.label.sixDigitCode")}</label>
            <input type="text" value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))} maxLength={6} autoFocus placeholder="000000" className="w-full rounded-lg border px-3 py-2 text-center text-lg font-mono tracking-[0.3em] outline-none focus:border-[var(--color-primary)]" style={{ borderColor: "var(--color-border)" }} />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setTfaModal(null)} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>{t("common.cancel")}</button>
            <button onClick={() => verifyTotpMut.mutate()} disabled={totpCode.length !== 6 || verifyTotpMut.isPending} className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
              {verifyTotpMut.isPending ? t("common.status.verifying") : t("profile.action.verifyEnable")}
            </button>
          </div>
        </Modal>
      )}

      {/* Recovery Codes Modal */}
      {tfaModal === "recovery" && (
        <Modal onClose={() => setTfaModal(null)}>
          <h3 className="mb-2 text-lg font-semibold">{t("profile.heading.recoveryCodes")}</h3>
          <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
            {t("profile.description.saveTheseCodesInASafePlaceEachCode")}
          </p>
          <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg bg-[var(--color-bg-tertiary)] p-4">
            {recoveryCodes.map((code, i) => (
              <code key={i} className="text-sm font-mono">{code}</code>
            ))}
          </div>
          <div className="mb-4 flex gap-2">
            <button onClick={() => { navigator.clipboard.writeText(recoveryCodes.join("\n")); toast.success(t("profile.status.copiedAll")); }} className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>
              <Copy size={12} /> {t("profile.action.copyAll")}
            </button>
            <button onClick={() => {
              const blob = new Blob([recoveryCodes.join("\n")], { type: "text/plain" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a"); a.href = url; a.download = "dosya-recovery-codes.txt"; a.click();
              URL.revokeObjectURL(url);
            }} className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]" style={{ borderColor: "var(--color-border)" }}>
              <Download size={12} /> {t("common.action.download")}
            </button>
          </div>
          <button onClick={() => setTfaModal(null)} className="w-full rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)]" style={{ background: "var(--color-primary)" }}>
            {t("profile.action.iVeSavedTheseCodes")}
          </button>
        </Modal>
      )}

      {/* Disable 2FA Modal */}
      {tfaModal === "disable" && (
        <Modal onClose={() => { setTfaModal(null); setDisablePw(""); }}>
          <h3 className="mb-2 text-lg font-semibold">{t("profile.heading.disable2FA")}</h3>
          <p className="mb-4 text-sm text-[var(--color-text-secondary)]">{t("profile.description.enterYourPasswordToDisableTwoFactorAuthentication")}</p>
          <PasswordInput label={t("common.label.password")} value={disablePw} onChange={setDisablePw} autoComplete="current-password" />
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => { setTfaModal(null); setDisablePw(""); }} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>{t("common.cancel")}</button>
            <button onClick={() => disableMut.mutate()} disabled={!disablePw || disableMut.isPending} className="rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {disableMut.isPending ? t("profile.status.disabling") : t("profile.action.disable2FA")}
            </button>
          </div>
        </Modal>
      )}

      {/* Regenerate Recovery Codes Modal */}
      {tfaModal === "regen" && (
        <Modal onClose={() => { setTfaModal(null); setRegenPw(""); }}>
          <h3 className="mb-2 text-lg font-semibold">{t("profile.heading.regenerateRecoveryCodes")}</h3>
          <p className="mb-4 text-sm text-[var(--color-text-secondary)]">{t("profile.description.thisWillInvalidateYourExistingCodesEnterYourPassword")}</p>
          <PasswordInput label={t("common.label.password")} value={regenPw} onChange={setRegenPw} autoComplete="current-password" />
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => { setTfaModal(null); setRegenPw(""); }} className="rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "var(--color-border)" }}>{t("common.cancel")}</button>
            <button onClick={() => regenMut.mutate()} disabled={!regenPw || regenMut.isPending} className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50" style={{ background: "var(--color-primary)" }}>
              {regenMut.isPending ? t("profile.status.regenerating") : t("profile.action.regenerateCodes")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── API Keys Section ────────────────────────────────────────────────

function ApiKeysSection() {
  const t = useT();
  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold">{t("profile.heading.apiKeys")}</h2>
      <div className="rounded-xl border p-6 text-center" style={{ borderColor: "var(--color-border)" }}>
        <Key size={32} className="mx-auto mb-3 text-[var(--color-text-muted)]" />
        <h3 className="text-sm font-semibold">{t("profile.heading.manageAPIKeys")}</h3>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          {t("profile.description.generateAndManageAPIKeysOnTheWebApp")}
        </p>
        <button
          onClick={() => window.open(webAppUrl("/profile"), "_blank")}
          className="mt-4 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)]"
          style={{ background: "var(--color-primary)" }}
        >
          <ExternalLink size={14} />
          {t("common.action.openOnWeb")}
        </button>
      </div>
    </div>
  );
}

// ── Sessions Section ────────────────────────────────────────────────

function SessionsSection() {
  const t = useT();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.get<{ ok: boolean; sessions: { id: string; device: string; kind: string; browser: string; meta: string; is_current: boolean; created_at: number }[] }>("/api/me/sessions"),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/me/sessions/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["sessions"] }); toast.success(t("profile.label.sessionRevoked")); },
    onError: (e) => toast.error(e instanceof ApiError ? autoDir(e.message) : t("common.error.failed")),
  });

  const revokeAllMut = useMutation({
    mutationFn: () => api.delete("/api/me/sessions"),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["sessions"] }); toast.success(t("profile.label.allOtherSessionsRevoked")); },
  });

  const sessions = data?.sessions ?? [];
  const DeviceIcon = ({ kind }: { kind: string }) => {
    if (kind === "mobile") return <Smartphone size={18} className="text-[var(--color-text-muted)]" />;
    if (kind === "desktop") return <Laptop size={18} className="text-[var(--color-text-muted)]" />;
    return <Globe size={18} className="text-[var(--color-text-muted)]" />;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("profile.heading.sessions")}</h2>
        {sessions.length > 1 && (
          <button onClick={() => revokeAllMut.mutate()} className="text-xs text-[var(--color-danger)] hover:underline">
            {t("profile.action.revokeAllOtherSessions")}
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="h-16 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />)}</div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center gap-4 rounded-xl border px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
              <DeviceIcon kind={s.kind} />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{s.device} - {s.browser}</p>
                  {s.is_current && (
                    <span className="rounded-full bg-[var(--color-primary)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-primary)]">{t("profile.status.current")}</span>
                  )}
                </div>
                <p className="text-xs text-[var(--color-text-muted)]">{s.meta}</p>
              </div>
              {!s.is_current && (
                <button onClick={() => revokeMut.mutate(s.id)} className="rounded p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"><Trash2 size={14} /></button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Notifications Section ───────────────────────────────────────────

/**
 * No hard-coded switch list here any more.
 *
 * It used to be 15 legacy type keys - a subset of web's 18, chosen by whoever
 * copied the file - and every one of them named a preference the server stopped
 * storing at migration 0112. The list comes from GET /api/me/notifications now,
 * so all three clients render the same 14 groups from one description.
 */
interface NotifGroup {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  alwaysOn: "all" | "some" | "none";
  note: string | null;
  options: { key: string; label: string; description: string; enabled: boolean }[];
}

function GroupSwitch({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"} ${disabled ? "opacity-50" : ""}`}
    >
      {/* rtl-ok: mirrored, the rtl: twin slides the knob the other way */}
      <div className={`absolute top-0.5 h-5 w-5 rounded-full bg-[var(--color-bg)] shadow transition-transform ${on ? "translate-x-5 rtl:-translate-x-5" : "translate-x-0.5 rtl:-translate-x-0.5"}`} />
    </button>
  );
}

function NotificationsSection() {
  const t = useT();
  const [groups, setGroups] = useState<NotifGroup[]>([]);
  const loaded = useRef(false);

  const { data } = useQuery({
    queryKey: ["notification-prefs"],
    queryFn: () => api.get<{ ok: boolean; groups: NotifGroup[] }>("/api/me/notifications"),
  });

  if (data?.groups && !loaded.current) {
    setGroups(data.groups);
    loaded.current = true;
  }

  /**
   * ONE key per request, and this is the fix, not a tidy-up.
   *
   * This mutation used to send `{ ...prefs, [key]: !prefs[key] }` - the entire
   * preference map on every toggle. When GET grew from 25 keys to 39, that map
   * started echoing the group keys back at their stored values, which overwrote
   * the single key the user had actually moved: every desktop toggle silently
   * did nothing, in both directions, until the server learned to ignore echoed
   * keys. The echo filter still protects old builds, but a whole-map write is
   * also a stale-map race - two open sessions, and whatever the other one
   * changed comes back at the value this window loaded with.
   */
  const saveMut = useMutation({
    mutationFn: (change: { key: string; value: boolean }) =>
      api.put("/api/me/notifications", { preferences: { [change.key]: change.value } }),
    onSuccess: () => toast.success(t("profile.label.preferencesSaved")),
  });

  const setValue = (key: string, value: boolean) =>
    setGroups((gs) => gs.map((g) => (
      g.key === key
        ? { ...g, enabled: value }
        : { ...g, options: g.options.map((o) => (o.key === key ? { ...o, enabled: value } : o)) }
    )));

  const toggle = (key: string, next: boolean) => {
    setValue(key, next);
    // Revert the optimistic switch if the save fails, so the UI never lies
    // about a preference the server didn't actually record.
    saveMut.mutate({ key, value: next }, {
      onError: (e) => {
        setValue(key, !next);
        toast.error(e instanceof ApiError ? autoDir(e.message) : t("profile.error.couldnTSaveYourPreferences"));
      },
    });
  };

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold">{t("common.heading.notifications")}</h2>
      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.key} data-testid={`notif-group-${g.key}`}>
            <div className="flex items-start justify-between gap-4 rounded-lg px-1 py-1.5">
              <div className="min-w-0">
                <p className="text-sm font-medium">{g.label}</p>
                <p className="text-xs text-[var(--color-text-secondary)]">{g.description}</p>
                {g.note && <p className="mt-0.5 text-xs italic text-[var(--color-text-secondary)]">{g.note}</p>}
              </div>
              {g.alwaysOn === "all" ? (
                <span className="shrink-0 text-xs text-[var(--color-text-secondary)]">{t("profile.label.alwaysOn")}</span>
              ) : (
                <GroupSwitch on={g.enabled} onClick={() => toggle(g.key, !g.enabled)} />
              )}
            </div>
            {g.options.length > 0 && (
              <div className="ms-3 border-s border-[var(--color-border)] ps-3">
                {g.options.map((o) => (
                  <div key={o.key} className="flex items-start justify-between gap-4 px-1 py-1.5">
                    <div className="min-w-0">
                      <p className="text-xs font-medium">{o.label}</p>
                      <p className="text-xs text-[var(--color-text-secondary)]">{o.description}</p>
                    </div>
                    {/* A sub-switch under a muted group can only lie: the group
                        gate runs first, whatever this says. */}
                    <GroupSwitch on={o.enabled} disabled={!g.enabled} onClick={() => toggle(o.key, !o.enabled)} />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Delete Account Section ──────────────────────────────────────────

// ── Billing Section ──────────────────────────────────────────────────

function BillingSection() {
  const t = useT();
  const openBilling = () => {
    window.open(webAppUrl("/billing"), "_blank");
  };

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold">{t("profile.heading.billing")}</h2>
      <div className="rounded-xl border p-6 text-center" style={{ borderColor: "var(--color-border)" }}>
        <CreditCard size={32} className="mx-auto mb-3 text-[var(--color-text-muted)]" />
        <h3 className="text-sm font-semibold">{t("profile.heading.manageYourSubscription")}</h3>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          {t("profile.description.billingInvoicesAndPlanManagementAreAvailableOnThe")}
        </p>
        <button
          onClick={openBilling}
          className="mt-4 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)]"
          style={{ background: "var(--color-primary)" }}
        >
          <ExternalLink size={14} />
          {t("profile.action.openBillingOnWeb")}
        </button>
      </div>
    </div>
  );
}

// ── Help Section ─────────────────────────────────────────────────────

const HELP_LINKS: { label: MessageKey; desc: MessageKey; url: string }[] = [
  { label: "profile.label.helpCenter", desc: "profile.label.browseGuidesAndFAQs", url: "https://dosya.dev/help" },
  { label: "profile.label.contactSupport", desc: "profile.label.getInTouchWithOurTeam", url: "https://dosya.dev/contact" },
  { label: "profile.label.apiDocumentation", desc: "profile.label.developerDocsAndAPIReference", url: "https://dosya.dev/developer/api" },
  { label: "profile.label.privacyPolicy", desc: "profile.label.howWeHandleYourData", url: "https://dosya.dev/privacy-policy" },
  { label: "profile.label.termsOfService", desc: "profile.label.ourTermsAndConditions", url: "https://dosya.dev/terms-of-service" },
];

function HelpSection({ chat, chatOn }: { chat: boolean; chatOn: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  if (chat) return <ChatView onBack={() => navigate("/profile?tab=help")} />;
  return (
    <div className="max-w-lg space-y-4">
      <h2 className="text-lg font-semibold">{t("profile.heading.helpContact")}</h2>
      {chatOn && <LiveChatRow onOpen={() => navigate(LIVE_CHAT_PATH)} />}
      {HELP_LINKS.map((item) => (
        <button
          key={item.url}
          onClick={() => window.open(item.url, "_blank")}
          className="flex w-full items-center justify-between rounded-xl border p-4 text-start hover:bg-[var(--color-bg-secondary)] transition-colors"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div>
            <p className="text-sm font-medium">{t(item.label)}</p>
            <p className="text-xs text-[var(--color-text-muted)]">{t(item.desc)}</p>
          </div>
          <ExternalLink size={14} className="text-[var(--color-text-muted)]" />
        </button>
      ))}
    </div>
  );
}

/**
 * First row of Help & contact. Shows who is around, and turns red with the start
 * of the newest reply while one is unseen.
 */
function LiveChatRow({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const unread = useSupportChat((s) => s.unread);
  const lastReply = useSupportChat((s) => s.lastReply);
  const persona = useSupportChat((s) => s.persona);
  const hot = unread > 0;

  let desc: string;
  if (hot && lastReply?.body) desc = `${lastReply.name ?? t("support-chat.heading.dosyaSupport")}: ${lastReply.body}`;
  // Support always reads as available: never "Away".
  else if (persona) desc = t("support-chat.status.personaIsOnline", { name: persona.name });
  else desc = t("support-chat.status.onlineUsuallyRepliesInAFewMinutes");

  return (
    <button
      type="button"
      data-testid="help-live-chat"
      onClick={onOpen}
      className="flex w-full items-center justify-between gap-3 rounded-xl border p-4 text-start transition-colors hover:bg-[var(--color-bg-secondary)]"
      style={hot
        ? { borderColor: "var(--color-danger)", background: "color-mix(in oklab, var(--color-danger) 7%, var(--color-bg))" }
        : { borderColor: "var(--color-border)" }}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium">
          <PresenceDot online />
          {t("common.action.liveChat")}
        </p>
        <p className={`truncate text-xs ${hot ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]"}`} dir="auto">{desc}</p>
      </div>
      {hot ? <UnreadBadge count={unread} /> : <ChevronRight size={14} className="shrink-0 text-[var(--color-text-muted)] rtl:-scale-x-100" />}
    </button>
  );
}

// ── Delete Account Section ──────────────────────────────────────────

function DeleteSection() {
  const t = useT();
  const [preview, setPreview] = useState<AccountDeletePreview | null>(null);
  const [step, setStep] = useState<"idle" | "code">("idle");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduledFor, setScheduledFor] = useState<number | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);

  const load = async () => {
    try {
      const res = await api.get<{ ok: boolean } & AccountDeletePreview>("/api/me/delete-preview");
      if (res.ok) { setPreview(res); setScheduledFor(res.deletion_scheduled_for); }
    } catch { /* the section still renders; the action reports its own error */ }
  };

  useEffect(() => { void load(); }, []);

  // A live countdown rather than a dead button: the server rejects a resend
  // inside its cooldown, so the control has to say when it will work.
  useEffect(() => {
    if (sentAt == null) return;
    const update = () => setRemaining(deleteCooldownRemaining(sentAt, Date.now()));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [sentAt]);

  const blockers = preview?.blockers ?? [];
  const nowSeconds = Math.floor(Date.now() / 1000);

  const requestCode = async () => {
    setError(null); setBusy(true);
    try {
      await api.post("/api/me/delete-request");
      setSentAt(Date.now());
      setStep("code");
    } catch (e) { setError(deleteFailureText(t, classifyDeleteFailure(e))); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    setError(null); setBusy(true);
    try {
      const res = await api.delete<{ ok: boolean; deletion_scheduled_for: number }>("/api/me", { code });
      setScheduledFor(res.deletion_scheduled_for);
      setStep("idle");
      toast.success(t("profile.label.deletionScheduled"), {
        description: t("profile.description.youHaveBeenSignedOutEverywhereSignInAgain"),
      });
    } catch (e) {
      const f = classifyDeleteFailure(e);
      if (f.kind === "code_burned") setCode("");
      setError(deleteFailureText(t, f));
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    setError(null); setBusy(true);
    try {
      await api.post("/api/me/delete-cancel");
      setScheduledFor(null);
      toast.success(t("profile.label.deletionCancelled"), { description: t("profile.description.yourAccountWillNotBeDeleted") });
      await load();
    } catch (e) { setError(deleteFailureText(t, classifyDeleteFailure(e))); }
    finally { setBusy(false); }
  };

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold">{t("profile.heading.dangerZone")}</h2>

      <div className="rounded-xl border-2 border-dashed p-6" style={{ borderColor: "var(--color-danger)" }}>
        <h3 className="mb-2 font-semibold text-[var(--color-danger)]">{t("profile.heading.deleteAccount")}</h3>

        {error && <p className="mb-3 text-xs text-[var(--color-danger)]" data-testid="delete-error">{error}</p>}

        {scheduledFor != null ? (
          <div data-testid="delete-scheduled">
            <p className="mb-1 text-sm font-medium">{t("profile.label.deletionScheduled")}</p>
            <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
              {/* packages/shared formatDeletionDate's long date, in the chosen language. */}
              {richText(
                t,
                "profile.description.yourAccountAndItsFilesWillBeDeletedOn",
                { days: deletionDaysRemaining(scheduledFor, nowSeconds) },
                { scheduledFor: <span className="font-medium text-[var(--color-text)]">{formatters().formatDate(scheduledFor, "long")}</span> },
              )}
            </p>
            <button
              onClick={cancel} disabled={busy} data-testid="cancel-deletion"
              className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-black/5 disabled:opacity-60"
              style={{ borderColor: "var(--color-border)" }}
            >
              {t("profile.action.cancelDeletion")}
            </button>
          </div>
        ) : step === "code" ? (
          <div data-testid="delete-code-step">
            <p className="mb-3 text-sm text-[var(--color-text-secondary)]">
              {t("profile.description.weEmailedYouADeleteCodeLengthDigitCodeEnteringIt", { deleteCodeLength: DELETE_CODE_LENGTH })}
            </p>
            <div className="flex items-center gap-2">
              <input
                value={code}
                onChange={(e) => setCode(normaliseDeleteCode(e.target.value))}
                placeholder="000000"
                inputMode="numeric"
                data-testid="delete-code"
                className="w-28 rounded-lg border px-2 py-2 text-center font-mono tracking-[0.3em] text-sm"
                style={{ borderColor: "var(--color-border)", background: "transparent" }}
              />
              <button
                onClick={confirm}
                disabled={!isCompleteDeleteCode(code) || busy}
                data-testid="confirm-delete"
                className="rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                {t("profile.action.deleteMyAccount")}
              </button>
              {remaining > 0 ? (
                <span className="text-xs text-[var(--color-text-secondary)]" data-testid="resend-countdown">
                  {t("profile.label.resendInRemainingS", { remaining })}
                </span>
              ) : (
                <button onClick={requestCode} data-testid="resend" className="text-xs underline text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">
                  {t("profile.action.resendCode")}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div>
            <p className="mb-3 text-sm text-[var(--color-text-secondary)]">
              {t("profile.description.scheduledForWindowDaysDaysLaterSoYouCanCancel", {
                windowDays: preview?.window_days ?? 30,
                workspaceCount: preview?.workspaces.length ?? 0,
                fileCount: preview?.file_count ?? 0,
              })}
            </p>
            {blockers.length > 0 && (
              <ul className="mb-3 space-y-1" data-testid="delete-blockers">
                {blockers.map((b) => (
                  <li key={b.workspace_id} className="text-xs text-[var(--color-text-secondary)]">
                    {t("profile.error.workspaceStillHasOtherMemberTransferItOrRemove", { workspace: b.workspace_name, count: b.member_count })}
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={requestCode}
              disabled={blockers.length > 0 || busy}
              data-testid="start-delete"
              className="rounded-lg bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {t("profile.action.deleteMyAccount")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── About Section ───────────────────────────────────────────────────

type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string }
  | { state: "installing"; version: string }
  | { state: "error"; message: string }
  | { state: "not-available" };

/** The desktop app's public (source-available) repository. */
const DESKTOP_SOURCE_URL = "https://github.com/dosya-dev/desktop";

function AboutSection() {
  const t = useT();
  const { user } = useAuth();
  const { locale } = useLocale();
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [sync, setSync] = useState<SyncSummaryInput | null>(null);
  const [finder, setFinder] = useState<{ available: boolean; enabled: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showAck, setShowAck] = useState(false);
  const distribution = useDistribution();

  useEffect(() => {
    const api = window.electronAPI;
    let live = true;
    api.getAboutInfo().then((i) => { if (live) setInfo(i); }).catch(() => {});
    api.getUpdateStatus().then((s) => { if (live) setStatus(s); }).catch(() => {});
    api.getSyncStatus().then((s) => { if (live) setSync(s); }).catch(() => {});
    Promise.resolve(api.fileProvider?.status()).then((f) => { if (live && f) setFinder(f); }).catch(() => {});
    const offUpdate = api.onUpdateStatusChanged(setStatus);
    const offSync = api.onSyncStatusChanged((s: SyncSummaryInput) => setSync(s));
    return () => { live = false; offUpdate(); offSync(); };
  }, []);

  const isLinux = info?.platform === "linux";
  const rows: AboutRow[] = [
    ...aboutRows(t, info, user?.email, sync, finder, { engine: false }),
    [t("appearance.label.language"), LOCALE_LABELS[locale]],
  ];

  // Copy Details goes to support, so it is always English (as in the About window).
  const copyDetails = async () => {
    const english = makeT("en", en, en);
    try {
      await navigator.clipboard.writeText(detailsText(english, info, aboutRows(english, info, user?.email, sync, finder)));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const link = (label: string, href: string) => (
    <a key={href} href={href} target="_blank" rel="noreferrer" className="text-[var(--color-text)] underline decoration-[var(--color-border)] underline-offset-[3px] hover:decoration-current">
      {label}
    </a>
  );

  return (
    <div className="max-w-xl space-y-5">
      <h2 className="text-lg font-semibold">{t("profile.heading.about")}</h2>

      {/* This app: version, details, update */}
      <div className="space-y-4 rounded-xl border p-5" style={{ borderColor: "var(--color-border)" }}>
        <div className="flex items-center gap-3.5">
          <img src={appIcon} alt="" width={52} height={52} className="rounded-xl" />
          <div>
            <h3 className="text-lg font-bold tracking-tight">{t("profile.heading.dosyaDesktop")}</h3>
            <p className="font-mono text-xs text-[var(--color-text-secondary)]" data-testid="profile-about-version">
              {t("common.description.versionVersion", { version: info?.version || "-" })}
            </p>
          </div>
        </div>

        <dl className="divide-y divide-[var(--color-border)]">
          {rows.map(([k, v, ok]) => (
            <div key={k} className="flex items-center justify-between gap-4 py-2 text-[13px]">
              <dt className="text-[var(--color-text-secondary)]">{k}</dt>
              <dd className={`min-w-0 break-words text-end font-mono text-xs ${ok ? "text-[var(--color-success,var(--color-primary))]" : ""}`}>{v}</dd>
            </div>
          ))}
        </dl>

        <div className="flex flex-wrap items-center gap-2">
          {/* Store builds are updated by their store; the version line stays, the controls go. */}
          {showsUpdateControls(distribution) && (status.state === "ready" ? (
            isLinux ? (
              <button
                onClick={() => window.electronAPI.showUpdateFile()}
                className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)]"
                style={{ background: "var(--color-primary)" }}
              >
                <ExternalLink size={14} />
                {t("profile.action.showDownloadedFile")}
              </button>
            ) : (
              <button
                onClick={() => window.electronAPI.installUpdate()}
                className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)]"
                style={{ background: "var(--color-primary)" }}
              >
                <ArrowDownCircle size={14} />
                {t("profile.action.installRestart")}
              </button>
            )
          ) : status.state === "installing" || status.state === "checking" || status.state === "downloading" ? (
            <button disabled className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>
              <Loader2 size={14} className="animate-spin" />
              {status.state === "installing"
                ? t("profile.status.installing")
                : status.state === "checking"
                  ? t("profile.status.checking")
                  : t("common.label.downloadingPercent", { percent: status.percent })}
            </button>
          ) : (
            <button
              onClick={() => window.electronAPI.checkForUpdates()}
              className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)]"
              style={{ background: "var(--color-primary)" }}
            >
              <RefreshCw size={14} />
              {t("common.action.checkForUpdates")}
            </button>
          ))}
          <button
            onClick={copyDetails}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-bg-secondary)]"
            style={{ borderColor: "var(--color-border)" }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? t("about.action.copied") : t("about.action.copyDetails")}
          </button>
          <a
            href={DESKTOP_SOURCE_URL}
            target="_blank"
            rel="noreferrer"
            title={DESKTOP_SOURCE_URL}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-bg-secondary)]"
            style={{ borderColor: "var(--color-border)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            {t("profile.action.sourceCode")}
          </a>
        </div>

        {/* Status message */}
        {status.state === "ready" && (
          <div className="flex items-center gap-2 rounded-lg bg-[var(--color-primary)]/10 px-3 py-2 text-sm text-[var(--color-primary)]">
            <ArrowDownCircle size={14} />
            {isLinux
              ? t("profile.label.versionVersionDownloadedOpenTheFileToInstallManually", { version: status.version })
              : t("common.label.versionVersionIsReadyToInstall", { version: status.version })}
          </div>
        )}
        {status.state === "installing" && (
          <div className="flex items-center gap-2 rounded-lg bg-[var(--color-primary)]/10 px-3 py-2 text-sm text-[var(--color-primary)]">
            <Loader2 size={14} className="animate-spin" />
            {t("common.label.installingVersionVersionDosyaWillReopenInAMoment", { version: status.version })}
          </div>
        )}
        {status.state === "not-available" && (
          <div className="flex items-center gap-2 rounded-lg bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-success,var(--color-primary))]">
            <CheckCircle size={14} />
            {t("profile.label.youReOnTheLatestVersion")}
          </div>
        )}
        {status.state === "error" && (
          <div className="flex items-center gap-2 rounded-lg bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
            <XCircle size={14} />
            {t("profile.error.updateFailedMessage", { message: status.message })}
          </div>
        )}
      </div>

      {/* About dosya, the service */}
      <div className="space-y-3 rounded-xl border p-5" style={{ borderColor: "var(--color-border)" }}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{t("about.window.aboutDosya")}</p>
        <p className="text-[13.5px] leading-relaxed">{t("profile.description.aboutDosyaLargeFiles")}</p>
        <p className="text-[13.5px] leading-relaxed text-[var(--color-text-secondary)]">{t("profile.description.aboutDosyaEncryptionSource")}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
          {link("dosya.dev", "https://dosya.dev")}
          {link(t("about.label.releaseNotes"), "https://dosya.dev/changelog/")}
          {link(t("profile.label.helpCenter"), "https://dosya.dev/help")}
          <button onClick={() => setShowAck((v) => !v)} aria-expanded={showAck} className="text-[var(--color-text)] underline decoration-[var(--color-border)] underline-offset-[3px] hover:decoration-current">
            {t("about.label.acknowledgements")}
          </button>
          {link(t("profile.label.termsOfService"), "https://dosya.dev/terms-of-service")}
          {link(t("profile.label.privacyPolicy"), "https://dosya.dev/privacy-policy")}
        </div>
        {showAck && (
          <div className="max-h-80 overflow-y-auto rounded-lg border p-3" style={{ borderColor: "var(--color-border)" }}>
            <AcknowledgementsList />
          </div>
        )}
        <p className="border-t pt-3 text-xs text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>
          {t("about.label.yearDosyaDev", { year: String(new Date().getFullYear()) })}
        </p>
      </div>
    </div>
  );
}

// ── Shared Components ───────────────────────────────────────────────

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-full max-w-md rounded-xl bg-[var(--color-bg)] p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
      <div className="fixed inset-0 -z-10" onClick={onClose} />
    </div>
  );
}

function PasswordInput({ label, value, onChange, autoComplete }: { label: string; value: string; onChange: (v: string) => void; autoComplete?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="mb-1 block text-sm font-medium">{label}</label>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          className="w-full rounded-lg border px-3 py-2 pe-10 text-sm outline-none focus:border-[var(--color-primary)]"
          style={{ borderColor: "var(--color-border)" }}
        />
        <button type="button" onClick={() => setShow(!show)} className="absolute inset-e-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]">
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}
