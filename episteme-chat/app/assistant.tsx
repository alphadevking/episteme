// app/assistant.tsx
"use client";

import { useAssistantRuntime } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/thread";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import type { Suggestion } from "@/lib/suggestions";
import { useEffect, useMemo, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type Props = {
  suggestions:     Suggestion[];
  initialMessage?: string;
  threadId?:       string;
  initialTitle?:   string;
};

export const Assistant = ({ suggestions, initialMessage, threadId, initialTitle }: Props) => {
  const runtime        = useAssistantRuntime();
  const didSendInitial = useRef(false);

  // Server-fetched title is correct on first paint.
  const [threadTitle, setThreadTitle]   = useState<string>(initialTitle ?? "Episteme Chat");
  const [titleLoading, setTitleLoading] = useState(false);
  // Tracks whether the current remoteId is the one the server already gave us a title for.
  const initialRemoteId = useRef(threadId);
  // Set once the server-provided title has been honoured, so it is never
  // re-used after the title state has moved on to another thread.
  const initialTitleUsed = useRef(false);

  // Track the remoteId of the currently active thread via the runtime.
  // This updates on every thread switch — including pushState switches where
  // the component stays mounted and props don't change.
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [currentRemoteId, setCurrentRemoteId] = useState<string | undefined>(threadId);

  // Only derive the active remoteId from the runtime — never the title.
  // Runtime list cache is stale ("New conversation") until Mastra writes to DB.
  // Title comes exclusively from Supabase below.
  useEffect(() => {
    const read = () => {
      const s    = runtime.threads.getState();
      const item = s.threadItems[s.mainThreadId];
      if (item?.remoteId) setCurrentRemoteId(item.remoteId);
    };
    read();
    return runtime.threads.subscribe(read);
  }, [runtime]);

  // When the active remoteId changes, fetch the authoritative title from
  // Supabase and subscribe to live updates (Mastra writes titles directly to DB).
  useEffect(() => {
    if (!currentRemoteId) return;

    // The server already resolved this exact thread's title and it is on screen.
    // Re-querying it would spend a round-trip to learn what we were told — and
    // the realtime subscription below still catches any later change, so this
    // skips the fetch without giving up liveness.
    //
    // Strictly one-shot: after switching to another thread, `threadTitle` holds
    // that other thread's title, so coming BACK here must re-fetch rather than
    // trust a flag that is still nominally true.
    const isInitial =
      !initialTitleUsed.current &&
      currentRemoteId === initialRemoteId.current &&
      !!initialTitle;
    initialTitleUsed.current = true;

    if (!isInitial) {
      setTitleLoading(true);

      supabase
        .from("chat_threads")
        .select("title")
        .eq("id", currentRemoteId)
        .maybeSingle()
        .then(({ data }) => {
          if (data?.title?.trim()) setThreadTitle(data.title.trim());
          setTitleLoading(false);
        });
    }

    const channel = supabase
      .channel(`thread-title:${currentRemoteId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "chat_threads", filter: `id=eq.${currentRemoteId}` },
        (payload) => {
          const title = (payload.new as { title?: string }).title;
          if (title?.trim()) setThreadTitle(title.trim());
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [currentRemoteId, supabase]);
  // Send ?q= message only after the correct thread is active
  useEffect(() => {
    if (!initialMessage)        return;
    if (didSendInitial.current) return;

    const tryAppend = () => {
      const state    = runtime.threads.getState();
      const mainId   = state.mainThreadId;
      const remoteId = state.threadItems[mainId]?.remoteId;

      // Only send when the active thread matches our threadId
      if (threadId && remoteId !== threadId) return false;

      didSendInitial.current = true;
      runtime.thread.append({
        role:    "user",
        content: [{ type: "text", text: initialMessage }],
      });

      const url = new URL(window.location.href);
      url.searchParams.delete("q");
      window.history.replaceState({}, "", url.toString());
      return true;
    };

    // Try immediately
    if (tryAppend()) return;

    // Otherwise wait for thread to become active
    const unsub = runtime.threads.subscribe(() => {
      if (tryAppend()) unsub();
    });

    const timer = setTimeout(() => unsub(), 10_000);
    return () => { unsub(); clearTimeout(timer); };
  }, [initialMessage, threadId, runtime]);

  useEffect(() => {
    didSendInitial.current = false;
  }, [threadId]);

  return (
    <SidebarProvider>
      <div className="flex h-dvh w-full pr-0.5">
        <ThreadListSidebar />
        <SidebarInset>
          <header className="flex h-12 shrink-0 items-center justify-between border-b bg-background/30 px-4 backdrop-blur-sm">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="-ml-1 size-8" />
              <Separator orientation="vertical" className="mr-2 h-4" />
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbPage className="font-medium text-foreground/80 tracking-tight">
                      {titleLoading ? (
                        <span className="inline-block h-4 w-36 animate-pulse rounded bg-muted align-middle" />
                      ) : (
                        threadTitle
                      )}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </div>
          </header>
          <div className="flex-1 overflow-hidden">
            <Thread suggestions={suggestions} initialMessage={initialMessage} threadId={threadId} />
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
};