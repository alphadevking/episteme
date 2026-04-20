// app/api/threads/[threadId]/messages/route.ts
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { type UIMessage } from "ai";
import { NextResponse } from "next/server";

type Params = { params: { threadId: string } };

// Load messages for a thread
export async function GET(_req: Request, { params }: Params) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { threadId } = params;

  const { data, error } = await supabase
    .from("thread_messages")
    .select("id, role, parts, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Reconstruct UIMessage shape
  const messages: UIMessage[] = (data ?? []).map((row) => ({
    id: row.id,
    role: row.role as UIMessage["role"],
    parts: row.parts,
    // UIMessage also has a top-level `content` for backwards compat
    content: row.parts
      .filter((p: { type: string }) => p.type === "text")
      .map((p: { text: string }) => p.text)
      .join(""),
  }));

  return NextResponse.json(messages);
}

// Save (upsert) the full message list after a turn completes
export async function POST(req: Request, { params }: Params) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { threadId } = params;
  const messages: UIMessage[] = await req.json();

  const rows = messages.map((m) => ({
    id: m.id,
    thread_id: threadId,
    role: m.role,
    parts: m.parts,
  }));

  const { error } = await supabase
    .from("thread_messages")
    .upsert(rows, { onConflict: "id" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}