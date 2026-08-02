"use client";

import { createContext, type ReactNode } from "react";
import type { UserInfo } from "@/lib/user-info";

/**
 * Optional server-provided seed for `useUser()`.
 *
 * `undefined` means "no provider above me" — `useUser()` then behaves exactly
 * as it always has (fetch session + profile on mount, `loading: true` first).
 * A present value means the server already resolved this and `useUser()` can
 * start settled, skipping a `getSession()` + `users` round-trip per consumer
 * subtree. `user: null` inside a present value is a real answer ("signed out"),
 * not an unknown.
 */
export type UserSeed = { user: UserInfo | null };

export const UserSeedContext = createContext<UserSeed | undefined>(undefined);

export function UserSeedProvider({ seed, children }: { seed: UserSeed; children: ReactNode }) {
  return <UserSeedContext.Provider value={seed}>{children}</UserSeedContext.Provider>;
}
