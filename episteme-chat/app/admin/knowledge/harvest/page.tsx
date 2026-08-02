"use client";

// app/admin/knowledge/harvest/page.tsx
/**
 * Bulk harvest — the browser-side twin of `pnpm harvest`.
 *
 * Same three phases, in the same order, for the same reason: they cost
 * different amounts, and the cheapest one catches the most common failure.
 *
 *   Validate   0 Unstructured calls   robots.txt + proxy fetch + cleaning.
 *                                     Catches dead URLs, blocks, and pages
 *                                     that clean down to nothing.
 *   Preview    1 call per page        the real pipeline through chunking,
 *                                     stopping before any write.
 *   Commit     1 call per page        ingests.
 *
 * THE CLIENT ORCHESTRATES, THE SERVER DOES NOT. Each page is its own request.
 * Handing the server a list of 26 URLs would put the whole harvest inside one
 * function invocation — past the 300s ceiling, with no progress visible until
 * it ended and nothing salvageable if it died on page 24. Looping here means
 * every page reports as it lands, a failure costs one page, and the run can be
 * stopped mid-way without abandoning what already succeeded.
 *
 * Nothing here decides what may be ingested. The URL allowlist, the host check,
 * the Cloudflare proxy secret and the admin key all live in episteme-core; the
 * robots gate and the manifest rules are the same modules the CLI imports.
 * This page chooses only the order of requests.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  BanIcon,
  BuildingIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  EyeIcon,
  ListChecksIcon,
  LockIcon,
  PlusIcon,
  RotateCwIcon,
  ShieldIcon,
  SquareIcon,
  UploadCloudIcon,
  XIcon,
} from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { inputBase, selectBase, LabelledSelect, PillToggleGroup } from "@/components/admin/form-controls";
import { NAMESPACE_OPTIONS, CONTENT_TYPE_OPTIONS, ROLES, ROLE_LABELS } from "@/lib/constants/kb";
import {
  MANIFEST,
  toIngestBody,
  validateManifest,
  type ContentType,
  type HarvestEntry,
  type Namespace,
  type Role,
} from "@/lib/harvest/manifest";
import { DEFAULT_DELAY_MS, type UrlVerdict } from "@/lib/harvest/gate";
import {
  bucketSample,
  buildRows,
  canEnter,
  eligibleFor,
  entriesFromUrls,
  isInFlight,
  parseUrlList,
  summarize,
  type AdHocClassification,
  type HarvestRow,
  type Phase,
  type PreviewReport,
  type RowPhase,
} from "@/lib/harvest/plan";

// ── Presentation ─────────────────────────────────────────────────────────────

const PHASE_STYLE: Record<RowPhase, { label: string; className: string }> = {
  queued:      { label: "Queued",     className: "border-border bg-muted/40 text-muted-foreground" },
  validating:  { label: "Checking",   className: "border-primary/40 bg-primary/10 text-primary" },
  validated:   { label: "Validated",  className: "border-primary/40 bg-primary/10 text-primary" },
  previewing:  { label: "Previewing", className: "border-primary/40 bg-primary/10 text-primary" },
  previewed:   { label: "Previewed",  className: "border-primary/50 bg-primary/15 text-primary" },
  committing:  { label: "Ingesting",  className: "border-primary/40 bg-primary/10 text-primary" },
  committed:   { label: "Ingested",   className: "border-success/40 bg-success-bg text-success" },
  skipped:     { label: "Skipped",    className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  failed:      { label: "Failed",     className: "border-destructive/40 bg-destructive/10 text-destructive" },
};

function PhasePill({ phase }: { phase: RowPhase }) {
  const { label, className } = PHASE_STYLE[phase];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${className}`}>
      {isInFlight(phase) && (
        <span className="size-2.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
      )}
      {label}
    </span>
  );
}

function SectionHeading({ icon: Icon, label }: { icon: React.ElementType; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

// ── Network helpers ──────────────────────────────────────────────────────────

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });

interface Scope { institutionId: string | null }

async function postJson<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

interface OriginReport {
  origin: string;
  readable: boolean;
  ruleCount: number;
  crawlDelay: number | null;
  error?: string;
}

/**
 * Re-read robots.txt at the start of every phase, not once per session.
 *
 * A site can add a Disallow between the validate run and the commit run, and
 * the CLI re-checks per phase for exactly this reason. One extra request per
 * phase is a cheap price for never harvesting on a stale permission.
 */
