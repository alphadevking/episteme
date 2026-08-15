// episteme-core/src/evals/entitlement-coverage.ts
/**
 * Is an access-control assertion actually capable of failing?
 *
 * ── THE PROBLEM THIS EXISTS TO CATCH ─────────────────────────────────────────
 * The entitlement eval reported "4/4 cases, 0 violations" against a corpus whose
 * index held only `general`, `admissions` and `academic-policy`. Two of those
 * four cases assert that `financial-aid` and `staff-internal` content must never
 * surface — and NEITHER NAMESPACE CONTAINED A SINGLE VECTOR. Those assertions
 * could not have failed. They passed by describing an empty room.
 *
 * That is the same failure the retrieval eval already guards against with its
 * corpus-reachability control: a check that examines nothing passes silently,
 * and a green security result nobody can falsify is worse than a red one,
 * because it gets written up as evidence.
 *
 * The gap was found by a human reading a corpus dump. This module makes the
 * harness find it, so the next namespace that empties out is caught on the run
 * that empties it rather than on the day someone re-reads the output.
 *
 * Pure: takes a namespace census as data. Nothing here touches the network.
 */

/** Vector counts per namespace, as reported by the index. */
export type NamespaceCensus = Readonly<Record<string, number>>;

export interface ExclusionCoverage {
  /**
   * Namespaces the caller may not search that DO hold vectors. These are the
   * exclusions the case genuinely tests — content exists and stayed hidden.
   */
  enforced: string[];
  /**
   * Namespaces the caller may not search that hold NOTHING. The case asserts
   * they will not leak, and they cannot, because there is nothing there. Not
   * evidence.
   */
  vacuous: string[];
  /** Vectors sitting behind the enforced exclusions — the size of the real test. */
  vectorsWithheld: number;
  /**
   * True when EVERY exclusion this caller relies on is vacuous. The case can
   * still be worth running for its namespace/institution assertions, but it
   * proves nothing about withholding.
   */
  whollyVacuous: boolean;
}

/**
 * Every namespace the access model knows about, whether or not the index has
 * content for it.
 *
 * Drawn from the gate's own tables rather than from the index: a namespace that
 * the security model defines but the corpus has never been given is exactly the
 * case worth flagging, and reading the universe from the index would make it
 * invisible by construction.
 */
export function knownNamespaces(
  roleNamespaces: Readonly<Record<string, readonly string[]>>,
  trustNamespaces: Readonly<Record<number, readonly string[]>>,
  extra: readonly string[] = [],
): string[] {
  const all = new Set<string>(extra);
  for (const list of Object.values(roleNamespaces)) for (const ns of list) all.add(ns);
  for (const list of Object.values(trustNamespaces)) for (const ns of list) all.add(ns);
  return [...all].sort();
}

/**
 * Splits a caller's forbidden namespaces into those that genuinely withhold
 * content and those that are empty.
 *
 * `universe` should include namespaces absent from the census — those are the
 * empty ones, and they are the entire point.
 */
export function assessExclusionCoverage(
  allowed: readonly string[],
  universe: readonly string[],
  census: NamespaceCensus,
): ExclusionCoverage {
  const permitted = new Set(allowed);
  const forbidden = universe.filter((ns) => !permitted.has(ns));

  const enforced: string[] = [];
  const vacuous: string[] = [];
  let vectorsWithheld = 0;

  for (const ns of forbidden) {
    const count = census[ns] ?? 0;
    if (count > 0) {
      enforced.push(ns);
      vectorsWithheld += count;
    } else {
      vacuous.push(ns);
    }
  }

  return {
    enforced,
    vacuous,
    vectorsWithheld,
    // No forbidden namespaces at all means an unrestricted caller, which is not
    // a vacuous exclusion — there was simply nothing to exclude.
    whollyVacuous: forbidden.length > 0 && enforced.length === 0,
  };
}

/** One-line summary for the run report. */
export function formatExclusionCoverage(c: ExclusionCoverage): string {
  if (c.enforced.length === 0 && c.vacuous.length === 0) {
    return 'no namespace restrictions apply to this caller';
  }
  const parts: string[] = [];
  if (c.enforced.length > 0) {
    parts.push(`withholds ${c.vectorsWithheld} vector(s) across [${c.enforced.join(', ')}]`);
  }
  if (c.vacuous.length > 0) {
    parts.push(`VACUOUS for [${c.vacuous.join(', ')}] — empty, cannot leak`);
  }
  return parts.join('; ');
}
