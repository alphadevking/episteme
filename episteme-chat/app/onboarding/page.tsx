// app/onboarding/page.tsx
import { createSupabaseServerClient, createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";

export default async function OnboardingPage() {
  const supabase = await createSupabaseServerClientReadOnly();

  // ── Auth guard ────────────────────────────────────────────────────────
  const { data: { user: authUser } } = await supabase.auth.getUser();
  if (!authUser) redirect("/sign-in");

  const { data: profile } = await supabase
    .from("users")
    .select("id, status, institution_id, first_name, last_name, primary_role")
    .eq("auth_id", authUser.id)
    .maybeSingle();

  // Already completed onboarding — send to chat.
  if (profile?.status === "active" && profile?.institution_id) {
    redirect("/chat");
  }

  // ── Create or resume an onboarding_session ────────────────────────────
  const rwSupabase = await createSupabaseServerClient();

  // Use public.users.id (profile.id) — NOT authUser.id.
  // For users created by the old trigger, public.users.id ≠ auth UUID.
  // The FK on onboarding_sessions.user_id references public.users.id.
  if (!profile?.id) {
    // Public user row doesn't exist yet — trigger may have failed.
    // Render stateless rather than hitting a FK error.
    console.error("[onboarding] public.users row not found for auth user", authUser.id);
  }
  const userId = profile?.id ?? authUser.id;

  const { data: existing } = await rwSupabase
    .from("onboarding_sessions")
    .select("id, current_step, total_steps, step_data, journey_type")
    .eq("user_id", userId)
    .eq("status", "in_progress")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const TOTAL_STEPS = 4;
  let sessionId: string;
  let startStep: number;
  let stepData:  Record<string, unknown>;

  if (existing) {
    sessionId = existing.id;
    startStep = existing.current_step;
    stepData  = (existing.step_data ?? {}) as Record<string, unknown>;
  } else {
    const { data: created, error } = await rwSupabase
      .from("onboarding_sessions")
      .insert({
        user_id:      userId,
        journey_type: "prospective",
        current_step: 1,
        total_steps:  TOTAL_STEPS,
        step_data:    {},
        status:       "in_progress",
      })
      .select("id")
      .maybeSingle();

    if (error || !created) {
      // Session create failed — log and render stateless.
      // Do NOT redirect to /sign-in; that causes an infinite loop.
      console.error("[onboarding] session create failed:", error?.message);
      sessionId = "";
      startStep = 1;
      stepData  = {};
    } else {
      sessionId = created.id;
      startStep = 1;
      stepData  = {};
    }
  }

  return (
    <OnboardingWizard
      sessionId={sessionId}
      userId={userId}
      totalSteps={TOTAL_STEPS}
      initialStep={startStep}
      initialData={stepData}
      prefill={{
        firstName: profile?.first_name  ?? undefined,
        lastName:  profile?.last_name   ?? undefined,
        role:      profile?.primary_role ?? undefined,
      }}
    />
  );
}