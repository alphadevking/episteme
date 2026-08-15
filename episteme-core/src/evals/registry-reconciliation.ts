// episteme-core/src/evals/registry-reconciliation.ts
/**
 * Does the document registry agree with what is actually in the vector index?
 *
 * This is §3.18 dimension 4's third component, previously unmeasured.
 *
 * ── WHY IT MATTERS ───────────────────────────────────────────────────────────
 * The registry (`kb_documents`, LibSQL) and the index (Pinecone) are two
 * separate systems written by the same ingestion run, and NOTHING keeps them in
 * step afterwards. `db.ts` is explicit that the registry is deliberately off the
 * chat path: if it is unreachable, ingestion fails loudly but chat keeps
 * answering. That independence is the right design and it is exactly what lets
 * the two drift apart silently.
 *
 * Both drift directions are real failures with no other detector:
 *
 *   REGISTERED BUT ABSENT — the admin UI lists a document as ingested, an
 *   operator believes the corpus covers a topic, and retrieval can never return
 *   it because no vector exists. The system abstains on a question it was told
 *   it could answer, and the operator has no way to tell that from a genuine
 *   coverage gap.
 *
 *   PRESENT BUT UNREGISTERED — vectors are retrievable and attributable to no
 *   ingestion record. Nobody can say where that content came from, when, or
 *   under whose authority, which defeats the provenance the whole design rests
 *   on. It also cannot be re-ingested or deleted through the admin path,
 *   because that path works from the registry.
 *
 * Pure: takes registry rows and a namespace census as data. The runner supplies
 * both; nothing here touches a network.
 */

/** The registry fields reconciliation reads. A subset of KbDocument. */
export interface RegistryDocument {
  docId: string;
  fileName: string;
  namespace: string;
  vectorsUpserted: number;
}

/** Vector counts per namespace, as reported by the index. */
export type NamespaceCensus = Readonly<Record<string, number>>;

export interface ReconciliationReport {
  /**
   * Namespaces the registry claims documents in, holding NO vectors at all.
   * Unambiguous: those documents cannot be retrieved by anyone.
   */
  registeredButAbsent: Array<{ namespace: string; documents: number; expectedVectors: number }>;
  /**
   * Namespaces holding vectors that no registry row accounts for. Retrievable
   * content with no provenance record.
   */
  presentButUnregistered: Array<{ namespace: string; vectors: number }>;
  /**
   * Namespaces where both sides have content but the counts differ. Reported,
   * NOT treated as a failure: re-ingesting a document upserts the same vector
   * ids, so the registry's running total legitimately exceeds the index's
   * distinct count. A large gap is worth a look; a small one is normal.
   */
  drift: Array<{ namespace: string; registry: number; index: number; delta: number }>;
  registryDocuments: number;
  registryVectors: number;
  indexVectors: number;
  /** True when neither hard failure class is present. */
  reconciled: boolean;
}

/**
 * Compares the registry against the index.
 *
 * `ignoreNamespaces` exists for namespaces served from outside the registry —
 * the platform documentation tier ships in the repository and is read from disk,
 * so it would otherwise be reported as unregistered forever.
 */
export function reconcileRegistry(
  documents: readonly RegistryDocument[],
  census: NamespaceCensus,
  ignoreNamespaces: readonly string[] = [],
): ReconciliationReport {
  const ignored = new Set(ignoreNamespaces);

  // Registry totals per namespace.
  const registryByNs = new Map<string, { documents: number; vectors: number }>();
  for (const doc of documents) {
    if (ignored.has(doc.namespace)) continue;
    const entry = registryByNs.get(doc.namespace) ?? { documents: 0, vectors: 0 };
    entry.documents += 1;
    // A negative or non-finite count in the registry is meaningless; treat it
    // as zero rather than letting it corrupt the totals.
    entry.vectors += Number.isFinite(doc.vectorsUpserted) && doc.vectorsUpserted > 0
      ? doc.vectorsUpserted
      : 0;
    registryByNs.set(doc.namespace, entry);
  }

  const registeredButAbsent: ReconciliationReport['registeredButAbsent'] = [];
  const drift: ReconciliationReport['drift'] = [];

  for (const [namespace, entry] of registryByNs) {
    // Pinecone omits empty namespaces from its stats entirely, so a missing key
    // and an explicit zero must mean the same thing.
    const indexCount = census[namespace] ?? 0;
    if (indexCount === 0) {
      registeredButAbsent.push({
        namespace,
        documents: entry.documents,
        expectedVectors: entry.vectors,
      });
      continue;
    }
    if (indexCount !== entry.vectors) {
      drift.push({
        namespace,
        registry: entry.vectors,
        index: indexCount,
        delta: indexCount - entry.vectors,
      });
    }
  }

  const presentButUnregistered = Object.entries(census)
    .filter(([ns, count]) => count > 0 && !ignored.has(ns) && !registryByNs.has(ns))
    .map(([namespace, vectors]) => ({ namespace, vectors }));

  const registryVectors = [...registryByNs.values()].reduce((sum, e) => sum + e.vectors, 0);
  const indexVectors = Object.entries(census)
    .filter(([ns]) => !ignored.has(ns))
    .reduce((sum, [, n]) => sum + n, 0);

  return {
    registeredButAbsent: registeredButAbsent.sort((a, b) => a.namespace.localeCompare(b.namespace)),
    presentButUnregistered: presentButUnregistered.sort((a, b) => a.namespace.localeCompare(b.namespace)),
    drift: drift.sort((a, b) => a.namespace.localeCompare(b.namespace)),
    registryDocuments: [...registryByNs.values()].reduce((sum, e) => sum + e.documents, 0),
    registryVectors,
    indexVectors,
    reconciled: registeredButAbsent.length === 0 && presentButUnregistered.length === 0,
  };
}

/** Multi-line report for the eval output. */
export function formatReconciliation(r: ReconciliationReport): string {
  const lines: string[] = [
    `  registry       ${r.registryDocuments} document(s), ${r.registryVectors} vector(s) recorded`,
    `  index          ${r.indexVectors} vector(s) resident`,
  ];

  if (r.registeredButAbsent.length > 0) {
    lines.push('', '  REGISTERED BUT ABSENT — recorded as ingested, no vectors in the index:');
    for (const e of r.registeredButAbsent) {
      lines.push(`    ${e.namespace}: ${e.documents} document(s), ${e.expectedVectors} vector(s) expected, 0 found`);
    }
    lines.push('    These documents cannot be retrieved by anyone. The admin UI lists them.');
  }

  if (r.presentButUnregistered.length > 0) {
    lines.push('', '  PRESENT BUT UNREGISTERED — retrievable content with no ingestion record:');
    for (const e of r.presentButUnregistered) {
      lines.push(`    ${e.namespace}: ${e.vectors} vector(s), no registry rows`);
    }
    lines.push('    Provenance cannot be established, and the admin path cannot delete or re-ingest them.');
  }

  if (r.drift.length > 0) {
    lines.push('', '  count drift (informational — re-ingestion upserts the same ids):');
    for (const e of r.drift) {
      lines.push(`    ${e.namespace}: registry ${e.registry}, index ${e.index} (${e.delta > 0 ? '+' : ''}${e.delta})`);
    }
  }

  if (r.reconciled) lines.push('', '  RECONCILED — every registered document has vectors, every vector has a record.');

  return lines.join('\n');
}
