// app/api/account/export/route.ts
// GET — download everything this account holds, as one JSON file.
//
// Every query is explicitly filtered to the caller's own id. RLS already scopes
// most of these tables, but the filters are not redundant: an export endpoint is
// exactly where a future RLS regression would turn into a cross-tenant data
// leak, so the constraint is stated here as well rather than delegated.
//
// Deliberately NOT included: audit_logs (they record admin actions ABOUT the
// user, and can name the acting staff member) and anything belonging to another
// user — a parent's export lists their own link rows, not their ward's records.
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET() {
  const supabase = await createSupabaseServerClientReadOnly();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users")
    .select("*")
    .eq("auth_id", user.id)
    .maybeSingle();

  if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

  const userId = profile.id;

  const [
    aiContext, profiles, studentLinks, parentLinks, claims, threads, notifications, onboarding,
  ] = await Promise.all([
    supabase.from("user_ai_context").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("user_profiles").select("*").eq("user_id", userId),
    supabase.from("user_student_links").select("*").eq("user_id", userId),
    supabase.from("parent_student_links").select("*").eq("parent_user_id", userId),
    supabase.from("verification_claims").select("*").eq("user_id", userId),
    supabase.from("chat_threads").select("*").eq("user_id", userId),
    supabase.from("notifications").select("*").eq("user_id", userId),
    supabase.from("onboarding_sessions").select("*").eq("user_id", userId),
  ]);

  // Messages are fetched per-thread rather than by a join, so a thread the
  // caller does not own cannot be pulled in by a mistaken filter.
  const threadIds = (threads.data ?? []).map((t) => t.id);
  const { data: messages } = threadIds.length
    ? await supabase.from("thread_messages").select("*").in("thread_id", threadIds)
    : { data: [] };

  const payload = {
    exported_at: new Date().toISOString(),
    account: {
      // From the auth record rather than the profile row.
      auth_id:  user.id,
      email:    user.email ?? null,
      provider: user.app_metadata?.provider ?? null,
      created_at: user.created_at ?? null,
    },
    profile,
    ai_context:           aiContext.data ?? null,
    role_profiles:        profiles.data ?? [],
    student_verification: studentLinks.data ?? [],
    linked_students:      parentLinks.data ?? [],
    verification_claims:  claims.data ?? [],
    chat_threads:         threads.data ?? [],
    chat_messages:        messages ?? [],
    notifications:        notifications.data ?? [],
    onboarding_sessions:  onboarding.data ?? [],
  };

  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type":        "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="episteme-export-${stamp}.json"`,
      // Contains personal data — never let a proxy or the browser retain it.
      "Cache-Control":       "no-store, private",
    },
  });
}
