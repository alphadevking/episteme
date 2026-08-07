"use client";

// lib/hooks/use-theme-preference.ts
//
// `next-themes`, plus persistence of the choice to the user's stored
// preferences so it follows them to a new device.
//
// next-themes remains the renderer: it owns the DOM class and the blocking
// inline script that prevents a light-mode flash on first paint. This hook only
// mirrors the choice to the server, fire-and-forget — a failed write costs the
// user nothing locally, so it must never block or surface an error over a
// cosmetic preference.
//
// ── Known limitation, stated deliberately ───────────────────────────────────
// The stored value is adopted on the settings page (which already loads it) but
// NOT on every chat page load. Doing the latter would mean a blocking
// `user_ai_context` read before the first byte of every chat render — that read
// needs `users.id`, so it cannot be parallelised with the auth call — and a
// round trip on the hot path is the wrong price for a cosmetic setting.
//
// The practical effect: a brand-new device uses the local default until the
// user opens Settings once, at which point the stored theme is adopted and
// persists locally from then on. If cross-device sync on first paint is wanted
// later, the right fix is to carry the preference in the session/JWT claims,
// not to add a query.

import { useCallback } from "react";
import { useTheme } from "next-themes";
import type { ThemePref } from "@/lib/settings/schema";

export function useThemePreference() {
  const { theme, resolvedTheme, setTheme } = useTheme();

  const setThemePreference = useCallback(
    (next: ThemePref) => {
      setTheme(next);
      void fetch("/api/profile", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ theme: next }),
        // Best effort. The local switch has already happened.
        keepalive: true,
      }).catch(() => {});
    },
    [setTheme],
  );

  return { theme, resolvedTheme, setThemePreference };
}
