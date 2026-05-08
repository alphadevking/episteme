// app/admin/knowledge/page.tsx
import { PageHeader } from "@/components/admin/page-header";
import { KbDocumentTable } from "@/components/admin/kb-document-table";
import { Button } from "@/components/ui/button";
import { DatabaseIcon, LayersIcon, NetworkIcon, UploadCloudIcon } from "lucide-react";
import Link from "next/link";
import type { KbDocument } from "@/lib/types/kb";

async function fetchDocuments(): Promise<KbDocument[]> {
  const base = process.env.MASTRA_BASE_URL ?? "http://localhost:4111";
  const adminKey = process.env.MASTRA_ADMIN_KEY ?? "";

  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/kb/documents`, {
      headers: { "x-episteme-admin-key": adminKey },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json() as { documents: KbDocument[] };
    return data.documents ?? [];
  } catch {
    return [];
  }
}

export default async function KnowledgePage() {
  const documents = await fetchDocuments();

  const totalVectors = documents.reduce((sum, d) => sum + d.vectorsUpserted, 0);
  const activeNamespaces = new Set(documents.map((d) => d.namespace)).size;

  const stats = [
    { label: "Documents",        value: documents.length,              icon: DatabaseIcon, color: "text-accent-secondary bg-accent-secondary-bg dark:bg-accent-secondary-bg dark:text-accent-secondary" },
    { label: "Total Vectors",    value: totalVectors.toLocaleString(), icon: LayersIcon,   color: "text-accent-tertiary bg-accent-tertiary-bg dark:bg-accent-tertiary-bg dark:text-accent-tertiary" },
    { label: "Active Namespaces",value: activeNamespaces,              icon: NetworkIcon,  color: "text-success bg-success-bg dark:bg-success-bg dark:text-success" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge Base"
        description="Manage ingested documents powering the Episteme AI assistant."
        action={
          <Button size="sm" asChild>
            <Link href="/admin/knowledge/ingest">
              <UploadCloudIcon className="size-4 mr-2" />
              Ingest Document
            </Link>
          </Button>
        }
      />

      <div className="grid grid-cols-3 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{s.label}</span>
              <div className={`flex size-7 items-center justify-center rounded-md ${s.color}`}>
                <s.icon className="size-3.5" />
              </div>
            </div>
            <p className="text-2xl font-semibold tracking-tight">{s.value}</p>
          </div>
        ))}
      </div>

      <KbDocumentTable documents={documents} />
    </div>
  );
}
