"use client";

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "../supabase/browser";
import { buildUserInfo, type UserInfo } from "../user-info";
import { UserSeedContext } from "./user-context";

export type { UserInfo };

export function useUser() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  // Server-provided seed, when a <UserSeedProvider> is mounted above.
  // Absent (undefined) → unchanged legacy behaviour: fetch on mount.
  const seed = useContext(UserSeedContext);

  const [user, setUser]       = useState<UserInfo | null>(seed?.user ?? null);
  const [loading, setLoading] = useState(seed === undefined);

  // Guards live in refs so the auth-subscription effect never re-runs because
  // of them — re-running it would resubscribe and re-fire INITIAL_SESSION.
  const seededRef        = useRef(seed !== undefined);
  const sawInitialRef    = useRef(false);
  const currentUserIdRef = useRef<string | null>(seed?.user?.id ?? null);

  useEffect(() => {
    let isMounted = true;

    const setFromSession = async (session: Session | null) => {
      if (!isMounted) return;

      const u = session?.user;
      if (!u) {
        currentUserIdRef.current = null;
        setUser(null);
        setLoading(false);
        return;
      }

      // Fetch user profile from public.users table to get roles
      const { data: profile } = await supabase
        .from("users")
        .select("primary_role, roles, institution_id")
        .eq("auth_id", u.id)
        .maybeSingle();

      if (!isMounted) return;

      currentUserIdRef.current = u.id;
      setUser(buildUserInfo(u, profile));
      setLoading(false);
    };

    // Unseeded: resolve from the session ourselves, exactly as before.
    if (!seededRef.current) {
      void (async () => {
        const { data } = await supabase.auth.getSession();
        await setFromSession(data.session);
      })();
    }

    const { data: sub } = supabase.auth.onAuthStateChange(
      (event: AuthChangeEvent, session: Session | null) => {
        // Supabase emits INITIAL_SESSION immediately on subscribe. When we were
        // seeded by the server, that event carries nothing we don't already
        // know — honouring it would re-issue the very profile query the seed
        // exists to avoid. Every later event is handled normally, so sign-out
        // and account switches still propagate.
        if (event === "INITIAL_SESSION" && !sawInitialRef.current) {
          sawInitialRef.current = true;
          if (seededRef.current) return;
        }

        // A token refresh cannot change the profile row. Skip the refetch when
        // it's the same user we already have loaded.
        if (
          event === "TOKEN_REFRESHED" &&
          session?.user?.id &&
          session.user.id === currentUserIdRef.current
        ) {
          return;
        }

        void setFromSession(session);
      },
    );

    return () => {
      isMounted = false;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  return { user, loading, supabase };
}
