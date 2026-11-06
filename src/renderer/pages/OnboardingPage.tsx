import { useState } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import { readLastRoute } from "@/lib/route-restore";
import {
  FolderSync,
  Upload,
  Shield,
  Bell,
  MonitorSmartphone,
  ArrowRight,
  ChevronRight,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "../../i18n/keys";

// Catalog keys, translated at render so a language switch reaches them.
const steps: {
  title: MessageKey;
  /** The step's name in the left-hand list, where it is shorter. */
  short?: MessageKey;
  description: MessageKey;
  icon: typeof MonitorSmartphone;
  features: MessageKey[];
}[] = [
  {
    title: "onboarding.heading.welcomeToDosyaDev",
    short: "onboarding.heading.welcome",
    description: "onboarding.description.yourFilesEverywhereDosyaDevGivesYouAFast",
    icon: MonitorSmartphone,
    features: [
      "onboarding.label.upTo10TBOfCloudStorage",
      "onboarding.label.availableOnWindowsMacOSAndLinux",
      "onboarding.label.accessYourFilesFromAnyBrowser",
    ],
  },
  {
    title: "onboarding.heading.syncFoldersAutomatically",
    description: "onboarding.description.pickAnyFolderOnYourComputerAndDosyaDev",
    icon: FolderSync,
    features: [
      "onboarding.label.twoWayPushOrPullSyncModes",
      "onboarding.label.runsSilentlyInYourSystemTray",
      "onboarding.label.pauseAndResumeAnytime",
    ],
  },
  {
    title: "onboarding.heading.uploadAnythingInstantly",
    description: "onboarding.description.dragAndDropFilesStraightFromYourDesktopLarge",
    icon: Upload,
    features: [
      "onboarding.label.noFileSizeLimits",
      "onboarding.label.dragAndDropFromYourFileManager",
      "onboarding.label.automaticVersioningOnEveryChange",
    ],
  },
  {
    title: "onboarding.heading.secureByDefault",
    description: "onboarding.description.everyFileIsEncryptedAtRestWithAES256",
    icon: Shield,
    features: [
      "onboarding.label.aes256EncryptionAtRest",
      "onboarding.label.passwordProtectedShareLinks",
      "onboarding.label.expiringLinksWithDownloadLimits",
    ],
  },
  {
    title: "onboarding.heading.stayInTheLoop",
    description: "onboarding.description.getNativeNotificationsWhenUploadsFinishWhenSomeoneShares",
    icon: Bell,
    features: [
      "onboarding.label.nativeOSNotifications",
      "onboarding.label.uploadAndSyncProgressInTheTray",
      "onboarding.label.teamActivityUpdates",
    ],
  },
];

export function OnboardingPage() {
  const t = useT();
  const [step, setStep] = useState(0);
  const navigate = useNavigate();
  const { isAuthenticated, isLoading } = useAuth();
  const current = steps[step];
  const Icon = current.icon;
  const isLast = step === steps.length - 1;

  // Already logged in - go back to where the user left off (a reclaimed
  // window boots through here), falling back to the dashboard.
  if (!isLoading && isAuthenticated) {
    return <Navigate to={readLastRoute(window.localStorage) ?? "/dashboard"} replace />;
  }

  function finish() {
    localStorage.setItem("dosya_onboarded", "1");
    navigate("/login", { replace: true });
  }

  function next() {
    if (isLast) {
      finish();
    } else {
      setStep(step + 1);
    }
  }

  return (
    <div className="flex h-screen">
      {/* Left panel - 30% */}
      <div className="flex w-[30%] flex-col justify-between bg-[var(--color-bg)] p-8">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <Logo className="h-7 w-7" />
          <span className="text-base font-semibold text-[var(--color-text)]">
            dosya.dev
          </span>
        </div>

        {/* Step indicators */}
        <div className="space-y-3">
          {steps.map((s, i) => {
            const StepIcon = s.icon;
            const isActive = i === step;
            const isDone = i < step;
            return (
              <button
                key={i}
                onClick={() => setStep(i)}
                className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-start transition-all ${
                  isActive
                    ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                    : isDone
                      ? "text-[var(--color-primary)] opacity-60"
                      : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                }`}
              >
                <StepIcon size={18} strokeWidth={isActive ? 2.5 : 1.5} />
                <span
                  className={`text-sm ${isActive ? "font-semibold" : "font-medium"}`}
                >
                  {t(s.short ?? s.title)}
                </span>
              </button>
            );
          })}
        </div>

        {/* Skip */}
        <button
          onClick={finish}
          className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
        >
          {t("onboarding.action.skipOnboarding")}
        </button>
      </div>

      {/* Right panel - 70% */}
      <div className="bg-grid relative flex w-[70%] flex-col items-center justify-center bg-[var(--color-bg-secondary)] p-12">
        {/* Content card */}
        <div className="flex max-w-lg flex-col items-center text-center">
          {/* Icon */}
          <div className="mb-8 flex h-20 w-20 items-center justify-center rounded-2xl bg-[var(--color-primary)]/10">
            <Icon
              size={36}
              className="text-[var(--color-primary)]"
              strokeWidth={1.5}
            />
          </div>

          {/* Title */}
          <h1 className="mb-4 text-3xl font-bold tracking-tight text-[var(--color-text)]">
            {t(current.title)}
          </h1>

          {/* Description */}
          <p className="mb-8 text-base leading-relaxed text-[var(--color-text-secondary)]">
            {t(current.description)}
          </p>

          {/* Feature list */}
          <div className="mb-10 w-full space-y-3">
            {current.features.map((feature, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-lg bg-[var(--color-bg)] px-4 py-3 text-start shadow-sm"
                style={{ borderColor: "var(--color-border)" }}
              >
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)]/10">
                  <ChevronRight
                    size={14}
                    className="text-[var(--color-primary)] rtl:-scale-x-100"
                  />
                </div>
                <span className="text-sm text-[var(--color-text)]">
                  {t(feature)}
                </span>
              </div>
            ))}
          </div>

          {/* Navigation */}
          <div className="flex w-full items-center justify-between">
            {/* Dots */}
            <div className="flex gap-2">
              {steps.map((_, i) => (
                <div
                  key={i}
                  className={`h-2 rounded-full transition-all ${
                    i === step
                      ? "w-6 bg-[var(--color-primary)]"
                      : "w-2 bg-[var(--color-border)]"
                  }`}
                />
              ))}
            </div>

            {/* Next / Get Started button */}
            <button
              onClick={next}
              className="flex items-center gap-2 rounded-lg bg-[var(--color-primary)] px-6 py-2.5 text-sm font-semibold text-[var(--color-primary-fg)] transition-colors hover:bg-[var(--color-primary-hover)]"
            >
              {isLast ? t("onboarding.action.getStarted") : t("common.next")}
              <ArrowRight size={16} className="rtl:-scale-x-100" />
            </button>
          </div>
        </div>

        {/* Step counter */}
        <div className="absolute bottom-6 inset-e-8 text-xs text-[var(--color-text-muted)]">
          {step + 1} / {steps.length}
        </div>
      </div>
    </div>
  );
}
