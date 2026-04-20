// components/assistant-ui/thread-list.tsx
//
// Data strategy:
//   • Supabase-first: the component fetches its own paginated list directly
//     from chat_threads, ordered by created_at DESC, PAGE_SIZE rows at a time.
//   • Runtime subscription: used ONLY to track which thread is active (isMain).
//     Never used as a title/data source — the runtime list cache is stale by design.
//   • Supabase Realtime: keeps the displayed list live across tabs and devices.
//   • localStorage: stale-while-revalidate seed, user-scoped key, capped at CACHE_MAX entries.
//   • Virtualized: only visible rows are in the DOM regardless of list size.
"use client";

import { useAssistantRuntime } from "@assistant-ui/react";
import type { FC } from "react";
import { cn } from "@/lib/utils";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { MoreHorizontalIcon, PencilIcon, ArchiveIcon, Trash2Icon, Sparkles, Loader2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { Tables } from "@/lib/types/database";
import { useUser } from "@/lib/hooks/use-user";

// ── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 30;
const CACHE_MAX = 50;
const cacheKey = (userId: string) => `episteme:thread-list:${userId}`;

// ── Types ──────────────────────────────────────────────────────────────────

/** Persisted + display shape — remoteId is the primary key throughout. */
type CachedThread = {
  remoteId: string;
  title:    string | undefined;
  status:   "regular" | "archived";
};

type ThreadItem = CachedThread & { isMain: boolean };

type ChatThreadRow = Tables<"chat_threads">;

// ── Session cache ──────────────────────────────────────────────────────────

function readCache(key: string): CachedThread[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as CachedThread[]) : [];
  } catch {
    return [];
  }
}

/** Writes up to CACHE_MAX entries — silently drops the rest. */
function writeCache(key: string, threads: CachedThread[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(threads.slice(0, CACHE_MAX)));
  } catch { /* storage quota / SSR */ }
}

// ── Component ──────────────────────────────────────────────────────────────

