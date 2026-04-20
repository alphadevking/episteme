// components/assistant-ui/new-chat-shell.tsx
//
// Gold standard approach: the RUNTIME owns thread creation, not this component.
//
// Flow:
//   1. switchToNewThread() — create a blank local thread in the runtime
//   2. runtime.thread.append() — queue the user message
//      → this triggers ChatRuntimeHook's initialize() → fn_create_chat_thread
//      → Supabase assigns a remoteId to the thread
//   3. Wait for state.threadItems[mainThreadId].remoteId to be set
//   4. Navigate to /chat/{remoteId} — no ?q= needed, message is already in state
//
// Why this is correct:
//   • The runtime is the single source of truth. Thread creation goes through
//     the same path as every other action (initialize → append), so the runtime
//     list is always consistent.
//   • No race condition: we navigate AFTER the remoteId exists in runtime state.
//   • No ?q= hack, no ThreadSwitcher lookup failure, no "opens previous chat" bug.
"use client";

import { ArrowUpIcon, Bot, PaperclipIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FC, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Suggestion } from "@/lib/suggestions";
import { useAssistantRuntime } from "@assistant-ui/react";
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

type Props = { suggestions: Suggestion[] };

export const NewChatShell: FC<Props> = ({ suggestions }) => {
  return (
    <SidebarProvider>
      <div className="flex h-dvh w-full pr-0.5">
        <ThreadListSidebar />
        <SidebarInset>
          <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/30 px-4 backdrop-blur-sm">
            <SidebarTrigger className="-ml-1 size-8" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage className="font-medium text-foreground/80 tracking-tight">
                    Episteme Chat
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </header>
          <div className="flex flex-1 flex-col overflow-hidden">
            <NewChatComposer suggestions={suggestions} />
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
};

// ── Composer ───────────────────────────────────────────────────────────────

const NewChatComposer: FC<Props> = ({ suggestions }) => {
  const runtime  = useAssistantRuntime();
  const router   = useRouter();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [value,   setValue]   = useState("");
  const [sending, setSending] = useState(false);

  // Switch to a blank local thread on mount so the sidebar doesn't keep the
  // previous thread highlighted while the user is composing a new message.
  useEffect(() => {
    const state    = runtime.threads.getState();
    const mainItem = state.threadItems[state.mainThreadId];
    if (mainItem?.remoteId) {
      runtime.threads.switchToNewThread().catch(() => {});
    }
  }, [runtime]);

  const send = useCallback(async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || sending) return;
    setSending(true);

    try {
      // 1. Switch to a brand-new local thread (synchronous in the runtime).
      await runtime.threads.switchToNewThread();

      // 2. Append the message. This triggers initialize() inside ChatRuntimeHook
      //    which calls fn_create_chat_thread and sets remoteId on the thread.
      runtime.thread.append({
        role:    "user",
        content: [{ type: "text", text: trimmed }],
      });

      // 3. Helper: read the remoteId of the current main thread.
      const getRemoteId = (): string | undefined => {
        const s = runtime.threads.getState();
        return s.threadItems[s.mainThreadId]?.remoteId;
      };

      // 4. Navigate as soon as remoteId is available. In most cases initialize()
      //    completes synchronously within the same microtask batch, so the
      //    immediate check fires and we avoid the subscribe overhead entirely.
      const navigate = (remoteId: string) => router.push(`/chat/${remoteId}`);

      const immediate = getRemoteId();
      if (immediate) { navigate(immediate); return; }

      // 5. Otherwise wait via subscription (initialize() is async).
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsub();
          reject(new Error("[new-chat] timed out waiting for thread remoteId"));
        }, 10_000);

        const unsub = runtime.threads.subscribe(() => {
          const remoteId = getRemoteId();
          if (!remoteId) return;
          clearTimeout(timer);
          unsub();
          navigate(remoteId);
          resolve();
        });
      });
    } catch (e) {
      console.error("[new-chat] send failed:", e);
      setSending(false);
    }
  }, [sending, runtime, router]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(value);
    }
  };

  // ── Loading overlay ───────────────────────────────────────────────────────
  if (sending) {
    return (
      <div className="aui-root flex h-full flex-col items-center justify-center gap-4 bg-background">
        <span className="size-8 animate-spin rounded-full border-[3px] border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground animate-pulse">Starting conversation…</p>
      </div>
    );
  }

  // ── Welcome + composer ────────────────────────────────────────────────────
  return (
    <div
      className="aui-root @container flex h-full flex-col bg-background"
      style={{ ["--thread-max-width" as string]: "48rem" }}
    >
      {/* Centre content */}
      <div className="flex flex-1 flex-col items-center justify-center px-4">
        <div className="w-full max-w-(--thread-max-width) space-y-6">
          <div className="px-1">
            <div className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both mb-4 flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/75 shadow-md shadow-primary/25 duration-200">
              <Bot className="size-5 text-primary-foreground" />
            </div>
            <h1 className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both font-serif font-semibold text-2xl duration-200 delay-50">Hello there!</h1>
            <p className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both mt-1 text-base text-muted-foreground delay-100 duration-200">
              How can I help you today?
            </p>
          </div>

          {suggestions.length > 0 && (
            <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
              {suggestions.map((s, i) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => send(s.prompt)}
                  style={{ animationDelay: `${i * 60}ms` }}
                  className={cn(
                    "fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200",
                    "group flex flex-col items-start gap-1 rounded-lg border border-border",
                    "bg-card px-4 py-3.5 text-left transition-colors",
                    "hover:border-primary/40 hover:bg-primary/5",
                    i >= 2 ? "hidden @md:flex" : "flex",
                  )}
                >
                  <span className="font-serif font-medium text-sm text-foreground group-hover:text-primary transition-colors">
                    {s.label}
                  </span>
                  <span className="text-xs leading-relaxed text-muted-foreground line-clamp-2">
                    {s.prompt}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="mx-auto w-full max-w-(--thread-max-width) px-4 pb-4 md:pb-6">
        <div
          className={cn(
            "flex w-full flex-col gap-0 rounded-xl border bg-card px-4 pt-3 pb-3",
            "border-border shadow-sm transition-all duration-150",
            "focus-within:border-primary focus-within:shadow-md focus-within:shadow-primary/10",
            "focus-within:ring-4 focus-within:ring-primary/10",
          )}
        >
          <textarea
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="How can Episteme help you today?"
            rows={1}
            autoFocus
            className="max-h-40 min-h-[36px] w-full resize-none bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground leading-relaxed"
          />
          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              disabled
              aria-label="Attach file (not available)"
              title="Attach file"
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground/40 cursor-not-allowed"
            >
              <PaperclipIcon className="size-4" />
            </button>
            <Button
              type="button"
              variant="default"
              size="icon"
              disabled={!value.trim()}
              onClick={() => send(value)}
              className="size-8 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:shadow-md hover:shadow-primary/20 disabled:opacity-40"
              aria-label="Send message"
            >
              <ArrowUpIcon className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};