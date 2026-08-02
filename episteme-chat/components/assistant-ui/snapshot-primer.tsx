"use client";

import { useRef } from "react";
import { primeSnapshot, type ServerSnapshot } from "@/lib/runtime/server-snapshot";

/**
 * Installs the server-rendered snapshot into the runtime store.
 *
 * Primes during RENDER, not in an effect: `adapter.list()` runs from the
 * runtime provider's effect (a parent), and parent effects run after every
 * child render, so this always wins the race.
 *
 * Primes once per distinct snapshot object. Re-priming on an incidental
 * re-render would resurrect data a consumer had already taken, which is how a
 * stale message list could shadow a fresh database read. The prop identity is
 * stable for a given server render and changes on navigation, which is exactly
 * the granularity we want.
 *
 * Renders nothing.
 */
export function SnapshotPrimer({ snapshot }: { snapshot: ServerSnapshot }) {
  const primed = useRef<ServerSnapshot | null>(null);

  if (primed.current !== snapshot) {
    primed.current = snapshot;
    primeSnapshot(snapshot);
  }

  return null;
}
