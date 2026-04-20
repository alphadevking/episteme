// app/claims/new/page.tsx
// Claim submission form — structured, no AI involvement.
// Client component handles type selection + field rendering + POST /api/claims.
import { NewClaimForm } from "@/components/user/new-claim-form";

export default function NewClaimPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-xl font-semibold">Submit a Verification Claim</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Select the document type you need and fill in the required details.
          Your request will be reviewed by your department head.
        </p>
      </div>
      <NewClaimForm />
    </div>
  );
}
