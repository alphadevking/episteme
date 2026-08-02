// app/chat/[threadId]/page.tsx
import { Assistant } from "@/app/assistant";
import { ThreadSwitcher } from "@/app/episteme-runtime";
import { SnapshotPrimer } from "@/components/assistant-ui/snapshot-primer";
import { getServerSupabase, getUserProfile } from "@/lib/supabase/server-auth";
import { buildServerSnapshot } from "@/lib/runtime/server-snapshot.server";
import { getSuggestions } from "@/lib/suggestions";

export default async function Page({
  params,
  searchParams,
}: {
  params:       Promise<{ threadId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const [{ threadId }, { q }] = await Promise.all([params, searchParams]);

  const supabase = await getServerSupabase();

  // All three run concurrently. `getUserProfile()` is request-cached, so the
  // layout's guard and this call share a single auth + profile round-trip.
  const [profile, thread, snapshot] = await Promise.all([
    getUserProfile(),
    supabase.from("chat_threads").select("title").eq("id", threadId).maybeSingle(),
    buildServerSnapshot(threadId),
  ]);

  const suggestions    = getSuggestions(profile?.primary_role ?? null);
  const initialMessage = q ? decodeURIComponent(q) : undefined;
  const initialTitle   = thread.data?.title ?? undefined;

  return (
    <>
      {/* Must render above ThreadSwitcher/Assistant so the runtime's first
          list()/load() reads server data instead of going to the network. */}
      {snapshot && <SnapshotPrimer snapshot={snapshot} />}
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
