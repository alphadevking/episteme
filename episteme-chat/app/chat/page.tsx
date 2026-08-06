// app/chat/page.tsx
// Empty chat state — no thread yet.
// NewChatShell handles the composer; thread is created via runtime.initialize()
// when the user sends the first message.
import { getAuthUser } from "@/lib/supabase/server-auth";
import { getSuggestionsForCurrentUser } from "@/lib/suggestions-server";
import { NewChatShell } from "@/components/assistant-ui/new-chat-shell";
import { SnapshotPrimer } from "@/components/assistant-ui/snapshot-primer";
import { buildServerSnapshot } from "@/lib/runtime/server-snapshot.server";
import { SignInForm } from "@/app/chat/sign-in-form";

export default async function ChatPage() {
  // Request-cached — shares the layout's auth call rather than making its own.
  const user = await getAuthUser();
  if (!user) return <SignInForm />;

  // No threadId: primes the sidebar's thread list only.
  const [suggestions, snapshot] = await Promise.all([
    getSuggestionsForCurrentUser(),
    buildServerSnapshot(),
  ]);

  return (
    <>
      {snapshot && <SnapshotPrimer snapshot={snapshot} />}
      <NewChatShell suggestions={suggestions} />
    </>
  );
}
