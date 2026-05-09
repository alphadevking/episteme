// lib/hooks/use-onboarding.ts
"use client";

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { Database } from "@/lib/types/database";
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

        // 1. Read current roles so we APPEND rather than replace.
        //    Guards against overwriting a provisioned admin/superadmin role.
        const { data: currentUser } = await supabase
          .from("users")
          .select("roles")
          .eq("id", userId)
          .maybeSingle();

        const existingRoles = (currentUser?.roles ?? []) as string[];
        const mergedRoles = Array.from(
          new Set([...existingRoles, merged.role]),
        ).filter((r) => r !== "prospective");

        // 2. Activate the user account
        const { error: userErr } = await supabase
          .from("users")
          .update({
            institution_id: merged.institutionId,
            primary_role: merged.role,
            roles: mergedRoles as Database["public"]["Enums"]["user_role"][],
            first_name: merged.firstName,
            last_name: merged.lastName ?? null,
            phone: merged.phone ?? null,
            status: "active",
          })
          .eq("id", userId);

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

        // 6. Write AI context — non-fatal
        supabase
          .from("user_ai_context")
          .upsert(
            {
              user_id: userId,
              role: merged.role,
              institution: merged.institutionName ?? null,
              programme: merged.programmeInterest ?? merged.programmeName ?? null,
              level: merged.level ?? null,
              preferences: {
                verbosity: merged.verbosity ?? "concise",
                staffTitle: merged.staffTitle ?? null,
                department: merged.department ?? null,
              },
              topics_seen: [],
              trust_level: merged.trustLevel ?? 1,
              matric_number: merged.studentId ?? null,
              verified: (merged.trustLevel ?? 0) >= 3,
            },
            { onConflict: "user_id" },
          )
          .then(({ error: e }) => {
            if (e) console.warn("[onboarding] user_ai_context write failed:", e.message);
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
