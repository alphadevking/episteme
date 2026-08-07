// app/hod/claims/page.tsx
// HOD claims queue — scoped to assigned_to = HOD via RLS (hod_select_dept_claims).
// Supports ?status= and ?urgent= URL filters.
import { getHodAssertion, getServerSupabase } from "@/lib/supabase/server-auth";
import { asEnum } from "@/lib/types/enums";
import { redirect } from "next/navigation";
import { StatusBadge } from "@/components/admin/status-badge";
import { FilterBar } from "@/components/admin/filter-bar";
import { DataTable } from "@/components/admin/data-table";
import Link from "next/link";
import { ChevronRightIcon, AlertCircleIcon } from "lucide-react";

type SearchParams = Promise<Record<string, string | undefined>>;
type Props = { searchParams: SearchParams };

const STATUS_OPTIONS = [
  { label: "All",       value: "" },
  { label: "Pending",   value: "pending" },
  { label: "In Review", value: "in_review" },
  { label: "Approved",  value: "approved" },
  { label: "Rejected",  value: "rejected" },
];

type ClaimRow = {
  id:         string;
  claim_type: string;
  status:     string;
  is_urgent:  boolean;
  created_at: string;
  auto_routed: boolean;
  user: { email: string; first_name: string | null; last_name: string | null } | null;
};

export default async function HodClaimsPage({ searchParams }: Props) {
  const sp = await searchParams;
  const status = sp.status ?? "";
  const urgent = sp.urgent === "true";

  const supabase = await getServerSupabase();

  // Same atomic assertion the layout ran; request-cached, so this reuses it.
  const { row: ctx, error } = await getHodAssertion();
  if (error || !ctx) redirect("/sign-in");

  let query = supabase
    .from("verification_claims")
    .select("id, claim_type, status, is_urgent, created_at, auto_routed, user:user_id(email, first_name, last_name)")
    .eq("assigned_to", ctx.user_id)
    .order("is_urgent", { ascending: false })
    .order("created_at", { ascending: true });

  // Narrowed against the generated enum values; an unrecognised filter is
  // dropped rather than sent to PostgREST, which rejects the whole query.
  const statusFilter = asEnum("claim_status", status);

  if (statusFilter) query = query.eq("status", statusFilter);
  if (urgent)       query = query.eq("is_urgent", true);

  const { data: claims } = await query;
  const rows2 = ((claims ?? []) as unknown as ClaimRow[]);

  return (
    <div className="space-y-6 pb-10">
      <div>
        <h1 className="font-serif text-2xl font-semibold">Claims Queue</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Claims assigned to your department for review.
        </p>
      </div>

      <FilterBar
        filters={[
          {
            type:    "select",
            key:     "status",
            label:   "Status",
            options: STATUS_OPTIONS,
          },
        ]}
      />

      <div className="rounded-lg border bg-card overflow-hidden">
        <DataTable<ClaimRow>
          rows={rows2}
          emptyText="No claims in your queue."
          emptyIcon={<ChevronRightIcon className="size-8 text-muted-foreground/40" />}
          columns={[
            {
              key:   "claim_type",
              label: "Type",
              render: (r) => (
                <div className="flex items-center gap-2">
                  {r.is_urgent && (
                    <AlertCircleIcon className="size-3.5 text-destructive shrink-0" />
                  )}
                  <span className="text-sm font-medium capitalize">
                    {r.claim_type.replace(/_/g, " ")}
                  </span>
                </div>
              ),
            },
            {
              key:   "user",
              label: "Student",
              render: (r) => {
                const u = r.user;
                if (!u) return <span className="text-muted-foreground text-sm">—</span>;
                const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email;
                return (
                  <div>
                    <p className="text-sm font-medium">{name}</p>
                    <p className="text-xs text-muted-foreground">{u.email}</p>
                  </div>
                );
              },
            },
            {
              key:   "status",
              label: "Status",
              className: "w-32",
              render: (r) => <StatusBadge value={r.status} />,
            },
            {
              key:   "auto_routed",
              label: "Routing",
              className: "w-28 text-xs text-muted-foreground",
              render: (r) => (
                <span className={r.auto_routed ? "text-success" : "text-muted-foreground"}>
                  {r.auto_routed ? "Auto" : "Manual"}
                </span>
              ),
            },
            {
              key:   "created_at",
              label: "Submitted",
              className: "w-32 text-sm text-muted-foreground",
              render: (r) => new Date(r.created_at).toLocaleDateString(),
            },
            {
              key:   "actions",
              label: "",
              className: "w-10 text-right",
              render: (r) => (
                <Link href={`/hod/claims/${r.id}`}>
                  <span className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
                    <ChevronRightIcon className="size-4" />
                  </span>
                </Link>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
