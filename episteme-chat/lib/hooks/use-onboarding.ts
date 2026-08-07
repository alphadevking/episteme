// lib/hooks/use-onboarding.ts
"use client";

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

export type OnboardingRole =
  | "prospective"
  | "student"
  | "parent"
  | "guardian"
  | "staff";

export type StepData = {
  // Step 1 — identity (all journeys)
  role?: OnboardingRole;
  firstName?: string;
  lastName?: string;
  phone?: string;
  // Step 2 — institution (prospective, parent, staff)
  institutionId?: string;
  institutionName?: string;
  // Step 2 — student only (institution + student ID combined)
  studentId?: string;
  // Step 3 — prospective: programme interest
  programmeInterest?: string;
  // Step 3 — student: confirm current programme + year of study
  programmeName?: string;
  level?: string;   // e.g. "100L", "200L", …, "500L", "Postgraduate"
  // Step 3 — parent: link to ward
  wardStudentId?: string;
  wardRelationship?: "parent" | "guardian" | "sponsor";
  // Step 3 — staff: department + staff role title
  department?: string;
  staffTitle?: string;   // e.g. "Lecturer", "HOD", "Dean", "Admin Staff"
  // Step 4 — preferences (all journeys)
  verbosity?: "concise" | "detailed";
  // Verification (student only) — written by /api/verify-student
  trustLevel?: number;
};

// ── Journey step sequences ─────────────────────────────────────────────────

export const JOURNEY_STEPS: Record<string, string[]> = {
  prospective: ["identity", "institution_search", "programme_interest", "preferences"],
  student: ["identity", "student_id_verify", "programme_confirm", "preferences"],
  parent: ["identity", "institution_search", "ward_link", "preferences"],
  staff: ["identity", "institution_verify", "department", "preferences"],
};

const DEFAULT_JOURNEY = "prospective";

// ── Helpers ────────────────────────────────────────────────────────────────

function toJourneyType(
  role: OnboardingRole | undefined,
): "prospective" | "student" | "parent" | "staff" {
  switch (role) {
    case "student": return "student";
    case "guardian":
    case "parent": return "parent";
    case "staff": return "staff";
    default: return "prospective";
  }
}

