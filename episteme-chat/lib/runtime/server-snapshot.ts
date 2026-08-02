"use client";

// Server → runtime handoff for the first paint of a chat page.
//
// The problem this solves: opening /chat/<id> used to require two SERIAL client
// round-trips before a single message could render —
//   1. adapter.list()            → which threads exist
//   2. (wait) switchToThread     → which thread is active
//   3. history.load()            → that thread's messages
// …even though the server that rendered the page was already authenticated and
// could have fetched all of it in parallel with the queries it was making
// anyway.
//
// So the server fetches them and primes this store; the consumers take it on
// their FIRST call and hit the network on every call after. Nothing else about
// the adapter contract changes.
//
// Why a module-level store rather than context: the runtime provider lives in
// `app/chat/layout.tsx` while the thread-scoped data is only knowable in
// `app/chat/[threadId]/page.tsx`, a child. Context flows down, not up.
//
// Ordering guarantee: `adapter.list()` is invoked from the provider's
// `useEffect` (see @assistant-ui/core `useRemoteThreadListRuntime`). React runs
// child renders — and child effects — before parent effects, so a priming
// component rendered by the page always lands before the first read.
//
// FIDELITY RULE — the one that keeps this safe:
//   Each primed field must be the *verbatim* result of the query its consumer
//   would otherwise have run. Not a superset, not a cheaper approximation.
//   The runtime list and the sidebar list look similar but are NOT the same
//   query (the runtime needs every thread including archived; the sidebar needs
//   one ordered, filtered page), so they are carried separately. Collapsing
//   them would silently hide old or archived threads from the runtime.
//
// Safety properties:
//   • Each prime is consumable once per reader; a stale snapshot can never
//     shadow a later database read.
//   • Cleared when a different user primes, and on sign-out.
//   • Every consumer degrades to the network path when the snapshot is absent,
//     so a miss is a slower paint, never a wrong one.

/** Shape shared by both thread lists: `{ id, title, is_archived }`. */
export type SnapshotThreadRow = {
  id:          string;
  title:       string | null;
  is_archived: boolean;
};

export type SnapshotMessageRow = {
  sdk_message_id: string | null;
  parent_id:      string | null;
  format:         string | null;
  content_json:   unknown;
};

export type ServerSnapshot = {
  /** auth.users.id of the user this snapshot was rendered for. */
  userId: string;
  /** Verbatim `fn_list_my_chat_threads()` — every thread, archived included. */
  runtimeThreads?: SnapshotThreadRow[];
  /** Verbatim sidebar first page — non-archived, created_at DESC, PAGE_SIZE. */
  sidebarThreads?: SnapshotThreadRow[];
  /** Verbatim `thread_messages` for one thread, created_at ASC. */
  messages?: {
    threadId: string;
    rows:     SnapshotMessageRow[];
  };
};

// ── Browser-only, and that is a security property, not an optimisation ──────
//
// A "use client" module is ALSO executed on the server during SSR, where module
// scope is per-process and shared by every concurrent request. A store like
// this one, written during render, would let one user's thread titles be read
// while rendering another user's HTML.
//
// So every entry point below is inert outside the browser. On the server the
// readers report "nothing primed" and the app takes its normal network path;
// priming happens on the client during hydration, which is still before the
// runtime's first `list()` (a parent effect). The window where this store can
// hold data is a single browser tab belonging to a single signed-in user.
const isBrowser = typeof window !== "undefined";

type Store = {
  userId:         string;
  runtimeThreads: SnapshotThreadRow[] | null;
  /** The runtime adapter's `list()` may take `runtimeThreads` only once. */
  runtimeTaken:   boolean;
  sidebarThreads: SnapshotThreadRow[] | null;
  messages:       { threadId: string; rows: SnapshotMessageRow[] } | null;
};

let store: Store | null = null;

/**
 * Install a server-rendered snapshot. Called during the render of a client
 * component inside the page — before any consumer has run.
 *
 * A prime for a different user discards whatever was there: two users' data
 * never coexist in this module.
 */
export function primeSnapshot(next: ServerSnapshot): void {
  if (!isBrowser) return;

  const prev = store?.userId === next.userId ? store : null;

  store = {
    userId:         next.userId,
    runtimeThreads: next.runtimeThreads ?? prev?.runtimeThreads ?? null,
    runtimeTaken:   next.runtimeThreads ? false : (prev?.runtimeTaken ?? false),
    sidebarThreads: next.sidebarThreads ?? prev?.sidebarThreads ?? null,
    messages:       next.messages       ?? prev?.messages       ?? null,
  };
}

/** Drop everything. Called on sign-out. */
export function clearSnapshot(): void {
  store = null;
}

/**
 * Take the primed thread list for the runtime adapter's first `list()`.
 * Returns null on every subsequent call, so refreshes go to the database.
 */
export function consumeRuntimeThreads(): SnapshotThreadRow[] | null {
  if (!isBrowser) return null;
  if (!store?.runtimeThreads || store.runtimeTaken) return null;
  store.runtimeTaken = true;
  return store.runtimeThreads;
}

/**
 * Read the sidebar's primed first page without consuming it — the sidebar uses
 * it as initial state and still revalidates against the database afterwards.
 */
export function peekSidebarThreads(): SnapshotThreadRow[] | null {
  if (!isBrowser) return null;
  return store?.sidebarThreads ?? null;
}

/**
 * Take the primed messages for `threadId`, if they were primed for exactly
 * that thread. Removes them — switching away and back re-reads the database.
 */
export function consumeMessages(threadId: string): SnapshotMessageRow[] | null {
  if (!isBrowser) return null;

  const current = store;
  const messages = current?.messages;
  if (!current || !messages || messages.threadId !== threadId) return null;

  current.messages = null;
  return messages.rows;
}
