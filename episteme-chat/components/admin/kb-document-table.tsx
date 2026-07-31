"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Trash2Icon, RefreshCwIcon, PencilIcon, TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/admin/data-table";
import { EditScopeDialog } from "@/components/admin/edit-scope-dialog";
import type { KbDocument } from "@/lib/types/kb";

type Props = { documents: KbDocument[] };

const NS_COLOURS: Record<string, string> = {
  "admissions":      "bg-accent-tertiary-bg text-accent-tertiary dark:bg-accent-tertiary-bg dark:text-accent-tertiary",
  "academic-policy": "bg-accent-secondary-bg text-accent-secondary dark:bg-accent-secondary-bg dark:text-accent-secondary",
  "financial-aid":   "bg-success-bg text-success dark:bg-success-bg dark:text-success",
  "programmes":      "bg-warning-bg text-warning dark:bg-warning-bg dark:text-warning",
  "staff-internal":  "bg-error-bg text-error dark:bg-error-bg dark:text-error",
  "general":         "bg-muted text-muted-foreground",
};

function NamespaceBadge({ value }: { value: string }) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${NS_COLOURS[value] ?? NS_COLOURS["general"]}`}>
      {value}
    </span>
  );
}

// Mirrors RETRIEVAL_FRESHNESS_THRESHOLD_DAYS (default 365) in episteme-core: a
// document whose CONTENT date is older than this is flagged "may be outdated" in
// retrieval, and the cascade defers to a fresher tier when one can answer.
const STALE_DAYS = 365;

// A document may be genuinely UNDATED (a scraped page showing no date anywhere).
// Both helpers must treat that as "unknown", not as a date:
//   new Date(null) is the Unix epoch, so the naive versions rendered "01 Jan
//   1970" and flagged every undated document as stale. Unknown age is not old
//   age — the same distinction retrieval draws in knowledge-retrieval-tool.ts.
function fmtDate(iso: string | null): string {
  if (!iso) return "Undated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Undated";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function isStale(iso: string | null): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) / (1000 * 60 * 60 * 24) > STALE_DAYS;
}

function DocActions({ doc }: { doc: KbDocument }) {
  const router = useRouter();
  const [deleting,    setDeleting]    = useState(false);
  const [reingesting, setReingesting] = useState(false);
  const [editing,     setEditing]     = useState(false);

  const canReingest = !!(doc.markdownContent || doc.plainTextContent);

  async function handleDelete() {
    if (!confirm(`Delete "${doc.fileName}"? This removes all vectors from Pinecone and cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/kb/${encodeURIComponent(doc.docId)}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        toast.error(d.error ?? "Delete failed.");
      } else {
        toast.success(`Deleted "${doc.fileName}".`);
        router.refresh();
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDeleting(false);
    }
  }

  async function handleReingest() {
    setReingesting(true);
    try {
      const res = await fetch(`/api/admin/kb/${encodeURIComponent(doc.docId)}`, { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        toast.error(d.error ?? "Re-ingestion failed.");
      } else {
        toast.success(`Re-ingested "${doc.fileName}".`);
        router.refresh();
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setReingesting(false);
    }
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="ghost" size="sm"
        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
        onClick={() => setEditing(true)}
        title="Edit scope (roles, levels, programme, category, content type)"
      >
        <PencilIcon className="size-3.5" />
      </Button>
      {editing && (
        <EditScopeDialog
          doc={doc}
          open={editing}
          onOpenChange={setEditing}
          onSaved={() => router.refresh()}
        />
      )}
      {canReingest && (
        <Button
          variant="ghost" size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          onClick={handleReingest}
          disabled={reingesting}
          title="Re-ingest"
        >
          <RefreshCwIcon className={`size-3.5 ${reingesting ? "animate-spin" : ""}`} />
        </Button>
      )}
      <Button
        variant="ghost" size="sm"
        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
        onClick={handleDelete}
        disabled={deleting}
        title="Delete from knowledge base"
      >
        <Trash2Icon className="size-3.5" />
      </Button>
    </div>
  );
}

export function KbDocumentTable({ documents }: Props) {
  const rows = documents.map((d) => ({ ...d, id: d.docId }));

  return (
    <DataTable<KbDocument & { id: string }>
      rows={rows}
      emptyText="No documents ingested yet. Upload a document to populate the knowledge base."
      columns={[
        {
          key: "fileName",
          label: "Document",
          render: (r) => (
            <div className="min-w-0">
              <p className="font-medium text-sm truncate max-w-[200px]">{r.fileName}</p>
              <p className="text-[11px] text-muted-foreground font-mono truncate max-w-[200px]">{r.docId}</p>
            </div>
          ),
        },
        {
          key: "namespace",
          label: "Namespace",
          render: (r) => <NamespaceBadge value={r.namespace} />,
        },
        {
          key: "contentType",
          label: "Type",
          render: (r) => (
            <span className="text-xs text-muted-foreground capitalize">{r.contentType}</span>
          ),
        },
        {
          key: "programme",
          label: "Programme",
          render: (r) => (
            <span className={`text-xs ${r.programme ? "text-foreground" : "text-muted-foreground/50 italic"}`}>
              {r.programme ?? "Not available"}
            </span>
          ),
        },
        {
          key: "levels",
          label: "Level",
          render: (r) => (
            <span className={`text-xs ${r.levels.length > 0 ? "text-foreground font-medium" : "text-muted-foreground/50 italic"}`}>
              {r.levels.length > 0 ? r.levels.join(", ") : "All levels"}
            </span>
          ),
        },
        {
          key: "vectorsUpserted",
          label: "Vectors",
          render: (r) => (
            <div className="text-xs">
              <span className="font-medium tabular-nums">{r.vectorsUpserted.toLocaleString()}</span>
              <span className="text-muted-foreground ml-1">
                ({r.parentChunks}P · {r.childChunks}C)
              </span>
            </div>
          ),
        },
        {
          key: "roles",
          label: "Roles",
          render: (r) => (
            <span className="text-xs text-muted-foreground capitalize">{r.roles.join(", ")}</span>
          ),
        },
        {
          key: "updatedAt",
          label: "Doc date",
          render: (r) => {
            const stale = isStale(r.updatedAt);
            return (
              <span
                className={`inline-flex items-center gap-1 text-xs tabular-nums ${stale ? "text-warning" : "text-foreground"}`}
                title={
                  stale
                    ? "Content date is over 12 months old — flagged as possibly outdated in retrieval; the assistant defers to a fresher source when one can answer."
                    : "The document's own content date — drives the freshness signal."
                }
              >
                {stale && <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />}
                {fmtDate(r.updatedAt)}
              </span>
            );
          },
        },
        {
          key: "ingestedAt",
          label: "Ingested",
          render: (r) => (
            <span
              className="text-xs text-muted-foreground tabular-nums"
              title="When this document was last loaded into the knowledge base (audit only — not the freshness signal)."
            >
              {fmtDate(r.ingestedAt)}
            </span>
          ),
        },
        {
          key: "actions",
          label: "",
          className: "w-20",
          render: (r) => <DocActions doc={r} />,
        },
      ]}
    />
  );
}
