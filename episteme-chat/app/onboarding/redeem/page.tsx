// app/onboarding/redeem/page.tsx
// Invite token redemption page.
// Staff receive a link: /onboarding/redeem?token=<rawToken>
// They must be signed in (or sign up first). On redemption, fn_redeem_invite_token
// promotes their role and links them to the correct department atomically.
// On success, they are redirected to their role-appropriate dashboard.
"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Loader2Icon, CheckCircleIcon, XCircleIcon } from "lucide-react";

type State = "loading" | "success" | "error" | "unauthenticated";

function RedeemInvitePageInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const token        = searchParams.get("token");

  const [state,   setState]   = useState<State>("loading");
  const [message, setMessage] = useState("");
  const [role,    setRole]    = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState("error");
      setMessage("No invite token found in the link. Please check your invite email.");
      return;
    }

    const redeem = async () => {
      const supabase = createSupabaseBrowserClient();
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        setState("unauthenticated");
        return;
      }

      type RedeemResult = { role: string; department_id: string | null };
      type RedeemRpc = {
        rpc(
          fn: "fn_redeem_invite_token",
          args: { p_token: string },
        ): Promise<{ data: RedeemResult | null; error: { code: string; message: string } | null }>;
      };

      const { data, error } = await (supabase as unknown as RedeemRpc).rpc(
        "fn_redeem_invite_token",
        { p_token: token },
      );

      if (error) {
        setState("error");
        setMessage(
          error.code === "P0003"
            ? "This invite link is invalid, expired, or has already been used."
            : error.code === "P0004"
            ? "No account found matching this invite. Make sure you signed up with the invited email address."
            : error.message,
        );
        return;
      }

      if (!data) {
        setState("error");
        setMessage("Unexpected response from server.");
        return;
      }

      const result = data;
      setRole(result.role);
      setState("success");

      // Redirect to the right dashboard after a short pause
      setTimeout(() => {
        if (result.role === "hod") router.push("/hod");
        else router.push("/chat");
      }, 2000);
    };

    redeem();
  }, [token, router]);

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6 text-center">

        {/* Brand */}
        <div className="flex flex-col items-center gap-2 mb-2">
          <Logo width={40} height={40} />
          <span className="font-serif text-xl font-medium">Episteme</span>
        </div>

        {/* Loading */}
        {state === "loading" && (
          <div className="space-y-3">
            <Loader2Icon className="size-8 text-primary animate-spin mx-auto" />
            <p className="text-sm text-muted-foreground">Verifying your invite…</p>
          </div>
        )}

        {/* Success */}
        {state === "success" && (
          <div className="space-y-3">
            <CheckCircleIcon className="size-10 text-success mx-auto" />
            <h1 className="text-lg font-semibold">Invite accepted</h1>
            <p className="text-sm text-muted-foreground">
              You have been assigned the{" "}
              <span className="font-medium text-foreground capitalize">{role}</span> role.
              Redirecting you to your dashboard…
            </p>
          </div>
        )}

        {/* Unauthenticated */}
        {state === "unauthenticated" && (
          <div className="space-y-4">
            <XCircleIcon className="size-10 text-warning mx-auto" />
            <h1 className="text-lg font-semibold">Sign in required</h1>
            <p className="text-sm text-muted-foreground">
              You need to sign in (or create an account) with the invited email address
              before you can redeem this invite.
            </p>
            <Button
              className="w-full"
              onClick={() =>
                router.push(
                  `/sign-in?next=${encodeURIComponent(`/onboarding/redeem?token=${token}`)}`,
                )
              }
            >
              Sign in to continue
            </Button>
          </div>
        )}

        {/* Error */}
        {state === "error" && (
          <div className="space-y-4">
            <XCircleIcon className="size-10 text-destructive mx-auto" />
            <h1 className="text-lg font-semibold">Redemption failed</h1>
            <p className="text-sm text-muted-foreground">{message}</p>
            <Button variant="outline" className="w-full" onClick={() => router.push("/sign-in")}>
              Back to sign in
            </Button>
          </div>
        )}

      </div>
    </div>
  );
}

export default function RedeemInvitePage() {
  return (
    <Suspense fallback={
      <div className="min-h-dvh flex items-center justify-center">
        <Loader2Icon className="size-8 text-primary animate-spin" />
      </div>
    }>
      <RedeemInvitePageInner />
    </Suspense>
  );
}
