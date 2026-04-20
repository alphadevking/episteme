"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Trash2Icon, RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/admin/data-table";

type KbDocument = {
  docId: string;
  fileName: string;
  namespace: string;
  category: string;
  contentType: string;
  faculty: string;
  source: string;
  roles: string[];
  vectorsUpserted: number;
  parentChunks: number;
  childChunks: number;
  ingestedAt: string;
  markdownContent: string | null;
  plainTextContent: string | null;
};

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

function DocActions({ doc }: { doc: KbDocument }) {
  const router = useRouter();
  const [deleting,    setDeleting]    = useState(false);
  const [reingesting, setReingesting] = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  const canReingest = !!(doc.markdownContent || doc.plainTextContent);

  async function handleDelete() {
    if (!confirm(`Delete "${doc.fileName}"? This removes all vectors from Pinecone and cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/kb/${encodeURIComponent(doc.docId)}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setError(d.error ?? "Delete failed.");
      } else {
        router.refresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(false);
    }
  }

  async function handleReingest() {
    setReingesting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/kb/${encodeURIComponent(doc.docId)}`, { method: "POST" });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setError(d.error ?? "Re-ingestion failed.");
      } else {
        router.refresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setReingesting(false);
    }
  }

  return (
    <div className="flex items-center justify-end gap-1">
      {error && (
        <span className="text-[10px] text-destructive mr-1 max-w-[120px] truncate" title={error}>{error}</span>
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
          key: "ingestedAt",
          label: "Ingested",
          render: (r) => (
            <span className="text-xs text-muted-foreground tabular-nums">
              {new Date(r.ingestedAt).toLocaleDateString("en-GB", {
                day: "2-digit", month: "short", year: "numeric",
              })}
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
