import { useState } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import {
  FolderSync,
  Upload,
  Shield,
  Bell,
  MonitorSmartphone,
  ArrowRight,
  ChevronRight,
} from "lucide-react";
import logoSvg from "@/assets/logo.svg";

const steps = [
  {
    title: "Welcome to dosya.dev",
    description:
      "Your files, everywhere. dosya.dev gives you a fast, secure space to store, sync, and share files across all your devices.",
    icon: MonitorSmartphone,
    features: [
      "Up to 10 TB of cloud storage",
      "Available on Windows, macOS, and Linux",
      "Access your files from any browser",
    ],
  },
  {
    title: "Sync folders automatically",
    description:
      "Pick any folder on your computer and dosya.dev keeps it in sync with the cloud. Changes upload in the background — no manual steps needed.",
    icon: FolderSync,
    features: [
      "Two-way, push, or pull sync modes",
      "Runs silently in your system tray",
      "Pause and resume anytime",
    ],
  },
  {
    title: "Upload anything, instantly",
    description:
      "Drag and drop files straight from your desktop. Large files are handled natively — no browser upload limits, no timeouts.",
    icon: Upload,
    features: [
      "No file size limits",
      "Drag and drop from your file manager",
      "Automatic versioning on every change",
    ],
  },
  {
    title: "Secure by default",
    description:
      "Every file is encrypted at rest with AES-256. Share files with expiring links, password protection, and download limits.",
    icon: Shield,
    features: [
      "AES-256 encryption at rest",
      "Password-protected share links",
      "Expiring links with download limits",
    ],
  },
  {
    title: "Stay in the loop",
    description:
      "Get native notifications when uploads finish, when someone shares a file with you, or when your storage is running low.",
    icon: Bell,
    features: [
      "Native OS notifications",
      "Upload and sync progress in the tray",
      "Team activity updates",
    ],
  },
];

export function OnboardingPage() {
  const [step, setStep] = useState(0);
  const navigate = useNavigate();
  const { isAuthenticated, isLoading } = useAuth();
  const current = steps[step];
  const Icon = current.icon;
  const isLast = step === steps.length - 1;

  // Already logged in — skip onboarding and go to dashboard
  if (!isLoading && isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
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
      {/* Left panel — 30% */}
      <div className="flex w-[30%] flex-col justify-between bg-[var(--color-bg)] p-8">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <img src={logoSvg} alt="dosya.dev" className="h-7 w-7" />
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
                className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-all ${
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
                  {s.title.replace("Welcome to dosya.dev", "Welcome")}
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
          Skip onboarding
        </button>
      </div>

      {/* Right panel — 70% */}
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
            {current.title}
          </h1>

          {/* Description */}
          <p className="mb-8 text-base leading-relaxed text-[var(--color-text-secondary)]">
            {current.description}
          </p>

          {/* Feature list */}
          <div className="mb-10 w-full space-y-3">
            {current.features.map((feature, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-lg bg-[var(--color-bg)] px-4 py-3 text-left shadow-sm"
                style={{ borderColor: "var(--color-border)" }}
              >
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)]/10">
                  <ChevronRight
                    size={14}
                    className="text-[var(--color-primary)]"
                  />
                </div>
                <span className="text-sm text-[var(--color-text)]">
                  {feature}
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
              className="flex items-center gap-2 rounded-lg bg-[var(--color-primary)] px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-primary-hover)]"
            >
              {isLast ? "Get Started" : "Next"}
              <ArrowRight size={16} />
            </button>
          </div>
        </div>

        {/* Step counter */}
        <div className="absolute bottom-6 right-8 text-xs text-[var(--color-text-muted)]">
          {step + 1} / {steps.length}
        </div>
      </div>
    </div>
  );
}