function toJourneyKey(role: OnboardingRole | undefined): string {
  switch (role) {
    case "student": return "student";
    case "guardian":
    case "parent": return "parent";
    case "staff": return "staff";
    default: return DEFAULT_JOURNEY;
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────

type Props = {
  sessionId: string;
  userId: string;
  totalSteps: number;
  initialStep: number;
  initialData: Record<string, unknown>;
};

export function useOnboarding({
  sessionId,
  userId,
  totalSteps,
  initialStep,
  initialData,
}: Props) {
  const supabase = createSupabaseBrowserClient();
  const router = useRouter();

  const [step, setStep] = useState(initialStep);
  const [data, setData] = useState<StepData>(initialData as StepData);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derive step key from current step index + journey type
  const journeyKey = toJourneyKey(data.role);
  const steps = JOURNEY_STEPS[journeyKey] ?? JOURNEY_STEPS[DEFAULT_JOURNEY];
  const stepKey = steps[step - 1] ?? steps[0];
  // Use actual journey length so progress bar is always accurate
  const actualTotal = steps.length;

  // ── Persist step progress ───────────────────────────────────────────────
  const saveProgress = useCallback(
    async (newData: StepData, newStep: number) => {
      if (!sessionId) return;

      const jKey = toJourneyKey(newData.role);
      const jSteps = JOURNEY_STEPS[jKey];
      const newKey = jSteps[newStep - 1] ?? jSteps[0];

      const { error: err } = await supabase
        .from("onboarding_sessions")
        .update({
          current_step: newStep,
          step_data: newData,
          journey_type: toJourneyType(newData.role),
          step_key: newKey,
        })
        .eq("id", sessionId);

      if (err) throw new Error(err.message);
    },
    [supabase, sessionId],
  );

  // ── Advance to next step ────────────────────────────────────────────────
  const next = useCallback(
    async (stepPayload: Partial<StepData>) => {
      setError(null);
      setSaving(true);
      try {
        const merged = { ...data, ...stepPayload };
        const newStep = step + 1;
        setData(merged);
        await saveProgress(merged, newStep);
        setStep(newStep);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      } finally {
        setSaving(false);
      }
    },
    [data, step, saveProgress],
  );

  // ── Go back ─────────────────────────────────────────────────────────────
  const back = useCallback(() => {
    setError(null);
    const prev = Math.max(1, step - 1);
    setStep(prev);
    if (sessionId) {
      supabase
        .from("onboarding_sessions")
        .update({ current_step: prev, step_data: data })
        .eq("id", sessionId)
        .then(({ error: e }) => {
          if (e) console.warn("[onboarding] back step persist failed:", e.message);
        });
    }
  }, [supabase, sessionId, step, data]);

  // ── Complete onboarding ─────────────────────────────────────────────────
  const complete = useCallback(
    async (finalPayload: Partial<StepData>) => {
      setError(null);
      setSaving(true);

      try {
        const merged = { ...data, ...finalPayload };

        if (!merged.institutionId) throw new Error("Institution is required.");
        if (!merged.role) throw new Error("Role is required.");
        if (!merged.firstName) throw new Error("First name is required.");

        // Staff/HOD are provisioned only via admin-issued invite links
        // (fn_redeem_invite_token), never through self-service onboarding.
        // This guard is defense-in-depth for this client path; the actual
        // security boundary is the database grant on users.roles.
        if (merged.role === "staff") {
          throw new Error(
            "Staff accounts must be provisioned via an admin invite link, not self-service onboarding.",
          );
        }

        // 1 & 2. Activate the user account — role, institution, roles[] and
        // status all live behind fn_onboard_self (SECURITY DEFINER), which
        // rejects staff/admin/superadmin server-side and merges roles[]
        // itself. See supabase/migrations/DRAFT_lock_down_privilege_columns.sql
        // — this call depends on that migration having been applied; the
        // direct `.from("users").update(...)` this replaced worked only
        // because those columns were (over-)grantable to `authenticated`.
        // The two nullable params need a cast, and it is load-bearing:
        // Supabase typegen renders a nullable `text` argument as OPTIONAL
        // (`p_last_name?: string`), which is not the same thing. fn_onboard_self
        // declares no SQL DEFAULTs, so omitting the key makes PostgREST unable
        // to resolve the overload and it returns PGRST202. Passing null is the
        // runtime-correct call; `?? undefined` would break onboarding outright.
        const { error: userErr } = await supabase.rpc("fn_onboard_self", {
          p_role: merged.role,
          p_institution_id: merged.institutionId,
          p_first_name: merged.firstName,
          p_last_name: (merged.lastName ?? null) as unknown as string | undefined,
          p_phone: (merged.phone ?? null) as unknown as string | undefined,
        });

        if (userErr) throw new Error(userErr.message);

        // 3. Role-specific profile row
        const { error: profileErr } = await supabase
          .from("user_profiles")
          .upsert(
            {
              user_id: userId,
              role: merged.role,
              profile_data: {},
              custom_fields: {},
            },
            { onConflict: "user_id,role" },
          );

        if (profileErr) throw new Error(profileErr.message);

        // 4. Mark session completed
        if (sessionId) {
          const jKey = toJourneyKey(merged.role);
          const jSteps = JOURNEY_STEPS[jKey];

          const { error: sessionErr } = await supabase
            .from("onboarding_sessions")
            .update({
              status: "completed",
              completed_at: new Date().toISOString(),
              current_step: jSteps.length,
              step_key: jSteps[jSteps.length - 1],
              step_data: merged,
              journey_type: toJourneyType(merged.role),
            })
            .eq("id", sessionId);

          if (sessionErr) throw new Error(sessionErr.message);
        }

        // 5. Parent claim — non-fatal
        if (merged.role === "parent" && merged.wardStudentId?.trim()) {
          supabase
            .from("parent_student_links")
            .upsert(
              {
                parent_user_id: userId,
                student_user_id: null,
                claimed_matric: merged.wardStudentId.trim().toUpperCase(),
                relationship_type: merged.wardRelationship ?? "parent",
                verification_status: "pending",
              },
              { onConflict: "parent_user_id" },
            )
            .then(({ error: e }) => {
              if (e) console.warn("[onboarding] parent claim write failed:", e.message);
            });
        }

        // 6. Write AI context personalization.
        //
        // Through fn_update_my_ai_context (SECURITY DEFINER), NOT a direct
        // upsert. `user_ai_context` is SELECT-only for `authenticated` since
        // contract_column_lockdown, so the direct `.upsert()` this replaced
        // would fail with "permission denied for table user_ai_context" — and
        // because the failure was only `console.warn`ed, onboarding would have
        // reported success while silently discarding every preference the user
        // had just chosen.
        //
        // Two columns are deliberately NOT sent:
        //   topics_seen   — the old write set `[]`, which is the column default,
        //                   so it was always a no-op.
        //   matric_number — owned by fn_self_report_student, which also sets the
        //                   matching trust_level. Writing it here would let the
        //                   two disagree.
        //
        // Still non-fatal: the user is onboarded and can set all of this in
        // Settings. But it now logs as an error, because a silent warn is what
        // let this hide in the first place.
        // Inferred rather than annotated `Record<string, unknown>`, so it stays
        // structurally assignable to the generated `Json` arg type.
        const aiContextPatch = {
          institution: merged.institutionName ?? null,
          programme:   merged.programmeInterest ?? merged.programmeName ?? null,
          level:       merged.level ?? null,
          preferences: {
            verbosity:  merged.verbosity ?? "concise",
            staffTitle: merged.staffTitle ?? null,
            department: merged.department ?? null,
          },
        };

        void supabase
          .rpc("fn_update_my_ai_context", { p_patch: aiContextPatch })
          .then(({ error: e }) => {
            if (e) console.error("[onboarding] user_ai_context write failed:", e.message);
          });

        router.push("/chat");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      } finally {
        setSaving(false);
      }
    },
    [data, supabase, userId, sessionId, router],
  );

  return { step, stepKey, data, saving, error, next, back, complete, totalSteps: actualTotal };
}
