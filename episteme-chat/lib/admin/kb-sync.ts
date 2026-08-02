// lib/admin/kb-sync.ts
/**
 * Whether a finished ingest stream should be recorded in Supabase.
 *
 * THE BUG THIS EXISTS TO PREVENT: core's preview path emits
 * `done { success: true, dryRun: true }`, and the proxy only checked
 * `payload.success`. Nothing exercised it because the single-document ingest
 * form never sends `dryRun` — the harvest UI is the first caller that does.
 * Previewing a page would have registered it in kb_document_sources and filed
 * a "kb_document_created" audit entry for a document that was never written.
 *
 * The decision lives here, as a pure function, so it can be pinned by a test.
 * Inside the streaming route it was reachable only with a live Supabase
 * session, a live core, and a real SSE stream — which is to say, not reachable
 * by any test that would have caught the regression.
 *
 * Two independent reasons to refuse, either sufficient:
 *   - the REQUEST asked for a preview (authoritative: it is what we asked for)
 *   - the STREAM says it was a preview (defence if the request flag is ever
 *     lost in transit or a future caller sets it some other way)
 */

export interface IngestDonePayload {
  success?: boolean;
  dryRun?: boolean;
}

export interface RecordIngestInput {
  /** `dryRun === true` on the request body we forwarded to core. */
  requestedDryRun: boolean;
  /** Parsed `data:` of the terminal `done` event. */
  payload: IngestDonePayload;
  /** Absent when the caller omitted it — there is nothing to key a row on. */
  docId?: string | null;
  /** Null for a global (institution-less) ingest, which has no row to own. */
  institutionId: string | null;
}

export function shouldRecordIngest({
  requestedDryRun,
  payload,
  docId,
  institutionId,
}: RecordIngestInput): boolean {
  if (payload.success !== true) return false;
  if (requestedDryRun) return false;
  if (payload.dryRun === true) return false;
  if (!docId) return false;
  if (!institutionId) return false;
  return true;
}
