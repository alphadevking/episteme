// lib/account/constants.ts
// Shared between the settings UI and the account API routes, so the phrase the
// dialog asks for and the phrase the server checks cannot drift apart.

/** The exact text a user must type to confirm account deletion. */
export const DELETE_CONFIRMATION = "DELETE MY ACCOUNT";

/** Upload limits. Mirrors the `avatars` bucket's own file_size_limit. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** Accepted image types, mirroring the bucket's allowed_mime_types. */
export const AVATAR_ACCEPT = "image/png,image/jpeg,image/webp";
