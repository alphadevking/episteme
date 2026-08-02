import "server-only";

import { cache } from "react";
import { createSupabaseServerClientReadOnly } from "./server";
import type { Tables } from "@/lib/types/database";

// Request-scoped auth + profile reads.
//
// Why this exists: `supabase.auth.getUser()` is a network call to the Supabase
// Auth server (`/auth/v1/user`), not a local JWT decode. A layout and its page
// each calling it — plus the profile row each of them needs — meant three auth
// round-trips and two identical `users` selects before a single byte of HTML
// was produced.
//
// React's `cache()` dedupes per *request*, so layout, page, and any server
// component below them share one call each. It is NOT a cross-request cache:
// every new request re-validates against Supabase, so this changes only how
// many times we ask, never what we're allowed to see. Auth decisions stay
// exactly as authoritative as they were.
//
// Note: `proxy.ts` still calls `getUser()` on its own — it runs in a separate
// (middleware) context with its own client, and its call is what refreshes the
// session cookie. That one must stay.

/** One Supabase server client per request. `cookies()` is already request-scoped. */
export const getServerSupabase = cache(async () => createSupabaseServerClientReadOnly());

/** The authenticated Supabase auth user, or null. Deduped per request. */
export const getAuthUser = cache(async () => {
  const supabase = await getServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
});

/**
 * Columns selected for the shared profile read.
 *
 * This is the union of what every chat-tree consumer needs (layout guards,
 * role-based suggestions, the client `useUser()` seed). Selecting the union
 * once beats selecting three subsets three times — the row is narrow and the
 * round-trip, not the payload, is the cost.
 */
const PROFILE_COLUMNS =
  "id, auth_id, email, display_name, first_name, last_name, avatar_url, primary_role, roles, institution_id, is_superadmin, status" as const;

export type ServerProfile = Pick<
  Tables<"users">,
  | "id"
  | "auth_id"
  | "email"
  | "display_name"
  | "first_name"
  | "last_name"
  | "avatar_url"
  | "primary_role"
  | "roles"
  | "institution_id"
  | "is_superadmin"
  | "status"
>;

/** The `public.users` row for the authenticated user, or null. Deduped per request. */
export const getUserProfile = cache(async (): Promise<ServerProfile | null> => {
  const user = await getAuthUser();
  if (!user) return null;

  const supabase = await getServerSupabase();
  const { data } = await supabase
    .from("users")
    .select(PROFILE_COLUMNS)
    .eq("auth_id", user.id)
    .maybeSingle();

  return data ?? null;
});

/** Both in one await, for callers that need the auth user and the profile row. */
export const getAuthContext = cache(async () => {
  const [user, profile] = await Promise.all([getAuthUser(), getUserProfile()]);
  return { user, profile };
});
