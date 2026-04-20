// app/chat/page.tsx
// Empty chat state — no thread yet.
// NewChatShell handles the composer; thread is created via runtime.initialize()
// when the user sends the first message.
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { getSuggestions } from "@/lib/suggestions";
import { NewChatShell } from "@/components/assistant-ui/new-chat-shell";
import { SignInForm } from "@/app/chat/sign-in-form";

export default async function ChatPage() {
  const supabase = await createSupabaseServerClientReadOnly();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <SignInForm />;

  const { data: profile } = await supabase
    .from("users")
    .select("primary_role")
    .eq("auth_id", user.id)
    .maybeSingle();

  const suggestions = getSuggestions(profile?.primary_role ?? null);

  return <NewChatShell suggestions={suggestions} />;
}