// app/chat/[threadId]/page.tsx
import { Assistant } from "@/app/assistant";
import { ThreadSwitcher } from "@/app/episteme-runtime";
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { getSuggestions } from "@/lib/suggestions";

export default async function Page({
  params,
  searchParams,
}: {
  params:       Promise<{ threadId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const [{ threadId }, { q }] = await Promise.all([params, searchParams]);

  const supabase = await createSupabaseServerClientReadOnly();

  const { data: { user } } = await supabase.auth.getUser();

  const [{ data: profile }, { data: thread }] = await Promise.all([
    supabase.from("users").select("primary_role").eq("auth_id", user?.id ?? "").maybeSingle(),
    supabase.from("chat_threads").select("title").eq("id", threadId).maybeSingle(),
  ]);

  const suggestions    = getSuggestions(profile?.primary_role ?? null);
  const initialMessage = q ? decodeURIComponent(q) : undefined;
  const initialTitle   = thread?.title ?? undefined;

  return (
    <>
      <ThreadSwitcher threadId={threadId} />
      <Assistant
        suggestions={suggestions}
        initialMessage={initialMessage}
        threadId={threadId}
        initialTitle={initialTitle}
      />
    </>
  );
}