import "server-only";

import { getAuthUser, getServerSupabase } from "@/lib/supabase/server-auth";
import type { Database } from "@/lib/types/database";
import type {
  ServerSnapshot,
  SnapshotMessageRow,
  SnapshotThreadRow,
} from "./server-snapshot";

/**
 * Above this many rows we don't prime messages and let the client fetch them
 * as it always has.
 *
 * Primed rows travel in the RSC payload, so a very long thread would trade a
 * network round-trip for a fatter document — not obviously a win, and a
 * regression for users on slow links. Partial priming is not an option: a
 * truncated history would render as a *wrong* conversation, and a slower
 * correct paint always beats a fast wrong one.
 */
const MAX_PRIMED_MESSAGES = 80;

/** First page of the sidebar list. Must match `PAGE_SIZE` in thread-list.tsx. */
export const SIDEBAR_PAGE_SIZE = 30;

/**
 * Return row of `fn_list_my_chat_threads()`. Declared explicitly because the
 * generated types give that RPC `Args: never`, which defeats inference on the
 * result — see `Database["public"]["Functions"]["fn_list_my_chat_threads"]`.
 */
type RuntimeThreadRpcRow = Database["public"]["Functions"]["fn_list_my_chat_threads"]["Returns"][number];

/**
 * Fetch, in parallel, what the client would otherwise fetch serially after
 * hydration. Returns null when there is no authenticated user — callers then
 * skip priming and the client behaves exactly as before.
 *
 * Each query below is the verbatim counterpart of a client query; see the
 * FIDELITY RULE in `server-snapshot.ts`. Every failure mode degrades to "don't
 * prime that field": this never throws into a page render, and never returns
 * partial data that would render incorrectly.
 */
export async function buildServerSnapshot(threadId?: string): Promise<ServerSnapshot | null> {
  const user = await getAuthUser();
  if (!user) return null;

  const supabase = await getServerSupabase();

  const [runtimeResult, sidebarResult, messagesResult] = await Promise.all([
    // Counterpart of SupabaseThreadListAdapter.list() — every thread, archived
    // included, unbounded. The runtime needs the full set to resolve a switch
    // to any thread, including old ones past the sidebar's first page.
    supabase.rpc("fn_list_my_chat_threads"),

    // Counterpart of ThreadList's first-page query.
    supabase
      .from("chat_threads")
      .select("id, title, is_archived")
      .eq("is_archived", false)
      .order("created_at", { ascending: false })
      .range(0, SIDEBAR_PAGE_SIZE - 1),

    // Counterpart of the history adapter's load(). Note: no `format` filter
    // here — the adapter knows its own format and filters the primed rows
    // itself, so we can't drift from it.
    threadId
      ? supabase
          .from("thread_messages")
          .select("sdk_message_id, parent_id, format, content_json")
          .eq("thread_id", threadId)
          .order("created_at", { ascending: true })
          // One over the cap, to detect "too long" without a second query.
          .limit(MAX_PRIMED_MESSAGES + 1)
      : Promise.resolve({ data: null, error: null } as const),
  ]);

  const runtimeThreads: SnapshotThreadRow[] | undefined =
    runtimeResult.error || !runtimeResult.data
      ? undefined
      : (runtimeResult.data as RuntimeThreadRpcRow[]).map((t) => ({
          id:          t.id,
          title:       t.title,
          is_archived: t.is_archived,
        }));

  const sidebarThreads: SnapshotThreadRow[] | undefined =
    sidebarResult.error ? undefined : (sidebarResult.data ?? undefined);

  let messages: ServerSnapshot["messages"];
  if (threadId && !messagesResult.error && messagesResult.data) {
    const rows = messagesResult.data as SnapshotMessageRow[];
    // Over the cap means we fetched a partial history — prime nothing for this
    // thread rather than prime a truncated conversation.
    if (rows.length <= MAX_PRIMED_MESSAGES) {
      messages = { threadId, rows };
    }
  }

  if (!runtimeThreads && !sidebarThreads && !messages) return null;

  return { userId: user.id, runtimeThreads, sidebarThreads, messages };
}
