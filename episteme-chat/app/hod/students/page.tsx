// app/hod/students/page.tsx
// HOD students — verified students linked to the HOD's department via programme.
// Read-only roster. RLS: staff_select_users_in_institution scopes to institution.
import { getHodAssertion, getServerSupabase } from "@/lib/supabase/server-auth";
import { redirect } from "next/navigation";
import { DataTable } from "@/components/admin/data-table";
import { StatusBadge } from "@/components/admin/status-badge";
import { UsersIcon } from "lucide-react";

type StudentRow = {
  id:            string;
  matric_number: string;
  verification_status: string;
  created_at:    string;
  user: { email: string; first_name: string | null; last_name: string | null } | null;
  programme: { name: string; code: string } | null;
};

export default async function HodStudentsPage() {
  const supabase = await getServerSupabase();

  // Same atomic assertion the layout ran; request-cached, so this reuses it.
  const { row: ctx, error } = await getHodAssertion();
  if (error || !ctx) redirect("/sign-in");

  const { data: links } = await supabase
    .from("user_student_links")
    .select(`
      id,
      matric_number,
      verification_status,
      created_at,
      user:user_id(email, first_name, last_name),
      programme:claimed_programme_id(name, code)
    `)
    .eq("department_id", ctx.department_id)
    .order("created_at", { ascending: false });

  const students = ((links ?? []) as unknown as StudentRow[]);

  return (
    <div className="space-y-6 pb-10">
      <div>
        <h1 className="font-serif text-2xl font-semibold">Students</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Students linked to your department via a verified programme.
        </p>
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <DataTable<StudentRow>
          rows={students}
          emptyText="No students linked to this department yet."
          emptyIcon={<UsersIcon className="size-8 text-muted-foreground/40" />}
          columns={[
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
              key:   "matric_number",
              label: "Matric",
              className: "font-mono text-sm w-40",
            },
            {
              key:   "programme",
              label: "Programme",
              render: (r) => {
                const p = r.programme;
                if (!p) return <span className="text-muted-foreground text-sm">—</span>;
                return (
                  <div>
                    <p className="text-sm">{p.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{p.code}</p>
                  </div>
                );
              },
            },
            {
              key:   "verification_status",
              label: "Status",
              className: "w-36",
              render: (r) => <StatusBadge value={r.verification_status} />,
            },
            {
              key:   "created_at",
              label: "Linked",
              className: "w-32 text-sm text-muted-foreground",
              render: (r) => new Date(r.created_at).toLocaleDateString(),
            },
          ]}
        />
      </div>
    </div>
  );
}
