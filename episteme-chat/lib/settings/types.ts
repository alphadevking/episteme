// lib/settings/types.ts
// The view model the settings server page builds and the client shell renders.
//
// Split deliberately into `values` (mutable — everything in here round-trips
// through `settingsPatchSchema`) and the read-only blocks around it (account,
// verification, wards). That split is what stops the page from rendering a
// control for something it cannot actually write: if a field isn't in `values`,
// it isn't editable, and the UI shows it as information rather than as an input.

import type { SettingsValues } from "./schema";

export type SettingsOption = { id: string; name: string; code: string };

/** Identity and account facts. All read-only — owned by auth or by an admin. */
export type SettingsAccount = {
  email:           string;
  emailVerified:   boolean;
  /** OAuth provider id ("google", "email", …) from auth app_metadata. */
  provider:        string | null;
  status:          string;
  primaryRole:     string;
  roles:           string[];
  isSuperadmin:    boolean;
  institutionName: string | null;
  /**
   * The avatar the user uploaded (`users.avatar_url`), or null. This is the
   * only one that can be removed — hence it being separate from the provider's.
   */
  uploadedAvatarUrl: string | null;
  /**
   * The photo from the OAuth provider, or null. Shown when nothing has been
   * uploaded, and what the avatar falls back to after a removal.
   */
  providerAvatarUrl: string | null;
  createdAt:       string | null;
  lastLoginAt:     string | null;
};

/** Student matric verification, when a link record exists. */
export type SettingsVerification = {
  matricNumber:    string;
  status:          string;
  rejectionReason: string | null;
  verifiedAt:      string | null;
  method:          string | null;
} | null;

/** A linked ward, for parent/guardian accounts. */
export type SettingsWard = {
  name:              string | null;
  matric:            string | null;
  relationship:      string;
  status:            string;
  canViewAcademic:   boolean;
  canViewFees:       boolean;
  canViewAttendance: boolean;
};

export type SettingsData = {
  /** The mutable settings. Everything here is editable and round-trips. */
  values:  SettingsValues;
  account: SettingsAccount;
  verification: SettingsVerification;
  wards:   SettingsWard[];
  /**
   * The trust level that ACTUALLY governs retrieval, computed with the same
   * `deriveTrustLevel` the chat route uses — not a second implementation that
   * could drift and show the user a number the AI doesn't honour.
   */
  trustLevel: number;
  /** The effective app role, likewise from the shared derivation. */
  effectiveRole: string;
  programmes:  SettingsOption[];
  departments: SettingsOption[];
};

export type { SettingsValues };
