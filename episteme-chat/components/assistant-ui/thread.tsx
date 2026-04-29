// app/components/assistant-ui/thread.tsx

import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { Reasoning, ReasoningGroup } from "@/components/assistant-ui/reasoning";
import { FeedbackButtons } from "@/components/assistant-ui/feedback-buttons";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useThreadRuntime,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  Bot,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
  ArrowUpIcon,
  Sparkles,
} from "lucide-react";
import { type FC, useSyncExternalStore } from "react";
import { useUser } from "@/lib/hooks/use-user";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { Suggestion } from "@/lib/suggestions";

// ── Avatars ───────────────────────────────────────────────────────────────

const AssistantAvatar: FC = () => {
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-gradient-to-br from-primary/15 to-primary/5 text-primary shadow-sm shadow-primary/10">
      <Bot className="size-4" />
    </div>
  );
};

const UserAvatar: FC = () => {
  const { user } = useUser();
  const label = user?.fullName || user?.email || "U";
  const fallback = (label[0] || "U").toUpperCase();

  return (
    <Avatar className="size-8 shrink-0 border border-border/50">
      {user?.avatarUrl ? (
        <AvatarImage src={user.avatarUrl} alt={label} />
      ) : null}
      <AvatarFallback className="bg-secondary text-secondary-foreground text-xs font-semibold">
        {fallback}
      </AvatarFallback>
    </Avatar>
  );
};

// ── Thinking indicator (shown between user send and first streaming token) ─

const ThinkingDots: FC = () => (
  <div className="mx-auto flex w-full max-w-(--thread-max-width) items-start gap-4 py-4">
    <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-gradient-to-br from-primary/15 to-primary/5 text-primary shadow-sm shadow-primary/10">
      <Bot className="size-4" />
    </div>
    <div className="flex items-center gap-1.5 pt-2.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-2 rounded-full bg-primary/50 animate-bounce"
          style={{ animationDelay: `${i * 180}ms`, animationDuration: "900ms" }}
        />
      ))}
    </div>
  </div>
);

// ── Thread root ───────────────────────────────────────────────────────────

type ThreadProps = {
  suggestions:     Suggestion[];
  initialMessage?: string;
  threadId?:       string;
};

