// app/chat/page.tsx
// Empty chat state — no thread yet.
// NewChatShell handles the composer; thread is created via runtime.initialize()
// when the user sends the first message.
import { getAuthUser, getUserProfile } from "@/lib/supabase/server-auth";
import { getSuggestions } from "@/lib/suggestions";
import { NewChatShell } from "@/components/assistant-ui/new-chat-shell";
import { SnapshotPrimer } from "@/components/assistant-ui/snapshot-primer";
import { buildServerSnapshot } from "@/lib/runtime/server-snapshot.server";
import { SignInForm } from "@/app/chat/sign-in-form";

export default async function ChatPage() {
  // Request-cached — shares the layout's auth call rather than making its own.
  const user = await getAuthUser();
  if (!user) return <SignInForm />;

  // No threadId: primes the sidebar's thread list only.
  const [profile, snapshot] = await Promise.all([getUserProfile(), buildServerSnapshot()]);

  const suggestions = getSuggestions(profile?.primary_role ?? null);

  return (
    <>
      {snapshot && <SnapshotPrimer snapshot={snapshot} />}
      <NewChatShell suggestions={suggestions} />
    </>
  );
}