async function fetchVerdicts(urls: string[], scope: Scope, signal: AbortSignal) {
  return postJson<{ verdicts: Record<string, UrlVerdict>; origins: OriginReport[] }>(
    "/api/admin/kb/robots",
    { urls, scope },
    signal,
  );
}

/** Phase 1 for one page: free, and it never writes. */
async function validateOne(url: string, scope: Scope, signal: AbortSignal) {
  return postJson<{ url: string; contentHash: string | null; textLength: number; thin: boolean }>(
    "/api/admin/kb/fetch",
    { url, scope },
    signal,
  );
}

/**
 * Phases 2 and 3 for one page. Same endpoint as the single-document ingest
 * form — a preview differs from a commit only by `dryRun`, which core honours
 * by reaching a code path that contains no write of any kind.
 */
async function ingestOne(
  entry: HarvestEntry,
  dryRun: boolean,
  scope: Scope,
  signal: AbortSignal,
): Promise<{ report: PreviewReport | null; vectorsUpserted: number | null }> {
  const res = await fetch("/api/admin/kb", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...toIngestBody(entry, dryRun), scope }),
    signal,
  });

  // Validation errors come back as JSON, not SSE.
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  if (!res.body) throw new Error("No stream from the ingestion service");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome: { report: PreviewReport | null; vectorsUpserted: number | null } | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        const event = block.match(/^event: (\w+)/m)?.[1];
        const raw = block.match(/^data: (.+)/m)?.[1];
        if (!event || !raw) continue;
        const payload = JSON.parse(raw) as Record<string, unknown>;

        if (event === "error") throw new Error(String(payload.error ?? "Ingestion failed"));
        if (event === "done") {
          outcome = {
            report: (payload.report as PreviewReport | undefined) ?? null,
            vectorsUpserted:
              ((payload.audit as { vectorsUpserted?: number } | undefined)?.vectorsUpserted) ?? null,
          };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // A stream that ends without `done` is a failure, never a quiet success.
  if (!outcome) throw new Error("The stream ended without completing");
  return outcome;
}

// ── Page ─────────────────────────────────────────────────────────────────────

interface Institution { id: string; name: string; code: string }

const DEFAULT_ADHOC: AdHocClassification = {
  namespace: "general",
  category: "general",
  roles: ["prospective", "student", "parent", "staff", "hod"],
  faculty: "general",
  contentType: "general",
  updatedAt: null,
};

