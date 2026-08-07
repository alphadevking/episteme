"use client";

import { useState } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import {
  LogOutIcon,
  ChevronUpIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  SettingsIcon,
} from "lucide-react";
import { useThemePreference } from "@/lib/hooks/use-theme-preference";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { useUser } from "@/lib/hooks/use-user";
import { clearSnapshot } from "@/lib/runtime/server-snapshot";
import { cn } from "@/lib/utils";

export function UserBadge({ compact = false }: { compact?: boolean }) {
  const { user, loading, supabase } = useUser();
  // Persists the choice to the account as well as to localStorage, so this
  // switcher and the Appearance section in Settings agree on what is stored.
  const { theme, setThemePreference } = useThemePreference();
  const [signingOut, setSigningOut] = useState(false);
  const router = useRouter();

  const label    = user?.fullName || user?.email || "Account";
  const fallback = (label[0] || "A").toUpperCase();

  const signOut = async () => {
    setSigningOut(true);
    Object.keys(localStorage)
      .filter((k) => k.startsWith("episteme:thread-list:"))
      .forEach((k) => localStorage.removeItem(k));
    // In-memory server snapshot is per-user too — drop it with the cache so no
    // thread titles can survive into the next session in this tab.
    clearSnapshot();
    // Constrained, non-forgeable auth logger (actor derived server-side).
    void supabase.rpc("fn_log_auth_event", { p_action: "user_sign_out" });
    await supabase.auth.signOut();
    router.replace("/sign-in");
  };

  const roleLabel =
    user?.roles?.includes("admin")
      ? "Institution Admin"
      : user?.primary_role
        ? user.primary_role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
        : null;

  // `as const` so `value` narrows to ThemePref rather than widening to string.
  const themeOptions = [
    { value: "light",  label: "Light", Icon: SunIcon },
    { value: "dark",   label: "Dark",  Icon: MoonIcon },
    { value: "system", label: "Auto",  Icon: MonitorIcon },
  ] as const;

  // Skeleton while user data is in-flight — prevents footer height jump.
  if (loading) {
    return (
      <div className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 animate-pulse">
        <div className="size-8 shrink-0 rounded-full bg-muted" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3 w-24 rounded bg-muted" />
          <div className="h-2.5 w-16 rounded bg-muted" />
        </div>
        <div className="size-3.5 rounded bg-muted" />
      </div>
    );
  }

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        {compact ? (
          <button
            type="button"
            aria-label="Account"
            className="group inline-flex items-center rounded-full outline-none ring-primary/25 transition-all hover:ring-[3px] focus-visible:ring-[3px]"
            suppressHydrationWarning
          >
            <Avatar size="sm" className="border-2 border-sidebar-border/50 transition-all group-hover:border-primary/50">
              {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={label} /> : null}
              <AvatarFallback className="bg-primary/15 text-primary font-semibold text-xs">
                {fallback}
              </AvatarFallback>
            </Avatar>
          </button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className={cn(
              "group h-auto w-full min-w-0 items-center justify-start gap-2.5",
              "rounded-lg px-2.5 py-2 transition-colors active:scale-[0.98]",
              "hover:bg-sidebar-accent",
            )}
            suppressHydrationWarning
          >
            <Avatar className="size-8 shrink-0 border border-sidebar-border/60 shadow-sm">
              {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={label} /> : null}
              <AvatarFallback className="bg-primary/15 text-primary text-sm font-semibold">
                {fallback}
              </AvatarFallback>
            </Avatar>

            <div className="min-w-0 flex-1 text-left">
              <div className="truncate font-semibold text-[13px] leading-tight text-foreground/90">
                {label}
              </div>
              {roleLabel && (
                <div className="truncate text-[11px] text-primary/80">
                  {roleLabel}
                </div>
              )}
            </div>

            <ChevronUpIcon className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-data-[state=open]:rotate-180" />
          </Button>
        )}
      </DropdownMenuPrimitive.Trigger>

      <DropdownMenuPrimitive.Content
        side="top"
        align={compact ? "end" : "start"}
        sideOffset={8}
        className={cn(
          "z-50 w-72 overflow-hidden rounded-xl border border-border/60",
          "bg-popover text-popover-foreground shadow-xl",
          "animate-in fade-in slide-in-from-bottom-2 zoom-in-95 duration-150",
          "p-1.5",
        )}
      >
        {/* ── Profile card ── */}
        <div className="mb-1 flex items-center gap-3 rounded-lg bg-gradient-to-br from-primary/10 to-primary/5 px-3 py-3">
          <Avatar className="size-10 shrink-0 border-2 border-primary/20 shadow-sm">
            {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={label} /> : null}
            <AvatarFallback className="bg-primary/15 text-primary font-bold text-base">
              {fallback}
            </AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-semibold text-[13px] leading-tight text-foreground">
              {label}
            </span>
            {user?.email && (
              <span className="truncate text-[11px] text-muted-foreground leading-snug">
                {user.email}
              </span>
            )}
            {roleLabel && (
              <span className="mt-1 w-fit rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                {roleLabel}
              </span>
            )}
          </div>
        </div>

        {/* ── Theme switcher ── */}
        <div className="px-1.5 py-1">
          <p className="mb-1 px-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
            Appearance
          </p>
          <div className="flex gap-1">
            {themeOptions.map(({ value, label: themeLabel, Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setThemePreference(value)}
                className={cn(
                  "flex flex-1 flex-col items-center gap-1 rounded-lg px-2 py-2 text-[11px] font-medium transition-colors",
                  theme === value
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {themeLabel}
              </button>
            ))}
          </div>
        </div>

        <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border/50" />

        {/* ── Settings ── */}
        <DropdownMenuPrimitive.Item asChild>
          <button
            type="button"
            onClick={() => router.push("/chat/settings")}
            className={cn(
              "flex w-full cursor-pointer select-none items-center gap-2.5",
              "rounded-lg px-2.5 py-2 text-[13px] font-medium text-muted-foreground",
              "transition-colors hover:bg-sidebar-accent hover:text-foreground",
              "focus:bg-sidebar-accent focus:text-foreground outline-none",
            )}
          >
            <SettingsIcon className="size-4 shrink-0" />
            Settings
          </button>
        </DropdownMenuPrimitive.Item>

        <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border/50" />

        {/* ── Sign out ── */}
        <DropdownMenuPrimitive.Item asChild>
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            className={cn(
              "flex w-full cursor-pointer select-none items-center gap-2.5",
              "rounded-lg px-2.5 py-2 text-[13px] font-medium text-muted-foreground",
              "transition-colors hover:bg-destructive/10 hover:text-destructive",
              "focus:bg-destructive/10 focus:text-destructive outline-none",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            <LogOutIcon className="size-4 shrink-0" />
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </DropdownMenuPrimitive.Item>
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Root>
  );
}
