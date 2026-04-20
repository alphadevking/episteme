// app/superadmin/admins/page.tsx
// Provision a user as admin for their institution.
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import { PageHeader } from "@/components/admin/page-header";
import { DataTable } from "@/components/admin/data-table";
import { ProvisionAdminForm } from "@/components/admin/provision-admin-form";

type AdminUser = {
  id:              string;
  email:           string;
  first_name:      string | null;
  last_name:       string | null;
  primary_role:    string;
  institution_id:  string | null;
  institutions:    { name: string } | null;
};

export default async function AdminsPage() {
  const supabase = await createSupabaseServerClientReadOnly();

  const { data: admins } = await supabase
    .from("users")
    .select("id, email, first_name, last_name, primary_role, institution_id, institutions(name)")
    .contains("roles", ["admin"])
    // Exclude superadmin accounts — is_superadmin is the single source of truth
    .eq("is_superadmin", false)
    .order("created_at", { ascending: false });

  return (
    <div>
      <PageHeader
        title="Institution Admins"
        description="Provision a user as admin for their institution."
        action={<ProvisionAdminForm />}
      />

      <DataTable<AdminUser>
        rows={(admins ?? []) as unknown as AdminUser[]}
        emptyText="No admins provisioned yet."
        columns={[
          {
            key:    "name",
            label:  "Name",
            render: (row) =>
              [row.first_name, row.last_name].filter(Boolean).join(" ") || "—",
          },
          { key: "email", label: "Email" },
          {
            key:    "institution",
            label:  "Institution",
            render: (row) => row.institutions?.name ?? "—",
          },
          { key: "primary_role", label: "Role", className: "capitalize" },
        ]}
      />
    </div>
  );
}