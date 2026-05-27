// app/episteme-runtime.tsx
// Uses useRemoteThreadListRuntime directly — the correct API for custom adapters.
// useChatRuntime internally uses AssistantCloud for thread management and ignores
// adapters.threadList for RemoteThreadListAdapter purposes.
"use client";

import {
  AssistantRuntimeProvider,
  useRemoteThreadListRuntime,
  useAssistantRuntime,
} from "@assistant-ui/react";
import { useAISDKRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { useChat } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import type { FC, ReactNode } from "react";
import { useMemo, useCallback, useEffect, Fragment } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { SupabaseThreadListAdapter } from "@/lib/runtime/supabase-thread-list-adapter";
import { useSupabaseHistoryAdapter } from "@/lib/runtime/use-supabase-history-adapter";
import { toast } from "sonner";

// No PerThreadProvider needed — history adapter is passed directly to
// useAISDKRuntime inside ChatRuntimeHook, bypassing the broken
// RuntimeAdapterProvider context (two @assistant-ui/core instances in pnpm).

// ── Thread switcher ───────────────────────────────────────────────────────
// Finds the local thread ID by matching remoteId, then switches to it.
export const ThreadSwitcher: FC<{ threadId: string }> = ({ threadId }) => {
  const runtime = useAssistantRuntime();

  useEffect(() => {
    if (!threadId) return;

    const trySwitch = (s = runtime.threads.getState()): boolean => {
      // Already on the correct thread — nothing to do.
      const mainRemoteId = s.threadItems[s.mainThreadId]?.remoteId;
      if (mainRemoteId === threadId) return true;

      // Find the local thread whose remoteId matches and switch to it.
      const found = Object.entries(s.threadItems).find(
        ([, item]) => item.remoteId === threadId,
      );
      if (!found) return false;

      runtime.threads.switchToThread(found[0]).catch((e) => {
        console.error("[ThreadSwitcher] switchToThread failed:", e);
      });
      return true;
    };

    if (trySwitch()) return;

    // Thread not yet in list — subscribe and wait.
    const unsub = runtime.threads.subscribe(() => {
      if (trySwitch()) unsub();
    });

    const timer = setTimeout(() => unsub(), 10_000);
    return () => { unsub(); clearTimeout(timer); };
  }, [threadId, runtime]);

  return null;
};

// ── Root provider ─────────────────────────────────────────────────────────
type Props = { children: ReactNode };

export const EpistemeRuntimeProvider: FC<Props> = ({ children }) => {
  const supabase      = useMemo(() => createSupabaseBrowserClient(), []);
  const threadAdapter = useMemo(() => new SupabaseThreadListAdapter(supabase), [supabase]);

  // Mastra's stream includes internal metadata events (scorer results, memory
  // title-gen callbacks) that produce chunks with no recognised type in the
  // assistant-ui accumulator. The error is benign — chat works normally — but
  // it creates noisy red "Uncaught (in promise)" entries. Intercept and demote
  // to debug so it stays discoverable without polluting the console.
  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      if (
        typeof event.reason?.message === "string" &&
        event.reason.message.includes("Unsupported chunk type")
      ) {
        event.preventDefault();
        console.debug("[episteme/stream] Mastra chunk skipped by assistant-ui accumulator:", event.reason.message);
      }
    };
    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }, []);

  const runtime = useRemoteThreadListRuntime({
    adapter: {
      list:            threadAdapter.list.bind(threadAdapter),
      initialize:      threadAdapter.initialize.bind(threadAdapter),
      fetch:           threadAdapter.fetch.bind(threadAdapter),
      rename:          threadAdapter.rename.bind(threadAdapter),
      archive:         threadAdapter.archive.bind(threadAdapter),
      unarchive:       threadAdapter.unarchive.bind(threadAdapter),
      delete:          threadAdapter.delete.bind(threadAdapter),
      generateTitle:   threadAdapter.generateTitle.bind(threadAdapter),
      unstable_Provider: Fragment,
    } as unknown as Parameters<typeof useRemoteThreadListRuntime>[0]["adapter"],

    // runtimeHook: runs per-thread inside ThreadListItemRuntimeProvider context.
    // History adapter passed directly here — avoids the broken RuntimeAdapterProvider
    // cross-context issue (two @assistant-ui/core instances resolved by pnpm).
    runtimeHook: function ChatRuntimeHook() {
      const historyAdapter = useSupabaseHistoryAdapter();
      // Memoize transport — creating a new object every render causes useChat to
      // reinitialize, which fires thread.initialize and scrolls to bottom mid-conversation.
      const transport = useMemo(() => new AssistantChatTransport({ api: "/api/chat" }), []);
      const onError = useCallback((error: Error) => {
        const status = (error as { status?: number }).status
          ?? ((error as { cause?: { status?: number } }).cause?.status);

        if (status === 503) {
          toast.error("Assistant unavailable", {
            description: "The AI service is temporarily unreachable. Please try again in a moment.",
            duration: 8000,
          });
        } else if (status === 429) {
          toast.error("Too many requests", {
            description: "You've sent messages too quickly. Please wait a moment before continuing.",
            duration: 6000,
          });
        } else if (status === 401) {
          toast.error("Session expired", {
            description: "Your session has expired. Please refresh the page to continue.",
            duration: 0,
            action: { label: "Refresh", onClick: () => window.location.reload() },
          });
        } else if (status && status >= 500) {
          toast.error("Something went wrong", {
            description: "The assistant encountered an error. Your conversation is safe — please try again.",
            duration: 6000,
          });
        } else {
          toast.error("Connection issue", {
            description: "Couldn't reach the assistant. Please check your connection and try again.",
            duration: 6000,
          });
        }
      }, []);

      const chat = useChat({
        transport,
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
        onError,
      });

      return useAISDKRuntime(chat, { adapters: { history: historyAdapter as unknown as NonNullable<NonNullable<Parameters<typeof useAISDKRuntime>[1]>["adapters"]>["history"] } });
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
};