export default function HarvestPage() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [rows, setRows] = useState<HarvestRow[]>(() => buildRows(MANIFEST));
  const [selected, setSelected] = useState<Set<string>>(() => new Set(MANIFEST.map((e) => e.url)));
  /** URLs added by hand this session — the only rows whose citation label is editable here. */
  const [adHocUrls, setAdHocUrls] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<string | null>(null);

  const [running, setRunning] = useState<Phase | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [origins, setOrigins] = useState<OriginReport[]>([]);
  const [sampleOnly, setSampleOnly] = useState(true);
  const [confirmingCommit, setConfirmingCommit] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Ad-hoc input
  const [adHocText, setAdHocText] = useState("");
  const [adHocClass, setAdHocClass] = useState<AdHocClassification>(DEFAULT_ADHOC);
  const [adHocOpen, setAdHocOpen] = useState(false);

  // Scope
  const [isSuperadmin, setIsSuperadmin] = useState(false);
  const [adminInstitution, setAdminInstitution] = useState<Institution | null>(null);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [selectedInstitution, setSelectedInstitution] = useState("");
  const [scopeLoading, setScopeLoading] = useState(true);

  const institutionId = isSuperadmin ? (selectedInstitution || null) : (adminInstitution?.id ?? null);
  const scope: Scope = { institutionId };

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { setScopeLoading(false); return; }

      const { data: profile } = await supabase
        .from("users")
        .select("is_superadmin, institution_id")
        .eq("auth_id", user.id)
        .maybeSingle();

      const superadmin = profile?.is_superadmin === true;
      setIsSuperadmin(superadmin);

      if (superadmin) {
        const { data: insts } = await supabase
          .from("institutions").select("id, name, code").eq("is_active", true).order("name");
        setInstitutions((insts ?? []) as Institution[]);
      } else if (profile?.institution_id) {
        const { data: inst } = await supabase
          .from("institutions").select("id, name, code").eq("id", profile.institution_id).maybeSingle();
        if (inst) setAdminInstitution(inst as Institution);
      }
      setScopeLoading(false);
    });
  }, [supabase]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const entries = useMemo(() => rows.map((r) => r.entry), [rows]);
  /**
   * Deduplicated: a URL listed twice produces the same problem twice, and
   * showing "duplicate URL" on two consecutive lines reads like two faults.
   */
  const problems = useMemo(() => {
    const seen = new Set<string>();
    return validateManifest(entries).filter((p) => {
      const key = `${p.url}|${p.problem}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [entries]);
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.entry.url)), [rows, selected]);
  const summary = useMemo(() => summarize(rows), [rows]);

  const toValidate = eligibleFor(selectedRows, "validate");
  const toPreviewAll = eligibleFor(selectedRows, "preview");
  const toPreview = sampleOnly ? bucketSample(toPreviewAll, (r) => r.entry) : toPreviewAll;
  const toCommit = eligibleFor(selectedRows, "commit");

  const blocked = problems.length > 0;

  // ── Row mutation ───────────────────────────────────────────────────────────

  function patchRow(url: string, patch: Partial<HarvestRow>) {
    setRows((prev) => prev.map((r) => (r.entry.url === url ? { ...r, ...patch } : r)));
  }

  function toggleSelected(url: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  }

  function setAllSelected(on: boolean) {
    setSelected(on ? new Set(rows.map((r) => r.entry.url)) : new Set());
  }

  function addAdHoc() {
    const { urls, problems: parseProblems } = parseUrlList(adHocText);
    const known = new Set(rows.map((r) => r.entry.url));
    const fresh = urls.filter((u) => !known.has(u));

    if (fresh.length === 0) {
      setRunError(
        parseProblems.length > 0
          ? parseProblems.join("; ")
          : "Nothing to add — every URL is already in the run.",
      );
      return;
    }

    const newRows = buildRows(entriesFromUrls(fresh, adHocClass));
    setRows((prev) => [...prev, ...newRows]);
    setSelected((prev) => new Set([...prev, ...fresh]));
    setAdHocUrls((prev) => new Set([...prev, ...fresh]));
    setAdHocText("");
    setRunError(parseProblems.length > 0 ? parseProblems.join("; ") : null);
  }

  function resetRun() {
    abortRef.current?.abort();
    setRows(buildRows(MANIFEST));
    setSelected(new Set(MANIFEST.map((e) => e.url)));
    setAdHocUrls(new Set());
    setOrigins([]);
    setRunError(null);
    setExpanded(null);
    setConfirmingCommit(false);
  }

  // ── The run loop ───────────────────────────────────────────────────────────

  /**
   * One page per request, sequentially, paced by the origin's crawl delay.
   *
   * Sequential rather than parallel on purpose. Concurrency here would be
   * requests we promised to space out, aimed at a university CMS, from a proxy
   * that identifies as us.
   */
  async function runPhase(phase: Phase, targets: HarvestRow[]) {
    if (targets.length === 0 || running) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(phase);
    setRunError(null);
    setConfirmingCommit(false);

    const inFlight: RowPhase = phase === "validate" ? "validating" : phase === "preview" ? "previewing" : "committing";

    try {
      const { verdicts, origins: originReports } = await fetchVerdicts(
        targets.map((r) => r.entry.url),
        scope,
        controller.signal,
      );
      setOrigins(originReports);

      for (const row of targets) {
        if (controller.signal.aborted) break;

        const url = row.entry.url;
        const verdict = verdicts[url] ?? { allowed: false, reason: "no robots verdict returned", delayMs: DEFAULT_DELAY_MS };

        if (!verdict.allowed) {
          patchRow(url, { phase: "skipped", detail: verdict.reason ?? "refused by robots.txt" });
          // No sleep: a skip made no request to the origin, so there is nothing
          // to pace. Sleeping here turns a fully-blocked run into minutes of
          // waiting to report that it did nothing.
          continue;
        }

        patchRow(url, { phase: inFlight, detail: "" });

        try {
          if (phase === "validate") {
            const result = await validateOne(url, scope, controller.signal);
            patchRow(url, {
              phase: result.thin ? "failed" : "validated",
              textLength: result.textLength,
              detail: result.thin
                ? `${result.textLength} chars — too thin, cleaning likely stripped the content`
                : `${result.textLength} chars of text`,
            });
          } else {
            const { report, vectorsUpserted } = await ingestOne(row.entry, phase === "preview", scope, controller.signal);
            if (phase === "preview") {
              patchRow(url, {
                phase: "previewed",
                report,
                detail: report
                  ? `${report.parentChunks} parents / ${report.childChunks} chunks · ${report.namespace}` +
                    (report.replacesExisting ? " · replaces existing" : "") +
                    (report.movesFromNamespace ? ` · moves from ${report.movesFromNamespace}` : "")
                  : "previewed",
              });
            } else {
              patchRow(url, {
                phase: "committed",
                vectorsUpserted,
                detail: vectorsUpserted !== null ? `${vectorsUpserted} vectors indexed` : "ingested",
              });
            }
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") throw err;
          patchRow(url, { phase: "failed", detail: (err as Error).message });
        }

        await sleep(verdict.delayMs, controller.signal);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") setRunError((err as Error).message);
      // Any row left mid-flight belongs back where it can be retried, never
      // parked in a state that reads as progress.
      setRows((prev) =>
        prev.map((r) => (isInFlight(r.phase) ? { ...r, phase: "queued" as RowPhase, detail: "interrupted" } : r)),
      );
    } finally {
      abortRef.current = null;
      setRunning(null);
    }
  }

  function stopRun() {
    abortRef.current?.abort();
  }

  /**
   * Retry one row.
   *
   * Always re-validates rather than resuming where it left off: a row is only
   * retryable from `failed` or `skipped`, and both of those mean the cheap
   * check is the one that has something to say. Re-running it also re-reads
   * robots.txt, which is the whole reason a skip might now succeed.
   */
  async function retryRow(row: HarvestRow) {
    if (running || !canEnter("validate", row.phase)) return;
    await runPhase("validate", [row]);
  }

  // ── Report download ────────────────────────────────────────────────────────

  function downloadReport() {
    const payload = rows.map((r) => ({
      url: r.entry.url,
      docId: r.docId,
      namespace: r.entry.namespace,
      roles: r.entry.roles,
      phase: r.phase,
      detail: r.detail,
      textLength: r.textLength,
      vectorsUpserted: r.vectorsUpserted,
    }));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `harvest-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-6xl mx-auto space-y-6">

      <div className="flex items-center gap-4">
        <Link href="/admin/knowledge" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeftIcon className="size-3.5" />
          Knowledge Base
        </Link>
        <span className="text-border">/</span>
        <span className="text-sm font-medium">Bulk Harvest</span>
      </div>

      <div>
        <h1 className="text-xl font-semibold tracking-tight">Bulk Harvest</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Ingest many uniben.edu pages in one reviewed run. Validate is free; preview and commit
          each cost one document-parsing call per page.
        </p>
      </div>

      {/* ── Manifest problems block the whole run ── */}
      {blocked && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-5 py-4 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangleIcon className="size-4 text-destructive" />
            <p className="text-sm font-medium text-destructive">
              {problems.length} {problems.length === 1 ? "entry is" : "entries are"} invalid — nothing can run
            </p>
          </div>
          <ul className="space-y-1 pl-6">
            {problems.map((p) => (
              <li key={`${p.url}|${p.problem}`} className="text-xs text-destructive/90">
                <span className="font-mono">{p.url}</span> — {p.problem}
              </li>
            ))}
          </ul>
        </div>
      )}

      {runError && (
        <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-3">
          <XIcon className="size-3.5 text-destructive shrink-0 mt-0.5" />
          <p className="text-xs text-destructive leading-snug flex-1">{runError}</p>
          <button type="button" onClick={() => setRunError(null)} className="text-destructive/70 hover:text-destructive">
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6 items-start">

        {/* ── Left: the run ── */}
        <div className="space-y-4">

          {/* Phase controls */}
          <div className="rounded-xl border bg-card px-5 py-4 space-y-4">
            <SectionHeading icon={ListChecksIcon} label="Phases" />

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <PhaseButton
                icon={ShieldIcon}
                title="1 · Validate"
                subtitle={`${toValidate.length} page${toValidate.length === 1 ? "" : "s"} · free`}
                onClick={() => runPhase("validate", toValidate)}
                disabled={blocked || running !== null || toValidate.length === 0}
                active={running === "validate"}
              />
              <PhaseButton
                icon={EyeIcon}
                title="2 · Preview"
                subtitle={`${toPreview.length} page${toPreview.length === 1 ? "" : "s"} · ${toPreview.length} call${toPreview.length === 1 ? "" : "s"}`}
                onClick={() => runPhase("preview", toPreview)}
                disabled={blocked || running !== null || toPreview.length === 0}
                active={running === "preview"}
              />
              <PhaseButton
                icon={UploadCloudIcon}
                title="3 · Commit"
                subtitle={`${toCommit.length} page${toCommit.length === 1 ? "" : "s"} · writes`}
                onClick={() => setConfirmingCommit(true)}
                disabled={blocked || running !== null || toCommit.length === 0}
                active={running === "commit"}
              />
            </div>

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={sampleOnly}
                onChange={(e) => setSampleOnly(e.target.checked)}
                className="size-3.5 rounded border-input"
              />
              Preview one page per host and namespace
              <span className="text-muted-foreground/70">
                — pages sharing a template chunk alike, so previewing all {toPreviewAll.length} pays twice to learn the same thing.
              </span>
            </label>

            {/* Commit confirmation — the UI's equivalent of `--confirm`. */}
            {confirmingCommit && (
              <div className="rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 space-y-3">
                <p className="text-sm">
                  Commit <span className="font-semibold">{toCommit.length}</span>{" "}
                  {toCommit.length === 1 ? "document" : "documents"} to the knowledge base?
                </p>
                <p className="text-xs text-muted-foreground">
                  This writes vectors to Pinecone and rows to the registry, and costs {toCommit.length}{" "}
                  document-parsing {toCommit.length === 1 ? "call" : "calls"}. Existing documents with the same
                  ID are replaced.
                  {institutionId
                    ? " Scoped to the institution selected on the right."
                    : " No institution selected — these documents will be GLOBAL, visible to every institution."}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => runPhase("commit", toCommit)}>
                    Yes, commit {toCommit.length}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmingCommit(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {running && (
              <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3.5 py-2.5">
                <span className="size-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin shrink-0" />
                <p className="text-xs text-muted-foreground flex-1">
                  Running {running}. Pages are processed one at a time and paced to the crawl delay —
                  finished rows are already saved.
                </p>
                <Button size="sm" variant="outline" onClick={stopRun}>
                  <SquareIcon className="size-3 mr-1.5" />
                  Stop
                </Button>
              </div>
            )}
          </div>

          {/* Rows */}
          <div className="rounded-xl border bg-card overflow-hidden">
            <div className="flex items-center gap-3 border-b px-4 py-2.5">
              <input
                type="checkbox"
                checked={selected.size === rows.length && rows.length > 0}
                onChange={(e) => setAllSelected(e.target.checked)}
                className="size-3.5 rounded border-input"
              />
              <span className="text-xs font-medium">
                {selected.size} of {rows.length} selected
              </span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={downloadReport}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <DownloadIcon className="size-3" />
                Report
              </button>
              <button
                type="button"
                onClick={resetRun}
                disabled={running !== null}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
              >
                <RotateCwIcon className="size-3" />
                Reset
              </button>
            </div>

            <div className="divide-y divide-border/60">
              {rows.map((row) => {
                const url = row.entry.url;
                const isOpen = expanded === url;
                const isAdHoc = adHocUrls.has(url);
                return (
                  <div key={url} className={selected.has(url) ? "" : "opacity-50"}>
                    <div className="flex items-start gap-3 px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(url)}
                        onChange={() => toggleSelected(url)}
                        disabled={running !== null}
                        className="mt-1 size-3.5 rounded border-input shrink-0"
                      />

                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <PhasePill phase={row.phase} />
                          {isAdHoc ? (
                            <input
                              value={row.entry.source}
                              onChange={(e) =>
                                patchRow(url, { entry: { ...row.entry, source: e.target.value } })
                              }
                              placeholder="Citation label shown to users"
                              className="text-sm font-medium bg-transparent border-b border-dashed border-border focus:outline-none focus:border-ring min-w-[16rem]"
                            />
                          ) : (
                            <span className="text-sm font-medium">{row.entry.source}</span>
                          )}
                          <span className="text-[11px] rounded border border-border px-1.5 py-0.5 text-muted-foreground">
                            {row.entry.namespace}
                          </span>
                        </div>
                        <p className="text-[11px] font-mono text-muted-foreground truncate">{url}</p>
                        {row.detail && (
                          <p className={`text-[11px] ${row.phase === "failed" ? "text-destructive" : row.phase === "skipped" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
                            {row.detail}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {(row.phase === "failed" || row.phase === "skipped") && (
                          <button
                            type="button"
                            onClick={() => retryRow(row)}
                            disabled={running !== null}
                            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                          >
                            <RotateCwIcon className="size-2.5" />
                            Retry
                          </button>
                        )}
                        {row.report && (
                          <button
                            type="button"
                            onClick={() => setExpanded(isOpen ? null : url)}
                            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {isOpen ? <ChevronDownIcon className="size-2.5" /> : <ChevronRightIcon className="size-2.5" />}
                            Chunks
                          </button>
                        )}
                      </div>
                    </div>

                    {isOpen && row.report && <PreviewDetail report={row.report} />}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Right: scope, summary, ad-hoc ── */}
        <div className="space-y-4 lg:sticky lg:top-6">

          <div className="rounded-xl border bg-card px-5 py-4 space-y-3">
            <SectionHeading icon={BuildingIcon} label="Scope" />
            {scopeLoading ? (
              <div className={`${inputBase} flex items-center text-muted-foreground/50 text-xs`}>Resolving…</div>
            ) : isSuperadmin ? (
              <>
                <div className="relative">
                  <select
                    value={selectedInstitution}
                    onChange={(e) => setSelectedInstitution(e.target.value)}
                    disabled={running !== null}
                    className={selectBase}
                  >
                    <option value="">All institutions (global)</option>
                    {institutions.map((i) => (
                      <option key={i.id} value={i.id}>{i.name} ({i.code})</option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center">
                    <ChevronDownIcon className="size-3.5 text-muted-foreground" />
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Leave blank to make every harvested document available across all institutions.
                </p>
              </>
            ) : (
              <div className="flex items-center gap-2.5 h-9 rounded-lg border border-border bg-muted/40 px-3">
                <LockIcon className="size-3 text-muted-foreground shrink-0" />
                <span className="text-sm">{adminInstitution?.name ?? "Unknown institution"}</span>
              </div>
            )}
          </div>

          <div className="rounded-xl border bg-card px-5 py-4 space-y-3">
            <SectionHeading icon={CheckCircle2Icon} label="Run" />
            <dl className="space-y-1.5 text-xs">
              <SummaryLine label="Total" value={summary.total} />
              <SummaryLine label="Queued" value={summary.queued} />
              <SummaryLine label="Validated" value={summary.validated} />
              <SummaryLine label="Previewed" value={summary.previewed} />
              <SummaryLine label="Ingested" value={summary.committed} tone="success" />
              <SummaryLine label="Skipped" value={summary.skipped} tone="warn" />
              <SummaryLine label="Failed" value={summary.failed} tone="error" />
            </dl>
          </div>

          {origins.length > 0 && (
            <div className="rounded-xl border bg-card px-5 py-4 space-y-3">
              <SectionHeading icon={BanIcon} label="robots.txt" />
              <div className="space-y-2">
                {origins.map((o) => (
                  <div key={o.origin} className="text-[11px] space-y-0.5">
                    <p className="font-mono truncate">{o.origin.replace(/^https?:\/\//, "")}</p>
                    <p className={o.readable ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"}>
                      {o.readable
                        ? `${o.ruleCount} rule${o.ruleCount === 1 ? "" : "s"}${o.crawlDelay ? ` · crawl-delay ${o.crawlDelay}s` : ""}`
                        : `unreadable — every page on this host is skipped${o.error ? ` (${o.error})` : ""}`}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Ad-hoc URLs */}
          <div className="rounded-xl border bg-card px-5 py-4 space-y-3">
            <button
              type="button"
              onClick={() => setAdHocOpen((o) => !o)}
              className="flex w-full items-center gap-2"
            >
              <PlusIcon className="size-3.5 text-muted-foreground" />
              <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Add URLs</span>
              <div className="flex-1 h-px bg-border" />
              {adHocOpen ? <ChevronDownIcon className="size-3.5 text-muted-foreground" /> : <ChevronRightIcon className="size-3.5 text-muted-foreground" />}
            </button>

            {adHocOpen && (
              <div className="space-y-3">
                <p className="text-[11px] text-muted-foreground leading-snug">
                  The {MANIFEST.length}-page manifest above is reviewed in git, next to the roles it grants.
                  URLs added here are checked by the same rules but are not recorded anywhere — add them to{" "}
                  <span className="font-mono">lib/harvest/manifest.ts</span> if they should be part of every future run.
                </p>

                <textarea
                  value={adHocText}
                  onChange={(e) => setAdHocText(e.target.value)}
                  rows={5}
                  placeholder={"https://uniben.edu/page-one.html\nhttps://physci.uniben.edu/page-two/\n# comments and blank lines are ignored"}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs font-mono resize-y placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/40"
                />

                <div className="space-y-2">
                  <Label className="text-xs font-medium">Namespace</Label>
                  <LabelledSelect
                    value={adHocClass.namespace}
                    onChange={(e) =>
                      setAdHocClass((c) => ({
                        ...c,
                        namespace: e.target.value as Namespace,
                        category: e.target.value as Namespace,
                      }))
                    }
                    options={NAMESPACE_OPTIONS}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-xs font-medium">Content type</Label>
                  <LabelledSelect
                    value={adHocClass.contentType}
                    onChange={(e) => setAdHocClass((c) => ({ ...c, contentType: e.target.value as ContentType }))}
                    options={CONTENT_TYPE_OPTIONS.filter((o) => o.value !== "markdown")}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-xs font-medium">Faculty</Label>
                  <Input
                    value={adHocClass.faculty}
                    onChange={(e) => setAdHocClass((c) => ({ ...c, faculty: e.target.value }))}
                    placeholder="general"
                    className={inputBase}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-xs font-medium">Visible to roles</Label>
                  <PillToggleGroup
                    options={ROLES}
                    selected={adHocClass.roles}
                    labels={ROLE_LABELS}
                    onToggle={(role) =>
                      setAdHocClass((c) => ({
                        ...c,
                        roles: c.roles.includes(role as Role)
                          ? c.roles.filter((r) => r !== role)
                          : [...c.roles, role as Role],
                      }))
                    }
                  />
                </div>

                <p className="text-[11px] text-muted-foreground leading-snug">
                  Added with no document date. These pages show none, and stamping today&rsquo;s date would
                  mark them permanently fresh — turning the &ldquo;may be outdated&rdquo; signal into a lie.
                </p>

                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={addAdHoc}
                  disabled={running !== null || adHocText.trim().length === 0 || adHocClass.roles.length === 0}
                >
                  <PlusIcon className="size-3.5 mr-1.5" />
                  Add to run
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function PhaseButton({
  icon: Icon, title, subtitle, onClick, disabled, active,
}: {
  icon: React.ElementType;
  title: string;
  subtitle: string;
  onClick: () => void;
  disabled: boolean;
  active: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-start gap-1 rounded-lg border px-4 py-3 text-left transition-colors ${
        active
          ? "border-primary bg-primary/10"
          : disabled
          ? "border-border bg-muted/20 opacity-50 cursor-not-allowed"
          : "border-border bg-background hover:border-primary/50 hover:bg-primary/5"
      }`}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="size-3.5" />
        {title}
      </span>
      <span className="text-[11px] text-muted-foreground">{subtitle}</span>
    </button>
  );
}

function SummaryLine({ label, value, tone }: { label: string; value: number; tone?: "success" | "warn" | "error" }) {
  const toneClass =
    value === 0
      ? "text-muted-foreground"
      : tone === "success"
      ? "text-success"
      : tone === "warn"
      ? "text-amber-600 dark:text-amber-400"
      : tone === "error"
      ? "text-destructive"
      : "text-foreground";
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`font-mono tabular-nums ${toneClass}`}>{value}</dd>
    </div>
  );
}

function PreviewDetail({ report }: { report: PreviewReport }) {
  return (
    <div className="border-t border-border/60 bg-muted/20 px-4 py-3 space-y-3">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
        <span>{report.textLength.toLocaleString()} chars extracted</span>
        <span>{report.parentChunks} parent chunks</span>
        <span>{report.childChunks} child chunks</span>
        <span>namespace {report.namespace}</span>
        <span>roles {report.roles.join(", ")}</span>
        {report.replacesExisting && <span className="text-amber-600 dark:text-amber-400">replaces an existing document</span>}
        {report.movesFromNamespace && (
          <span className="text-amber-600 dark:text-amber-400">moves from {report.movesFromNamespace}</span>
        )}
      </div>
      {report.sampleChunks.map((chunk) => (
        <div key={chunk.index} className="space-y-1">
          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            chunk {chunk.index} · {chunk.length} chars
          </p>
          <p className="text-[11px] leading-relaxed text-foreground/80 line-clamp-4">
            {chunk.text.replace(/\s+/g, " ").slice(0, 500)}…
          </p>
        </div>
      ))}
    </div>
  );
}
