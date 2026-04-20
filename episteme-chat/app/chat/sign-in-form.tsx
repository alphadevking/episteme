// app/chat/sign-in-form.tsx
"use client";

import { useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";

type Props = { notice?: string; next?: string };

// ── Spinner ───────────────────────────────────────────────────────────────

const Spinner = ({ className }: { className?: string }) => (
  <span
    aria-hidden="true"
    className={cn(
      "inline-block shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent",
      className,
    )}
  />
);

// ── Loading state type ────────────────────────────────────────────────────
// Tracks which action is in progress so both buttons respond correctly.

type LoadingState = "idle" | "google" | "magic-link";

export function SignInForm({ notice, next = "/chat" }: Props) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState<LoadingState>("idle");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(notice ?? null);

  const isBusy = loading !== "idle";

  // ── Google OAuth ──────────────────────────────────────────────────────

  const signInWithGoogle = async () => {
    if (isBusy) return;
    setError(null);
    setLoading("google");

    const callbackUrl = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

    const { error: e } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callbackUrl },
    });

    // If signInWithOAuth returns an error the redirect didn't happen
    if (e) {
      setError("Google sign-in failed. Please try again.");
      setLoading("idle");
    }
    // On success the browser navigates away — loading stays "google"
    // so the button keeps spinning until the page unloads.
  };

  // ── Magic link ────────────────────────────────────────────────────────

  const sendMagicLink = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (isBusy) return;

    setError(null);
    setLoading("magic-link");

    const callbackUrl = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

    const { error: e } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: callbackUrl },
    });

    setLoading("idle");

    if (e) {
      setError("Could not send magic link. Please try again.");
      return;
    }

    setSent(true);
  };

  return (
    <div className="flex min-h-dvh bg-background">

      {/* ── Left decorative panel ── */}
      <div className="relative hidden lg:flex lg:w-[52%] flex-col overflow-hidden bg-secondary">

        {/* Geometric texture */}
        <div className="absolute inset-0">
          <div className="absolute -top-24 -right-24 size-96 rounded-full border border-primary/15" />
          <div className="absolute -top-12 -right-12 size-72 rounded-full border border-primary/10" />
          <div className="absolute -bottom-16 -left-16 size-64 rounded-full border border-border" />
          <div className="absolute bottom-8 left-8 size-48 rounded-full border border-primary/8" />
          <div className="absolute top-[38%] inset-x-0 h-px bg-border" />
          <div className="absolute top-[38.5%] inset-x-0 h-px bg-border/50" />
          <div
            className="absolute top-12 left-10 size-32 opacity-30"
            style={{
              backgroundImage: "radial-gradient(circle, var(--primary) 1px, transparent 1px)",
              backgroundSize: "12px 12px",
            }}
          />
          <div className="absolute bottom-0 right-0 w-20 h-48 bg-primary/8" />
          <div className="absolute bottom-0 right-20 w-1 h-32 bg-primary/20" />
        </div>

        {/* Content */}
        <div className="relative z-10 flex flex-1 flex-col justify-between p-12">
          <div className="flex items-center gap-2.5">
            <Logo asLink={false} width={36} height={36} />
            <span className="font-serif text-2xl font-medium tracking-wide text-foreground">Episteme</span>
          </div>
          <div className="space-y-6">
            <div className="w-10 h-0.5 bg-primary" />
            <h2 className="font-serif text-4xl font-light leading-[1.2] text-foreground max-w-[18ch]">
              Intelligence, shaped by context.
            </h2>
            <p className="text-sm font-light leading-relaxed text-muted-foreground max-w-[36ch]">
              A platform that understands your role, your institution,
              and your needs — before you even ask.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="size-2 rounded-full bg-primary" />
            <span className="text-xs tracking-widest uppercase text-muted-foreground font-medium">
              University AI Platform
            </span>
          </div>
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 lg:px-16">

        {/* Mobile wordmark */}
        <div className="mb-10 lg:hidden flex items-center gap-2.5">
          <Logo width={36} height={36} />
          <span className="font-serif text-2xl font-medium tracking-wide text-foreground">Episteme</span>
        </div>

        <div className="w-full max-w-sm">

          {/* Header */}
          <div className="mb-8">
            <h1 className="font-serif text-3xl font-medium text-foreground">
              Welcome back
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Sign in to continue to your workspace.
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-5 rounded border border-destructive/20 bg-destructive/8 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Sent state */}
          {sent ? (
            <div className="rounded border border-primary/20 bg-primary/8 px-5 py-5 text-center space-y-2">
              <div className="mx-auto size-10 rounded-full bg-primary/12 flex items-center justify-center">
                <svg className="size-5 text-primary" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M3 4a1 1 0 00-1 1v.382a1 1 0 00.553.894l7 3.5a1 1 0 00.894 0l7-3.5A1 1 0 0018 5.382V5a1 1 0 00-1-1H3z" />
                  <path d="M3 9.118l6.447 3.224a3 3 0 002.106 0L18 9.118V15a1 1 0 01-1 1H3a1 1 0 01-1-1V9.118z" />
                </svg>
              </div>
              <p className="text-sm font-medium text-foreground">Check your email</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                We sent a sign-in link to{" "}
                <span className="font-medium text-foreground">{email}</span>.
                It expires in 10 minutes.
              </p>
              <button
                type="button"
                onClick={() => { setSent(false); setEmail(""); }}
                className="mt-1 text-xs text-primary underline underline-offset-2 hover:opacity-80 transition-opacity"
              >
                Use a different email
              </button>
            </div>
          ) : (
            <div className="space-y-4">

              {/* Google button */}
              <button
                type="button"
                onClick={signInWithGoogle}
                disabled={isBusy}
                className={cn(
                  "relative flex w-full items-center justify-center gap-3 rounded border border-border",
                  "bg-background px-4 py-2.5 text-sm font-medium text-foreground",
                  "transition-all hover:bg-secondary hover:border-primary/30 active:scale-[0.99]",
                  "disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100",
                )}
              >
                {loading === "google" ? (
                  <>
                    <Spinner className="size-4" />
                    <span>Redirecting…</span>
                  </>
                ) : (
                  <>
                    <svg className="size-4 shrink-0" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                    </svg>
                    <span>Continue with Google</span>
                  </>
                )}
              </button>

              {/* Divider */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground">or</span>
                <div className="flex-1 h-px bg-border" />
              </div>

              {/* Magic link form */}
              <form onSubmit={sendMagicLink} className="space-y-3">
                <div className="space-y-1.5">
                  <label
                    htmlFor="email"
                    className="block text-xs font-medium tracking-wide text-foreground uppercase"
                  >
                    Email address
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@institution.edu"
                    required
                    autoComplete="email"
                    disabled={isBusy}
                    className={cn(
                      "w-full rounded border border-input bg-background",
                      "px-3.5 py-2.5 text-sm text-foreground",
                      "placeholder:text-muted-foreground/60 outline-none",
                      "transition-all focus:border-primary focus:ring-2 focus:ring-primary/15",
                      "disabled:opacity-60 disabled:cursor-not-allowed",
                    )}
                  />
                </div>

                <button
                  type="submit"
                  disabled={isBusy}
                  className={cn(
                    "w-full rounded bg-primary px-4 py-2.5",
                    "text-sm font-medium text-primary-foreground",
                    "transition-all hover:bg-primary/90 active:scale-[0.99]",
                    "disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100",
                  )}
                >
                  {loading === "magic-link" ? (
                    <span className="flex items-center justify-center gap-2">
                      <Spinner className="size-3.5" />
                      Sending…
                    </span>
                  ) : "Send magic link"}
                </button>
              </form>

              <p className="text-center text-xs text-muted-foreground pt-1">
                No password needed. We&apos;ll email you a secure link.
              </p>
            </div>
          )}

          {/* Terms */}
          <p className="mt-10 text-center text-xs text-muted-foreground/60 leading-relaxed">
            By continuing, you agree to our{" "}
            <a href="#" className="underline underline-offset-2 hover:text-foreground transition-colors">
              Terms of Service
            </a>{" "}
            and{" "}
            <a href="#" className="underline underline-offset-2 hover:text-foreground transition-colors">
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}