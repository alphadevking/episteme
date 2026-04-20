"use client";

// components/assistant-ui/feedback-buttons.tsx
// Thumbs-up / thumbs-down feedback on assistant messages.
//
// Design constraints:
//   - Must not render while the thread is running (hideWhenRunning parity)
//   - Autohide on non-last messages (matches AssistantActionBar behaviour)
//   - Single submission per message per user (server enforces via unique constraint)
//   - Optimistic state: button fills immediately, reverts on error
//   - Persisted state: existing vote is loaded from DB on mount and branch switch

import { useAuiState } from "@assistant-ui/react";
import { ThumbsUpIcon, ThumbsDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useCallback, useEffect } from "react";
import { useParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type Vote = "up" | "down" | null;

function useThreadId(): string | null {
  const params = useParams();
  // On /chat/[threadId], params.threadId is the Supabase remoteId (UUID)
  return (params?.threadId as string) ?? null;
}

export function FeedbackButtons({ className }: { className?: string }) {
  const role      = useAuiState((s) => s.message.role);
  const messageId = useAuiState((s) => s.message.id);
  const threadId  = useThreadId();
  const [vote, setVote]       = useState<Vote>(null);
  const [pending, setPending] = useState(false);

  // Load existing vote from DB whenever the visible message/branch changes.
  // Delegates to fn_get_message_feedback (SECURITY DEFINER) — consistent with
  // the rest of the codebase; no direct table access from the client.
  useEffect(() => {
    if (!messageId) { setVote(null); return; }

    let cancelled = false;
    const supabase = createSupabaseBrowserClient();

    supabase
      .rpc("fn_get_message_feedback", { p_sdk_message_id: messageId })
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setVote(data == null ? null : data.helpful ? "up" : "down");
      });

    return () => { cancelled = true; };
  }, [messageId]);

  // Only render on completed assistant messages with a known id
  if (role !== "assistant") return null;
  if (!messageId)           return null;

  const submit = useCallback(
    async (value: "up" | "down") => {
      if (pending) return;
      if (!threadId) return;

      // Optimistic update
      const previous = vote;
      setVote(value);
      setPending(true);

      try {
        const res = await fetch("/api/chat/feedback", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            threadId,
            sdkMessageId: messageId,
            helpful:      value === "up",
          }),
        });
        if (!res.ok) throw new Error("Server error");
      } catch {
        // Revert on failure
        setVote(previous);
      } finally {
        setPending(false);
      }
    },
    [pending, threadId, vote, messageId],
  );

  return (
    <div
      className={cn(
        "flex items-center gap-0 rounded-full border border-border/60",
        "bg-background/90 px-1 py-0.5 shadow-sm backdrop-blur-sm",
        className,
      )}
      aria-label="Was this response helpful?"
    >
      <button
        type="button"
        disabled={pending}
        onClick={() => submit("up")}
        aria-label="Helpful"
        aria-pressed={vote === "up"}
        className={cn(
          "flex size-7 items-center justify-center rounded-full transition-colors",
          "hover:bg-primary/10 hover:text-primary disabled:pointer-events-none disabled:opacity-50",
          vote === "up"
            ? "text-primary bg-primary/10"
            : "text-muted-foreground",
        )}
      >
        <ThumbsUpIcon className={cn("size-3.5", vote === "up" && "fill-primary")} />
      </button>

      <div className="mx-0.5 h-3.5 w-px bg-border/60" />

      <button
        type="button"
        disabled={pending}
        onClick={() => submit("down")}
        aria-label="Not helpful"
        aria-pressed={vote === "down"}
        className={cn(
          "flex size-7 items-center justify-center rounded-full transition-colors",
          "hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50",
          vote === "down"
            ? "text-destructive bg-destructive/10"
            : "text-muted-foreground",
        )}
      >
        <ThumbsDownIcon className={cn("size-3.5", vote === "down" && "fill-destructive")} />
      </button>
    </div>
  );
}
