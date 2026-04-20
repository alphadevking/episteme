"use client";

import { useEffect, useMemo, useState } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "../supabase/browser";

export type UserInfo = {
  email: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  id: string | null;
  primary_role?: string | null;
  roles?: string[];
  institution_id?: string | null;
};

export function useUser() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const setFromSession = async (session: Session | null) => {
      if (!isMounted) return;

      const u = session?.user;
      if (!u) {
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

      setUser({
        id: u.id,
        email: u.email ?? null,
        fullName: (u.user_metadata?.full_name as string) || (u.user_metadata?.name as string) || null,
        avatarUrl: (u.user_metadata?.avatar_url as string) || (u.user_metadata?.picture as string) || null,
        primary_role: profile?.primary_role,
        roles: profile?.roles ?? [],
        institution_id: profile?.institution_id,
      });
      setLoading(false);
    };

    const hydrate = async () => {
      const { data } = await supabase.auth.getSession();
      await setFromSession(data.session);
    };

    void hydrate();

    const { data: sub } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, session: Session | null) => {
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
