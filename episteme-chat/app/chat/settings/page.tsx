// app/chat/settings/page.tsx
// Server component — loads data, passes to SettingsShell (client).
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { SettingsShell } from "@/components/user/settings-shell";
import type { SettingsInitial } from "@/components/user/settings-form";

export default async function SettingsPage() {
  const supabase = await createSupabaseServerClientReadOnly();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  const { data: profile } = await supabase
    .from("users")
    .select("id, first_name, last_name, phone, primary_role, institution_id")
    .eq("auth_id", user.id)
    .maybeSingle();

  if (!profile) redirect("/onboarding");

  const { data: aiCtx } = await supabase
    .from("user_ai_context")
    .select("programme, level, preferences")
    .eq("user_id", profile.id)
    .maybeSingle();

  const prefs      = (aiCtx?.preferences ?? {}) as Record<string, unknown>;
  const verbosity  = (prefs.verbosity  as "concise" | "detailed") ?? "concise";
  const department = (prefs.department as string) ?? "";
  const staffTitle = (prefs.staffTitle as string) ?? "";

  const [{ data: programmes }, { data: departments }] = await Promise.all([
    profile.institution_id
      ? supabase
          .from("programs")
          .select("id, name, code")
          .eq("institution_id", profile.institution_id)
          .eq("is_active", true)
          .order("name")
      : { data: [] },
    profile.institution_id
      ? supabase
          .from("departments")
          .select("id, name, code")
          .eq("institution_id", profile.institution_id)
          .eq("is_active", true)
          .order("name")
      : { data: [] },
  ]);

  // Split legacy full-name rows (OAuth trigger stored "First Last" in first_name)
  const rawFirst  = profile.first_name ?? "";
  const spaceIdx  = rawFirst.indexOf(" ");
  const firstName = spaceIdx > -1 ? rawFirst.slice(0, spaceIdx) : rawFirst;
  const lastName  = profile.last_name ?? (spaceIdx > -1 ? rawFirst.slice(spaceIdx + 1) : "");

  const initial: SettingsInitial = {
    firstName,
    lastName,
    phone:       profile.phone    ?? "",
    primaryRole: profile.primary_role ?? "",
    programme:   aiCtx?.programme ?? "",
    level:       aiCtx?.level     ?? "",
    department,
    staffTitle,
    verbosity,
    programmes:  (programmes  ?? []) as SettingsInitial["programmes"],
    departments: (departments ?? []) as SettingsInitial["departments"],
  };

  return <SettingsShell initial={initial} />;
}
