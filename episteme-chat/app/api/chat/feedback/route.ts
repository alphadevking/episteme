// app/api/chat/feedback/route.ts
// Records 👍/👎 feedback on an assistant message.
// Delegates to fn_submit_message_feedback (SECURITY DEFINER) — no direct table access.
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { threadId?: string; sdkMessageId?: string; helpful?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { threadId, sdkMessageId, helpful } = body;

  if (!threadId || !sdkMessageId || typeof helpful !== "boolean") {
    return Response.json(
      { error: "threadId, sdkMessageId, and helpful (boolean) are required" },
      { status: 400 },
    );
  }

  const { error } = await supabase.rpc("fn_submit_message_feedback", {
    p_thread_id:      threadId,
    p_sdk_message_id: sdkMessageId,
    p_helpful:        helpful,
  });

  if (error) {
    console.error("[feedback] rpc error:", error.message);
    return Response.json({ error: "Failed to record feedback" }, { status: 500 });
  }

  return Response.json({ success: true });
}
