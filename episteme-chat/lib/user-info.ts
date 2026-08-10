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

/**
 * The avatar to display, in precedence order:
 *   users.avatar_url (uploaded by the user) → OAuth metadata → null
 *
 * Exported because more than one surface needs this answer, and they must not
 * each invent their own. The settings page previously read `profile.avatar_url`
 * alone: since the OAuth trigger never populates that column, a Google user saw
 * their photo in the sidebar (which did fall back to metadata) and an initials
 * placeholder in Settings — the same account rendering two different avatars.
 *
 * Note this returns the EFFECTIVE avatar. To decide whether the user has
 * something of their own to remove, check `profile.avatar_url` directly — the
 * provider's photo is not ours to delete.
 */
export function resolveAvatarUrl(
  user: AuthUserLike | null | undefined,
  profile: ProfileLike,
): string | null {
  return clean(profile?.avatar_url) ?? getProviderAvatarUrl(user);
}

/**
 * Does `users.avatar_url` hold a photo the user actually uploaded?
 *
 * It cannot be answered with a null check. The `handle_new_user` trigger seeds
 * that column with the OAuth provider's photo on signup, so it is non-null for
 * every Google user who has never uploaded anything. Treating non-null as
 * "uploaded" put a Remove button in front of all of them — and pressing it
 * cleared the column, fell back to the same URL from auth metadata, and changed
 * nothing on screen.
 *
 * An upload always lives in this project's `avatars` bucket: `fn_set_my_avatar`
 * rejects anything that does not match this exact prefix, so a Storage URL here
 * is proof of an upload. Keep this pattern in step with that function.
 */
const UPLOADED_AVATAR_RE =
  /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\/avatars\//;

export function isUploadedAvatarUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && UPLOADED_AVATAR_RE.test(url.trim());
}

/**
 * The photo supplied by the OAuth provider, or null.
 *
 * Separate from `resolveAvatarUrl` because the settings page needs the two
 * sources apart — it must know whether there is an uploaded photo to offer a
 * "Remove" button for. Which metadata keys count, and in what order, is decided
 * here once so no caller has to re-derive it.
 */
export function getProviderAvatarUrl(user: AuthUserLike | null | undefined): string | null {
  const meta = user?.user_metadata ?? null;
  return metaString(meta, "avatar_url") ?? metaString(meta, "picture") ?? null;
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
    avatarUrl: resolveAvatarUrl(user, profile),
    primary_role:   profile?.primary_role,
    roles:          profile?.roles ?? [],
    institution_id: profile?.institution_id,
  };
}
