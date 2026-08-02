// Shared, environment-neutral shape for "who is the current user".
//
// Both the client (`useUser`, from a Supabase session) and the server
// (`buildUserInfo` in a layout, from `getAuthUser()` + `getUserProfile()`)
// produce this via the SAME builder, so a server-seeded value is byte-identical
// to what the client would have fetched. That identity is what makes seeding
// safe: hydration can't disagree with itself.

export type UserInfo = {
  email:           string | null;
  fullName:        string | null;
  avatarUrl:       string | null;
  id:              string | null;
  primary_role?:   string | null;
  roles?:          string[];
  institution_id?: string | null;
};

/** The subset of a Supabase auth user this app reads. */
type AuthUserLike = {
  id:             string;
  email?:         string | null;
  user_metadata?: Record<string, unknown> | null;
};

/** The subset of a `public.users` row this app reads. */
type ProfileLike = {
  primary_role?:   string | null;
  roles?:          string[] | null;
  institution_id?: string | null;
} | null;

function metaString(meta: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function buildUserInfo(user: AuthUserLike | null | undefined, profile: ProfileLike): UserInfo | null {
  if (!user) return null;

  const meta = user.user_metadata ?? null;

  return {
    id:             user.id,
    email:          user.email ?? null,
    fullName:       metaString(meta, "full_name") ?? metaString(meta, "name") ?? null,
    avatarUrl:      metaString(meta, "avatar_url") ?? metaString(meta, "picture") ?? null,
    primary_role:   profile?.primary_role,
    roles:          profile?.roles ?? [],
    institution_id: profile?.institution_id,
  };
}
