// lib/runtime/use-supabase-history-adapter.ts
// Import ONLY from @assistant-ui/react — ensures type compatibility with
// RuntimeAdapterProvider which expects types from the same bundled core version.
"use client";

import { useRef, useMemo } from "react";
import { useAui } from "@assistant-ui/react";
import type {
  ThreadHistoryAdapter,
  GenericThreadHistoryAdapter,
  MessageFormatAdapter,
  MessageFormatItem,
  MessageStorageEntry,
} from "@assistant-ui/react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { consumeMessages, type SnapshotMessageRow } from "@/lib/runtime/server-snapshot";
import type { Json } from "@/lib/types/database";

/** Row shape shared by the primed snapshot and the live query. */
type MessageRow = SnapshotMessageRow;

export function useSupabaseHistoryAdapter(): ThreadHistoryAdapter {
  // Stabilize the client — createSupabaseBrowserClient() returns a new object
  // on every call. Without useMemo here, the outer useMemo([supabase]) dependency
  // changes every render, which causes an infinite re-render loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const aui      = useAui();
  const remoteIdRef = useRef<string | null>(null);

  // Read synchronously during render so load() has the remoteId on first call.
  // useEffect fires after paint — too late for the runtime's initial load() call.
  try {
    const item = aui.threadListItem.source ? aui.threadListItem() : null;
    remoteIdRef.current = item?.getState().remoteId ?? null;
  } catch {
    remoteIdRef.current = null;
  }

  return useMemo<ThreadHistoryAdapter>(
    () => ({
      async load() {
        return { messages: [] };
      },
      async append() {},

      withFormat<TMessage, TStorageFormat extends Record<string, unknown>>(
        formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>,
      ): GenericThreadHistoryAdapter<TMessage> {
        return {
          async load() {
            const threadId = remoteIdRef.current;
            if (!threadId) {
              console.warn("[history] load() skipped — remoteId not set");
              return { messages: [] };
            }

            let rows: MessageRow[];

            // First load after a server render: the page already shipped these
            // rows. Available once per navigation — a later load() (thread
            // switched away and back) falls through to the query below.
            const primed = consumeMessages(threadId);
            if (primed) {
              // The server primes every format for the thread; the format
              // filter is applied here so it can never drift from the value
              // this adapter actually decodes.
              rows = primed.filter((r) => r.format === formatAdapter.format);
            } else {
              const { data, error } = await supabase
                .from("thread_messages")
                .select("sdk_message_id, parent_id, format, content_json, created_at")
                .eq("thread_id", threadId)
                .eq("format", formatAdapter.format)
                .order("created_at", { ascending: true });

              if (error) {
                console.error("[history] load() error:", error.message);
                return { messages: [] };
              }

              rows = data as MessageRow[];
            }

            const messages: MessageFormatItem<TMessage>[] = rows.map((row) =>
              formatAdapter.decode({
                id:        row.sdk_message_id ?? "",
                parent_id: row.parent_id ?? null,
                format:    row.format ?? formatAdapter.format,
                content:   (row.content_json ?? {}) as TStorageFormat,
              } as MessageStorageEntry<TStorageFormat>),
            );

            return { messages };
          },

          async append(item: MessageFormatItem<TMessage>) {
            const threadId = remoteIdRef.current;
            if (!threadId) {
              console.warn("[history] append() skipped — remoteId not set");
              return;
            }

            const encoded   = formatAdapter.encode(item);
            const id        = formatAdapter.getId(item.message);
            const msg       = item.message as { role?: string; content?: unknown };
            const plainText = Array.isArray(msg.content)
              ? (msg.content as { type: string; text?: string }[])
                  .filter((p) => p.type === "text")
                  .map((p) => p.text ?? "")
                  .join("") || ""
              : "";

            const { error } = await supabase
              .from("thread_messages")
              .upsert(
                {
                  thread_id:      threadId,
                  sdk_message_id: id,
                  parent_id:      item.parentId,
                  format:         formatAdapter.format,
                  role:           msg.role ?? "unknown",
                  content:        plainText,
                  content_json:   encoded as unknown as Json,
                  metadata:       {},
                },
                { onConflict: "thread_id,sdk_message_id" },
              );

            if (error) console.error("[history] append() DB error:", error);

            supabase
              .from("chat_threads")
              .update({ updated_at: new Date().toISOString() })
              .eq("id", threadId)
              .then(() => undefined);
          },
        };
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [supabase],
  );
}