export const Thread: FC<ThreadProps> = ({ suggestions, initialMessage, threadId }) => {
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root @container flex h-full flex-col bg-background"
      style={{
        ["--thread-max-width" as string]: "48rem",
        ["--composer-radius" as string]: "var(--radius)",
        ["--composer-padding" as string]: "16px",
      }}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        className="aui-thread-viewport relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth px-4 pt-4"
      >
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <ThreadWelcome suggestions={suggestions} initialMessage={initialMessage} threadId={threadId} />
        </AuiIf>

        <ThreadPrimitive.Messages
          components={{
            EditComposer,
            UserMessage,
            AssistantMessage,
          }}
        />

        {/* Thinking dots — visible only during the gap between user send and
            the first streaming token. Once the assistant message starts rendering
            (even if empty), the last message is no longer a user message and
            this hides automatically. */}
        <AuiIf condition={(s) => {
          if (!s.thread.isRunning) return false;
          const msgs = s.thread.messages;
          if (!msgs.length) return false;
          return msgs[msgs.length - 1]?.role === "user";
        }}>
          <ThinkingDots />
        </AuiIf>

        <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 overflow-visible rounded-t-(--composer-radius) bg-background pb-4 md:pb-6">
          <ThreadScrollToBottom />
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

// ── Scroll to bottom ──────────────────────────────────────────────────────

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible dark:border-border dark:bg-background dark:hover:bg-accent"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

// ── Message skeleton (shown while loading an existing thread) ────────────

// Reusable shimmer line with branded sweep animation.
function ShimmerLine({ w, delay = 0 }: { w: string; delay?: number }) {
  return (
    <div
      className="h-[13px] rounded-full bg-gradient-to-r from-muted via-accent/70 to-muted bg-[length:200%_100%] animate-shimmer"
      style={{ width: w, animationDelay: `${delay}ms` }}
    />
  );
}

const ThreadSkeleton: FC = () => (
  <div className="mx-auto w-full max-w-(--thread-max-width) grow space-y-6 pt-6">
    {/* Exchange 1 — User */}
    <div className="flex items-start gap-4">
      <div className="size-8 shrink-0 rounded-full bg-gradient-to-r from-muted via-accent/70 to-muted bg-[length:200%_100%] animate-shimmer" />
      <div className="flex-1 space-y-2 pt-1">
        <ShimmerLine w="38%" delay={60} />
        <ShimmerLine w="55%" delay={120} />
      </div>
    </div>

    {/* Exchange 1 — Assistant */}
    <div className="flex items-start gap-4">
      <div className="size-8 shrink-0 rounded-full border border-primary/20 bg-primary/10 flex items-center justify-center">
        <div className="size-4 rounded-full bg-gradient-to-r from-primary/30 via-primary/60 to-primary/30 bg-[length:200%_100%] animate-shimmer" />
      </div>
      <div className="flex-1 space-y-2 pt-1">
        <ShimmerLine w="78%" delay={80} />
        <ShimmerLine w="65%" delay={140} />
        <ShimmerLine w="50%" delay={200} />
        <ShimmerLine w="85%" delay={260} />
      </div>
    </div>

    {/* Exchange 2 — User */}
    <div className="flex items-start gap-4">
      <div className="size-8 shrink-0 rounded-full bg-gradient-to-r from-muted via-accent/70 to-muted bg-[length:200%_100%] animate-shimmer" style={{ animationDelay: "100ms" }} />
      <div className="flex-1 space-y-2 pt-1">
        <ShimmerLine w="42%" delay={160} />
      </div>
    </div>

    {/* Exchange 2 — Assistant */}
    <div className="flex items-start gap-4">
      <div className="size-8 shrink-0 rounded-full border border-primary/20 bg-primary/10 flex items-center justify-center">
        <div className="size-4 rounded-full bg-gradient-to-r from-primary/30 via-primary/60 to-primary/30 bg-[length:200%_100%] animate-shimmer" style={{ animationDelay: "100ms" }} />
      </div>
      <div className="flex-1 space-y-2 pt-1">
        <ShimmerLine w="82%" delay={180} />
        <ShimmerLine w="60%" delay={240} />
      </div>
    </div>
  </div>
);


// ── Welcome / empty state ─────────────────────────────────────────────────

const ThreadWelcome: FC<{ suggestions: Suggestion[]; initialMessage?: string; threadId?: string }> = ({
  suggestions,
  initialMessage,
  threadId,
}) => {
  // Existing thread navigated to by URL — messages still loading from Supabase.
  // Show a shimmer skeleton so it never flashes suggestions.
  if (threadId && !initialMessage) {
    return <ThreadSkeleton />;
  }

  // Initial message queued (?q= flow) — spinner while it gets appended.
  if (initialMessage) {
    return (
      <div className="aui-thread-welcome-root mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col items-center justify-center gap-4">
        <span className="size-8 animate-spin rounded-full border-[3px] border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground animate-pulse">Starting conversation…</p>
      </div>
    );
  }

  // Genuinely new / empty thread — show welcome + suggestions.
  return (
    <div className="aui-thread-welcome-root mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col">
      <div className="aui-thread-welcome-center flex w-full grow flex-col items-center justify-center">
        <div className="aui-thread-welcome-message flex size-full flex-col justify-center px-4">
          <div className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both mb-4 flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/75 shadow-md shadow-primary/25 duration-200">
            <Sparkles className="size-5 text-primary-foreground" />
          </div>
          <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both font-serif font-semibold text-2xl duration-200 delay-50">
            Hello there!
          </h1>
          <p className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-muted-foreground text-base delay-100 duration-200">
            How can I help you today?
          </p>
        </div>
      </div>
      <ThreadSuggestions suggestions={suggestions} />
    </div>
  );
};

// ── Suggestions ───────────────────────────────────────────────────────────

const ThreadSuggestions: FC<{ suggestions: Suggestion[] }> = ({
  suggestions,
}) => {
  return (
    <div className="aui-thread-welcome-suggestions grid w-full gap-2 pb-4 grid-cols-1 sm:grid-cols-2">
      {suggestions.map((s, i) => (
        <ThreadSuggestionItem key={s.label} suggestion={s} index={i} />
      ))}
    </div>
  );
};

const ThreadSuggestionItem: FC<{ suggestion: Suggestion; index: number }> = ({
  suggestion,
  index,
}) => {
  const runtime = useThreadRuntime();

  const handleClick = () => {
    runtime.append({
      role: "user",
      content: [{ type: "text", text: suggestion.prompt }],
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      style={{ animationDelay: `${index * 60}ms` }}
      className={cn(
        "aui-thread-welcome-suggestion-display group",
        "fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200",
        "flex flex-col items-start gap-1 rounded-lg border border-border",
        "bg-card px-4 py-3.5 text-left transition-colors",
        "hover:border-primary/40 hover:bg-primary/5",
      )}
    >
      <span className="font-serif font-medium text-sm text-foreground group-hover:text-primary transition-colors">
        {suggestion.label}
      </span>
      <span className="text-xs leading-relaxed text-muted-foreground line-clamp-2">
        {suggestion.prompt}
      </span>
    </button>
  );
};

// ── Composer ──────────────────────────────────────────────────────────────

const Composer: FC = () => {
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="composer-shell"
          className={cn(
            "flex w-full flex-col gap-0 rounded-xl border bg-card px-4 pt-3 pb-3",
            "border-border shadow-sm",
            "transition-all duration-150",
            "focus-within:border-primary focus-within:shadow-md focus-within:shadow-primary/10",
            "focus-within:ring-4 focus-within:ring-primary/10",
            "data-[dragging=true]:border-primary data-[dragging=true]:border-dashed data-[dragging=true]:bg-primary/5",
          )}
        >
          {/* Attachment previews (if any) */}
          <ComposerAttachments />

          {/* Input */}
          <ComposerPrimitive.Input
            placeholder="How can Episteme help you today?"
            className="aui-composer-input max-h-40 min-h-[36px] w-full resize-none bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground leading-relaxed"
            rows={1}
            autoFocus
            aria-label="Message input"
          />

          {/* Bottom toolbar */}
          <ComposerAction />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => {
  return (
    <div className="aui-composer-action-wrapper flex items-center justify-between pt-1">
      {/* Paperclip — left */}
      <ComposerAddAttachment />

      {/* Send / Cancel — right */}
      <AuiIf condition={(s) => !s.thread.isRunning}>
        <ComposerPrimitive.Send asChild>
          <TooltipIconButton
            tooltip="Send message"
            side="top"
            type="button"
            variant="default"
            size="icon"
            aria-label="Send message"
            className="aui-composer-send size-8 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:shadow-md hover:shadow-primary/20 disabled:opacity-40"
          >
            <ArrowUpIcon className="aui-composer-send-icon size-4" />
          </TooltipIconButton>
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.isRunning}>
        <ComposerPrimitive.Cancel asChild>
          <Button
            type="button"
            variant="default"
            size="icon"
            aria-label="Stop generating"
            className="aui-composer-cancel size-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <SquareIcon className="aui-composer-cancel-icon size-3 fill-current" />
          </Button>
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </div>
  );
};

// ── Message error ─────────────────────────────────────────────────────────

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive text-sm dark:bg-destructive/5 dark:text-error">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

// ── Clarification option chips ────────────────────────────────────────────

function parseClarificationOptions(text: string): { label: string; full: string }[] {
  // Split on (A)/(B)/(C) markers — avoids needing the ES2018 `s` flag.
  // e.g. "...(A) apply for a bed space, (B) priority criteria, or (C) charges?"
  // → parts: [before, "A", "apply for a bed space, ", "B", "priority criteria, or ", "C", "charges?"]
  const parts = text.split(/\(([A-C])\)\s+/);
  const results: { label: string; full: string }[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const label = parts[i];
    const body  = parts[i + 1]
      .replace(/,?\s*(?:or\s+)?$/i, "") // strip trailing ", or " before next option
      .replace(/[?.!,]+$/, "")           // strip trailing punctuation on last option
      .trim();
    if (body) results.push({ label, full: body });
  }
  return results;
}

const ClarificationOptions: FC = () => {
  const runtime = useThreadRuntime();

  // Subscribe reactively to thread state via useSyncExternalStore so the component
  // re-renders whenever messages or isRunning change.
  const { messages, isRunning } = useSyncExternalStore(
    runtime.subscribe,
    () => runtime.getState(),
    () => runtime.getState(),
  );

  const messageId = useAuiState((s) => s.message.id);
  const role      = useAuiState((s) => s.message.role);

  if (role !== "assistant" || isRunning) return null;

  // Only render on the last assistant message — options disappear once the user replies.
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (lastAssistant?.id !== messageId) return null;

  // Extract plain text from message parts.
  const text = lastAssistant.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");

  const options = parseClarificationOptions(text);
  if (options.length < 2) return null;

  const handleSelect = (full: string) => {
    runtime.append({
      role: "user",
      content: [{ type: "text", text: full }],
    });
  };

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {options.map(({ label, full }) => (
        <button
          key={label}
          type="button"
          onClick={() => handleSelect(full)}
          className={cn(
            "flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5",
            "px-3.5 py-1.5 text-sm font-medium text-primary",
            "transition-colors hover:border-primary/60 hover:bg-primary/10",
            "fade-in animate-in duration-150",
          )}
        >
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold leading-none">
            {label}
          </span>
          {full}
        </button>
      ))}
    </div>
  );
};

// ── Assistant message ─────────────────────────────────────────────────────

const AssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      className="aui-assistant-message-root fade-in slide-in-from-bottom-1 relative mx-auto flex w-full max-w-(--thread-max-width) animate-in gap-4 py-4 duration-150"
      data-role="assistant"
    >
      <AssistantAvatar />
      <div className="flex-1 min-w-0">
        <div className="aui-assistant-message-content wrap-break-word pr-2 text-foreground leading-relaxed">
          <MessagePrimitive.Parts
            components={{
              Text: MarkdownText,
              Reasoning,
              ReasoningGroup,
              tools: {
                Fallback: ToolFallback,
              },
            }}
          />
          <ClarificationOptions />
          <MessageError />
        </div>

        <div className="aui-assistant-message-footer mt-2 flex items-center gap-1.5">
          <BranchPicker />
          <AssistantActionBar />
          <FeedbackButtons />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

// ── Assistant action bar ──────────────────────────────────────────────────

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      autohideFloat="single-branch"
      className="aui-assistant-action-bar-root col-start-3 row-start-2 flex items-center gap-0 rounded-full border border-border/60 bg-background/90 px-1 py-0.5 shadow-sm backdrop-blur-sm text-muted-foreground data-floating:absolute data-floating:rounded-full data-floating:border data-floating:border-border/60 data-floating:bg-background/90 data-floating:px-1 data-floating:py-0.5 data-floating:shadow-md data-floating:backdrop-blur-sm"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy" className="size-7 rounded-full transition-colors hover:bg-primary/10 hover:text-primary [&[data-copied]]:text-primary">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="size-3.5" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="size-3.5" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <div className="mx-0.5 h-3.5 w-px bg-border/60" />
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Regenerate" className="size-7 rounded-full transition-colors hover:bg-primary/10 hover:text-primary">
          <RefreshCwIcon className="size-3.5" />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <div className="mx-0.5 h-3.5 w-px bg-border/60" />
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="More"
            className="size-7 rounded-full transition-colors hover:bg-primary/10 hover:text-primary data-[state=open]:bg-primary/10 data-[state=open]:text-primary"
          >
            <MoreHorizontalIcon className="size-3.5" />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          className="aui-action-bar-more-content z-50 min-w-36 overflow-hidden rounded-xl border border-border/60 bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-primary/10 hover:text-primary focus:bg-primary/10 focus:text-primary transition-colors">
              <DownloadIcon className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

// ── User message ──────────────────────────────────────────────────────────

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      className="aui-user-message-root fade-in slide-in-from-bottom-1 mx-auto flex w-full max-w-(--thread-max-width) animate-in gap-4 py-4 duration-150"
      data-role="user"
    >
      <UserAvatar />
      <div className="flex-1 min-w-0">
        <UserMessageAttachments />
        <div className="aui-user-message-content-wrapper relative group/user">
          <div className="aui-user-message-content wrap-break-word rounded-lg bg-secondary px-4 py-2.5 text-foreground border border-border shadow-sm">
            <MessagePrimitive.Parts />
          </div>
          <div className="aui-user-action-bar-wrapper absolute top-1/2 right-0 translate-x-full -translate-y-1/2 pl-2 opacity-0 group-hover/user:opacity-100 transition-opacity">
            <UserActionBar />
          </div>
        </div>
        <BranchPicker className="aui-user-branch-picker mt-2" />
      </div>
    </MessagePrimitive.Root>
  );
};

// ── User action bar ───────────────────────────────────────────────────────

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit" className="aui-user-action-edit p-4">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

// ── Edit composer ─────────────────────────────────────────────────────────

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root className="aui-edit-composer-wrapper mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2 py-3">
      <ComposerPrimitive.Root className="aui-edit-composer-root ml-auto flex w-full max-w-[85%] flex-col rounded-2xl bg-muted">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input min-h-14 w-full resize-none bg-transparent p-4 text-foreground text-sm outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-3 mb-3 flex items-center gap-2 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm">Cancel</Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm">Update</Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

// ── Branch picker ─────────────────────────────────────────────────────────

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root inline-flex items-center gap-0.5 rounded-full border border-border/60 bg-background/90 px-1 py-0.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous branch" className="size-7 rounded-full transition-colors hover:bg-primary/10 hover:text-primary disabled:opacity-30 disabled:pointer-events-none">
          <ChevronLeftIcon className="size-3.5" />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state min-w-[2.25rem] text-center tabular-nums">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next branch" className="size-7 rounded-full transition-colors hover:bg-primary/10 hover:text-primary disabled:opacity-30 disabled:pointer-events-none">
          <ChevronRightIcon className="size-3.5" />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
