// components/admin/institution-switcher.tsx
// Used on /superadmin/institutions to let superadmin jump into admin context.
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SettingsIcon } from "lucide-react";

type Props = { institutionId: string };

export function ManageInstitutionButton({ institutionId }: Props) {
  return (
    <Link href={`/admin?institution=${institutionId}`}>
      <Button size="sm" className="gap-1.5">
        <SettingsIcon className="size-3.5" />
        Manage
      </Button>
    </Link>
  );
}