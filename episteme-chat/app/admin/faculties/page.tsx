// app/admin/faculties/page.tsx
import { PageHeader } from "@/components/admin/page-header";
import { DataTable } from "@/components/admin/data-table";
import { StatusBadge } from "@/components/admin/status-badge";
import { CrudDialog } from "@/components/admin/crud-dialog";
import { FilterBar } from "@/components/admin/filter-bar";
import { requireAdminAccess } from "@/lib/admin-guard";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BuildingIcon, ChevronRightIcon, MailIcon } from "lucide-react";

type Props = { searchParams: Promise<{ institution?: string; q?: string; status?: string }> };
type Faculty = { id: string; name: string; code: string; dean_email: string | null; is_active: boolean };

const STATUS_OPTIONS = [
  { value: "active",   label: "Active"   },
  { value: "inactive", label: "Inactive" },
];

export default async function FacultiesPage({ searchParams }: Props) {
  const { institution: institutionParam, q, status } = await searchParams;
  const { supabase, institutionId } = await requireAdminAccess(institutionParam);

  let query = supabase
    .from("faculties")
    .select("id, name, code, dean_email, is_active")
    .eq("institution_id", institutionId)
    .order("name");

  if (q)      query = query.or(`name.ilike.%${q}%,code.ilike.%${q}%`);
  if (status === "active")   query = query.eq("is_active", true);
  if (status === "inactive") query = query.eq("is_active", false);

  const { data: faculties } = await query;

  const FIELDS = [
    { key: "name",       label: "Name",       required: true, placeholder: "Faculty of Computing" },
    { key: "code",       label: "Code",       required: true, placeholder: "COMP" },
    { key: "dean_email", label: "Dean Email", type: "email" as const },
    { key: "is_active",  label: "Active",     type: "checkbox" as const },
  ];

  const instParam = institutionParam ? `?institution=${institutionId}` : "";

  const rows = (faculties ?? []) as Faculty[];
  const activeCount   = rows.filter((f) => f.is_active).length;
  const inactiveCount = rows.length - activeCount;

  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        title="Faculties"
        description="Top-level academic groupings within this institution."
        action={
          <CrudDialog
            mode="create"
            table="faculties"
            title="Faculty"
            fields={FIELDS}
            defaults={{ institution_id: institutionId, is_active: true }}
          />
        }
      />

      {/* ── Filters ───────────────────────────────────────────── */}
      <FilterBar
        filters={[
          { type: "search", placeholder: "Search name or code…" },
          { type: "select", key: "status", label: "Status", all: "All statuses", options: STATUS_OPTIONS },
        ]}
      />

      {/* ── Summary pills ─────────────────────────────────────── */}
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs font-medium text-foreground">
            <BuildingIcon className="size-3 text-muted-foreground" />
            {rows.length} {rows.length === 1 ? "faculty" : "faculties"}
          </span>
          {activeCount > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success-bg px-3 py-1 text-xs font-medium text-success">
              {activeCount} active
            </span>
          )}
          {inactiveCount > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
              {inactiveCount} inactive
            </span>
          )}
        </div>
      )}

      {/* ── Table ─────────────────────────────────────────────── */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <DataTable<Faculty>
          rows={rows}
          emptyText={q || status ? "No faculties match your filters." : "No faculties yet."}
          emptyIcon={<BuildingIcon className="size-8 text-muted-foreground/40" />}
          columns={[
            {
              key: "name",
              label: "Faculty",
              render: (r) => (
                <div className="flex items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-secondary-bg">
                    <span className="text-[11px] font-bold text-accent-secondary tracking-wide">
                      {r.code.slice(0, 3).toUpperCase()}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <Link
                      href={`/admin/faculties/${r.id}${instParam}`}
                      className="block text-sm font-medium text-foreground hover:text-primary transition-colors truncate"
                    >
                      {r.name}
                    </Link>
                    {r.dean_email && (
                      <span className="flex items-center gap-1 mt-0.5 text-[11px] text-muted-foreground truncate">
                        <MailIcon className="size-2.5 shrink-0" />
                        {r.dean_email}
                      </span>
                    )}
                  </div>
                </div>
              ),
            },
            {
              key: "code",
              label: "Code",
              className: "w-24",
              render: (r) => (
                <span className="inline-flex items-center rounded-md border bg-muted/50 px-2 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
                  {r.code}
                </span>
              ),
            },
            {
              key: "is_active",
              label: "Status",
              className: "w-28",
              render: (r) => <StatusBadge value={r.is_active} />,
            },
            {
              key: "actions",
              label: "",
              className: "w-28 text-right",
              render: (r) => (
                <div className="flex items-center justify-end gap-1">
                  <CrudDialog
                    mode="edit"
                    table="faculties"
                    title="Faculty"
                    fields={FIELDS}
                    defaults={{ institution_id: institutionId }}
                    rowId={r.id}
                    initial={{
                      name: r.name,
                      code: r.code,
                      dean_email: r.dean_email ?? "",
                      is_active: r.is_active,
                    }}
                  />
                  <Link href={`/admin/faculties/${r.id}${instParam}`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      title="View faculty"
                    >
                      <ChevronRightIcon className="size-4" />
                    </Button>
                  </Link>
                </div>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