export const ThreadList: FC = () => {
  const runtime  = useAssistantRuntime();
  const router   = useRouter();
  const pathname = usePathname();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const { user } = useUser();
  const userId   = user?.id ?? null;

  const [threads,      setThreads]      = useState<CachedThread[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [hasMore,      setHasMore]      = useState(false);
  const [loadingMore,  setLoadingMore]  = useState(false);
  const [mainRemoteId, setMainRemoteId] = useState<string | undefined>();
  const userCacheKey = useRef<string | null>(null);

  const [renaming, setRenaming] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  // ── 1. Initial Supabase fetch (first page) ─────────────────────────────

  useEffect(() => {
    // Clear state when no user is present (e.g. after sign-out).
    if (!userId) {
      userCacheKey.current = null;
      setThreads([]);
      setLoading(false);
      return;
    }

    const key = cacheKey(userId);
    userCacheKey.current = key;

    // Seed from this user's cache for instant first paint.
    const cached = readCache(key);
    if (cached.length > 0) {
      setThreads(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }

    supabase
      .from("chat_threads")
      .select("id, title, is_archived")
      .eq("is_archived", false)
      .order("created_at", { ascending: false })
      .range(0, PAGE_SIZE - 1)
      .then(({ data }) => {
        if (!data) { setLoading(false); return; }
        const items: CachedThread[] = data.map((row) => ({
          remoteId: row.id,
          title:    row.title ?? "New conversation",
          status:   row.is_archived ? "archived" : "regular",
        }));
        setThreads(items);
        setHasMore(data.length === PAGE_SIZE);
        writeCache(key, items);
        setLoading(false);
      });
  }, [supabase, userId]);

  // ── 2. Runtime subscription — isMain only ──────────────────────────────

  useEffect(() => {
    const read = () => {
      const s    = runtime.threads.getState();
      const item = s.threadItems[s.mainThreadId];
      setMainRemoteId(item?.remoteId);
    };
    read();
    return runtime.threads.subscribe(read);
  }, [runtime]);

  // Derive isMain from mainRemoteId — O(n), no extra fetches.
  const displayThreads = useMemo<ThreadItem[]>(
    () => threads.map((t) => ({ ...t, isMain: t.remoteId === mainRemoteId })),
    [threads, mainRemoteId],
  );

  // ── 3. Supabase Realtime (cross-tab / cross-device) ────────────────────

  useEffect(() => {
    const channel = supabase
      .channel("thread-list-realtime")
      .on<ChatThreadRow>(
        "postgres_changes",
        { event: "*", schema: "public", table: "chat_threads" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const row = payload.new;
            if (row.is_archived) return;
            setThreads((prev) => {
              if (prev.some((t) => t.remoteId === row.id)) return prev;
              const updated = [
                { remoteId: row.id, title: row.title ?? "New conversation", status: "regular" as const },
                ...prev,
              ];
              if (userCacheKey.current) writeCache(userCacheKey.current, updated);
              return updated;
            });
          } else if (payload.eventType === "UPDATE") {
            const row = payload.new;
            setThreads((prev) => {
              const updated = prev
                .map((t) =>
                  t.remoteId === row.id
                    ? { ...t, title: row.title || t.title, status: row.is_archived ? "archived" as const : "regular" as const }
                    : t,
                )
                .filter((t) => t.status === "regular");
              if (userCacheKey.current) writeCache(userCacheKey.current, updated);
              return updated;
            });
          } else if (payload.eventType === "DELETE") {
            const deletedId = payload.old.id;
            if (!deletedId) return;
            setThreads((prev) => {
              const updated = prev.filter((t) => t.remoteId !== deletedId);
              if (userCacheKey.current) writeCache(userCacheKey.current, updated);
              return updated;
            });
          }
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [supabase]);

  // ── 4. Load more ───────────────────────────────────────────────────────

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    const { data } = await supabase
      .from("chat_threads")
      .select("id, title, is_archived")
      .eq("is_archived", false)
      .order("created_at", { ascending: false })
      .range(threads.length, threads.length + PAGE_SIZE - 1);

    if (data) {
      const items: CachedThread[] = data.map((row) => ({
        remoteId: row.id,
        title:    row.title ?? "New conversation",
        status:   row.is_archived ? "archived" : "regular",
      }));
      setThreads((prev) => {
        const deduped = items.filter((n) => !prev.some((p) => p.remoteId === n.remoteId));
        // Don't expand the cache beyond CACHE_MAX — only the first page is cached.
        return [...prev, ...deduped];
      });
      setHasMore(data.length === PAGE_SIZE);
    }
    setLoadingMore(false);
  }, [supabase, threads.length]);

  // ── 5. Smart actions (runtime-first, Supabase fallback) ───────────────

  /** Find the local runtime thread ID for a given remoteId, if loaded. */
  const findLocalId = useCallback(
    (remoteId: string): string | undefined =>
      Object.entries(runtime.threads.getState().threadItems).find(
        ([, item]) => item.remoteId === remoteId,
      )?.[0],
    [runtime],
  );

  const switchTo = useCallback(
    async (remoteId: string) => {
      const localId = findLocalId(remoteId);
      if (localId) await runtime.threads.switchToThread(localId);
      if (pathname === "/chat" || !localId) {
        router.push(`/chat/${remoteId}`);
      } else {
        window.history.pushState({}, "", `/chat/${remoteId}`);
      }
    },
    [runtime, pathname, router, findLocalId],
  );

  const startRename = (remoteId: string, currentTitle: string) => {
    setRenaming(remoteId);
    setNewTitle(currentTitle);
    setMenuOpen(null);
  };

  const commitRename = async (remoteId: string) => {
    if (!newTitle.trim()) { setRenaming(null); return; }
    try {
      const localId = findLocalId(remoteId);
      if (localId) {
        await runtime.threads.getItemById(localId).rename(newTitle.trim());
      } else {
        await supabase.rpc("fn_update_chat_thread", { p_thread_id: remoteId, p_title: newTitle.trim() });
      }
    } catch (e) {
      console.error("[thread-list] rename failed:", e);
    }
    setRenaming(null);
  };

  const archiveThread = async (remoteId: string, isMain: boolean) => {
    setMenuOpen(null);
    try {
      const localId = findLocalId(remoteId);
      if (localId) {
        await runtime.threads.getItemById(localId).archive();
      } else {
        await supabase.rpc("fn_update_chat_thread", { p_thread_id: remoteId, p_archived: true });
      }
      if (isMain) router.push("/chat");
    } catch (e) {
      console.error("[thread-list] archive failed:", e);
    }
  };

  const deleteThread = async (remoteId: string, isMain: boolean) => {
    setMenuOpen(null);
    try {
      const localId = findLocalId(remoteId);
      if (localId) {
        await runtime.threads.getItemById(localId).delete();
      } else {
        await supabase.rpc("fn_delete_chat_thread", { p_thread_id: remoteId });
      }
      if (isMain) router.push("/chat");
    } catch (e) {
      console.error("[thread-list] delete failed:", e);
    }
  };

  // ── 6. Virtualizer ─────────────────────────────────────────────────────

  const scrollRef = useRef<HTMLDivElement>(null);

  // Include a synthetic "load more" row at the end when hasMore is true.
  const totalCount = displayThreads.length + (hasMore ? 1 : 0);

  const virtualizer = useVirtualizer({
    count:           totalCount,
    getScrollElement: () => scrollRef.current,
    estimateSize:    () => 36,
    overscan:        5,
  });

  // ── Render ─────────────────────────────────────────────────────────────

  const SectionLabel = () => (
    <div className="mb-1.5 flex items-center gap-2 px-3">
      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/60">
        Recent
      </span>
      <div className="h-px flex-1 bg-gradient-to-r from-border/60 to-transparent" />
    </div>
  );

  if (loading) {
    return (
      <div aria-busy="true" aria-label="Loading conversations">
        <SectionLabel />
        <div className="space-y-0.5 px-1">
          {[72, 50, 88, 62, 76].map((w, i) => (
            <div key={i} className="flex items-center gap-2 rounded-md px-3 py-2.5">
              <div
                className="h-[13px] rounded-full bg-gradient-to-r from-muted via-accent/70 to-muted bg-[length:200%_100%] animate-shimmer"
                style={{ width: `${w}%`, animationDelay: `${i * 90}ms` }}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (displayThreads.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <div className="flex size-9 items-center justify-center rounded-full bg-primary/10">
          <Sparkles className="size-4 text-primary/60" />
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          No conversations yet.<br />Start one above.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <SectionLabel />
      {/* Scroll container — fills all remaining sidebar height */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vRow) => {
            // Last virtual row = "Load more" sentinel
            if (vRow.index === displayThreads.length) {
              return (
                <div
                  key="load-more"
                  style={{ position: "absolute", top: vRow.start, width: "100%" }}
                >
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-2 text-[12px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground disabled:opacity-50"
                  >
                    {loadingMore ? <Loader2 className="size-3 animate-spin" /> : "Load more"}
                  </button>
                </div>
              );
            }

            const t = displayThreads[vRow.index];
            return (
              <div
                key={t.remoteId}
                style={{ position: "absolute", top: vRow.start, width: "100%" }}
                className={cn(
                  "group flex items-center rounded-md px-3 py-2 text-[13px] transition-all duration-150 border-l-4",
                  t.isMain
                    ? "border-primary bg-primary/10 text-primary font-semibold pl-2.5"
                    : "border-transparent text-sidebar-foreground hover:bg-sidebar-accent",
                )}
              >
                {renaming === t.remoteId ? (
                  <input
                    autoFocus
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    onBlur={() => commitRename(t.remoteId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(t.remoteId);
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    className="flex-1 bg-transparent outline-none ring-1 ring-primary/40 rounded px-1 text-[13px]"
                  />
                ) : (
                  <button
                    className="flex-1 truncate text-left font-serif leading-snug"
                    onClick={() => switchTo(t.remoteId)}
                  >
                    {t.title ?? "New conversation"}
                  </button>
                )}

                <div className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity relative">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(menuOpen === t.remoteId ? null : t.remoteId);
                    }}
                    className="rounded-md p-1 transition-colors hover:bg-primary/10 hover:text-primary"
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </button>

                  {menuOpen === t.remoteId && (
                    <div className="absolute right-0 top-7 z-50 min-w-36 rounded-lg border border-border/60 bg-popover p-1 shadow-lg text-[13px]">
                      <button
                        onClick={() => startRename(t.remoteId, t.title ?? "")}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors hover:bg-primary/10 hover:text-primary"
                      >
                        <PencilIcon className="size-3.5 shrink-0" /> Rename
                      </button>
                      <button
                        onClick={() => archiveThread(t.remoteId, t.isMain)}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors hover:bg-primary/10 hover:text-primary"
                      >
                        <ArchiveIcon className="size-3.5 shrink-0" /> Archive
                      </button>
                      <div className="my-1 h-px bg-border/40" />
                      <button
                        onClick={() => deleteThread(t.remoteId, t.isMain)}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
                      >
                        <Trash2Icon className="size-3.5 shrink-0" /> Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
