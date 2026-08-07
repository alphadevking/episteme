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
  display_name?:   string | null;
  first_name?:     string | null;
  last_name?:      string | null;
  avatar_url?:     string | null;
  primary_role?:   string | null;
  roles?:          string[] | null;
  institution_id?: string | null;
} | null;

function metaString(meta: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Trims to null so a whitespace-only column can't win the precedence chain. */
function clean(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/**
 * The name to show, in precedence order:
 *   display_name → "first last" → OAuth metadata → null (caller falls back to email)
 *
 * The profile row comes FIRST deliberately. Before this, the name was read only
 * from `user_metadata.full_name`, which the settings page cannot write — so
 * editing your name saved correctly to `users` and then changed nothing
 * anywhere the user could see. The provider's copy is now the fallback for
 * accounts that have never set a name, not the authority.
 */
function profileName(profile: ProfileLike): string | null {
  const display = clean(profile?.display_name);
  if (display) return display;

  const parts = [clean(profile?.first_name), clean(profile?.last_name)].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

export function buildUserInfo(user: AuthUserLike | null | undefined, profile: ProfileLike): UserInfo | null {
  if (!user) return null;

  const meta = user.user_metadata ?? null;

  return {
    id:             user.id,
    email:          user.email ?? null,
    fullName:
      profileName(profile) ??
      metaString(meta, "full_name") ??
      metaString(meta, "name") ??
      null,
    avatarUrl:
      clean(profile?.avatar_url) ??
      metaString(meta, "avatar_url") ??
      metaString(meta, "picture") ??
      null,
    primary_role:   profile?.primary_role,
    roles:          profile?.roles ?? [],
    institution_id: profile?.institution_id,
  };
}
