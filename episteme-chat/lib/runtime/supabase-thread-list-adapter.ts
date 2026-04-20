// lib/runtime/supabase-thread-list-adapter.ts
// No RemoteThreadListAdapter import — the type re-exports from @assistant-ui/core
// which conflicts with the version bundled inside @assistant-ui/react.
// The class is structurally compatible; cast to `never` at usage site in episteme-runtime.tsx.
import type { ThreadMessage } from "@assistant-ui/react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

// Inline types — verified from @assistant-ui/core@0.1.7 source
type RemoteThreadInitializeResponse = {
  remoteId:   string;
  externalId: string | undefined;
};

type RemoteThreadMetadata = {
  readonly status:      "regular" | "archived";
  readonly remoteId:    string;
  readonly externalId?: string | undefined;
  readonly title?:      string | undefined;
};

type RemoteThreadListResponse = {
  threads: RemoteThreadMetadata[];
};

type SupabaseClient = ReturnType<typeof createSupabaseBrowserClient>;

function extractTitleFromMessages(messages: readonly ThreadMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "New conversation";
  const textPart = first.content.find(
    (p): p is { type: "text"; text: string; parentId?: string } => p.type === "text",
  );
  return (textPart?.text ?? "New conversation").slice(0, 80);
}

// No `implements` — avoids the broken re-export chain.
// Structurally matches RemoteThreadListAdapter at runtime.
export class SupabaseThreadListAdapter {
  private supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  async list(): Promise<RemoteThreadListResponse> {
    // Use a SECURITY DEFINER RPC so the result is always scoped to the
    // authenticated user's own threads, regardless of RLS policies.
    const { data, error } = await this.supabase.rpc("fn_list_my_chat_threads");

    if (error) {
      console.error("[threads] list() error:", error.message);
      return { threads: [] };
    }
    return {
      threads: (data ?? []).map((t) => ({
        status:     t.is_archived ? ("archived" as const) : ("regular" as const),
        remoteId:   t.id,
        externalId: undefined,
        title:      t.title ?? "Untitled",
      })),
    };
  }

  async initialize(_localThreadId: string): Promise<RemoteThreadInitializeResponse> {
    const { data: threadId, error } = await this.supabase.rpc(
      "fn_create_chat_thread",
      { p_title: "New conversation" },
    );
    if (error || !threadId) {
      console.error("[threads] initialize() error:", error?.message);
      throw new Error("Failed to create thread");
    }
    return { remoteId: threadId as string, externalId: undefined };
  }

  async fetch(remoteId: string): Promise<RemoteThreadMetadata> {
    const { data } = await this.supabase
      .from("chat_threads")
      .select("id, title, is_archived")
      .eq("id", remoteId)
      .maybeSingle();
    return {
      status:     data?.is_archived ? ("archived" as const) : ("regular" as const),
      remoteId,
      externalId: undefined,
      title:      data?.title ?? "Untitled",
    };
  }

  async rename(remoteId: string, newTitle: string): Promise<void> {
    await this.supabase.rpc("fn_update_chat_thread", {
      p_thread_id: remoteId,
      p_title:     newTitle,
    });
  }

  async archive(remoteId: string): Promise<void> {
    await this.supabase.rpc("fn_update_chat_thread", {
      p_thread_id: remoteId,
      p_archived:  true,
    });
  }

  async unarchive(remoteId: string): Promise<void> {
    await this.supabase.rpc("fn_update_chat_thread", {
      p_thread_id: remoteId,
      p_archived:  false,
    });
  }

  async delete(remoteId: string): Promise<void> {
    await this.supabase.rpc("fn_delete_chat_thread", {
      p_thread_id: remoteId,
    });
  }

  async generateTitle(
    remoteId: string,
    messages: readonly ThreadMessage[],
  ): Promise<ReadableStream<unknown>> {
    const title = extractTitleFromMessages(messages);
    await this.supabase
      .from("chat_threads")
      .update({ title })
      .eq("id", remoteId);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(title));
        controller.close();
      },
    });
  }
}