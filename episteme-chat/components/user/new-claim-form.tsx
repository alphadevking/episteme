// components/user/new-claim-form.tsx
// Claim submission form — pure structured form, no AI.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  FileTextIcon,
  GraduationCapIcon,
  BookOpenIcon,
  ShieldCheckIcon,
  ScrollIcon,
} from "lucide-react";

type ClaimType = "transcript" | "degree" | "enrollment" | "good_standing" | "attestation";

const CLAIM_TYPES: {
  id:          ClaimType;
  label:       string;
  description: string;
  icon:        React.ElementType;
}[] = [
  {
    id:          "transcript",
    label:       "Academic Transcript",
    description: "Official record of courses taken and grades earned.",
    icon:        FileTextIcon,
  },
  {
    id:          "degree",
    label:       "Degree Certificate",
    description: "Confirmation of degree award and graduation.",
    icon:        GraduationCapIcon,
  },
  {
    id:          "enrollment",
    label:       "Enrollment Letter",
    description: "Proof of current enrollment in a programme.",
    icon:        BookOpenIcon,
  },
  {
    id:          "good_standing",
    label:       "Good Standing Letter",
    description: "Confirms you are in academic good standing.",
    icon:        ShieldCheckIcon,
  },
  {
    id:          "attestation",
    label:       "Letter of Attestation",
    description: "Official attestation for external purposes.",
    icon:        ScrollIcon,
  },
];

// ── Per-type detail fields ─────────────────────────────────────────────────────
type FieldDef = { key: string; label: string; placeholder: string; required?: boolean };

const FIELDS: Record<ClaimType, FieldDef[]> = {
  transcript: [
    { key: "matric_number",  label: "Matric Number",  placeholder: "e.g. 20/ENG/CS/001", required: true },
    { key: "academic_year",  label: "Academic Year",  placeholder: "e.g. 2023/2024",     required: true },
    { key: "semester",       label: "Semester",        placeholder: "e.g. First or Second" },
    { key: "purpose",        label: "Purpose",         placeholder: "e.g. Graduate school application" },
  ],
  degree: [
    { key: "matric_number",    label: "Matric Number",    placeholder: "e.g. 20/ENG/CS/001", required: true },
    { key: "graduation_year",  label: "Graduation Year",  placeholder: "e.g. 2024",          required: true },
    { key: "purpose",          label: "Purpose",           placeholder: "e.g. Employment verification" },
  ],
  enrollment: [
    { key: "matric_number", label: "Matric Number", placeholder: "e.g. 20/ENG/CS/001", required: true },
    { key: "academic_year", label: "Academic Year", placeholder: "e.g. 2023/2024",     required: true },
    { key: "semester",      label: "Semester",       placeholder: "e.g. First or Second" },
  ],
  good_standing: [
    { key: "matric_number", label: "Matric Number", placeholder: "e.g. 20/ENG/CS/001", required: true },
    { key: "academic_year", label: "Academic Year", placeholder: "e.g. 2023/2024",     required: true },
  ],
  attestation: [
    { key: "purpose",    label: "Purpose",    placeholder: "e.g. Bank loan, scholarship application", required: true },
    { key: "recipient",  label: "Recipient",  placeholder: "e.g. GTBank, NNPC Limited" },
  ],
};

export function NewClaimForm() {
  const router = useRouter();

  const [claimType,  setClaimType]  = useState<ClaimType | null>(null);
  const [details,    setDetails]    = useState<Record<string, string>>({});
  const [isUrgent,   setIsUrgent]   = useState(false);
  const [deadline,   setDeadline]   = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleTypeSelect = (type: ClaimType) => {
    setClaimType(type);
    setDetails({});
  };

  const setField = (key: string, value: string) =>
    setDetails((prev) => ({ ...prev, [key]: value }));

  const canSubmit = (): boolean => {
    if (!claimType) return false;
    for (const f of FIELDS[claimType]) {
      if (f.required && !details[f.key]?.trim()) return false;
    }
    return true;
  };

  const submit = async () => {
    if (!canSubmit() || !claimType) return;
    setSubmitting(true);

    const res = await fetch("/api/claims", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        claim_type: claimType,
        details,
        is_urgent: isUrgent,
        deadline:  deadline || null,
      }),
    });

    const json = await res.json();
    setSubmitting(false);

    if (!res.ok) {
      toast.error(json.error ?? "Failed to submit claim.");
      return;
    }

    toast.success("Claim submitted. You will be notified when it is reviewed.");
    router.push(`/claims/${json.id}`);
  };

  return (
    <div className="space-y-6">

      {/* ── Step 1: Type selection ── */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          1. Document type
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {CLAIM_TYPES.map(({ id, label, description, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => handleTypeSelect(id)}
              className={cn(
                "flex items-start gap-3 rounded-lg border p-4 text-left transition-colors",
                claimType === id
                  ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
                  : "hover:bg-muted/40 hover:border-primary/20",
              )}
            >
              <Icon className={cn(
                "mt-0.5 size-4 shrink-0",
                claimType === id ? "text-primary" : "text-muted-foreground",
              )} />
              <div>
                <p className={cn(
                  "text-sm font-medium",
                  claimType === id ? "text-primary" : "text-foreground",
                )}>
                  {label}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  {description}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Step 2: Type-specific fields ── */}
      {claimType && (
        <div className="space-y-4 rounded-lg border bg-card p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            2. Details
          </h2>

          <div className="space-y-4">
            {FIELDS[claimType].map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={f.key} className="text-sm">
                  {f.label}
                  {f.required && <span className="text-destructive ml-1">*</span>}
                </Label>
                <Input
                  id={f.key}
                  value={details[f.key] ?? ""}
                  onChange={(e) => setField(f.key, e.target.value)}
                  placeholder={f.placeholder}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Step 3: Options ── */}
      {claimType && (
        <div className="space-y-4 rounded-lg border bg-card p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            3. Options
          </h2>

          {/* Urgent */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={isUrgent}
              onChange={(e) => setIsUrgent(e.target.checked)}
              className="mt-0.5 size-4 rounded border-input accent-primary"
            />
            <div>
              <p className="text-sm font-medium">Mark as urgent</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Flags this claim for priority review. Use only when genuinely time-sensitive.
              </p>
            </div>
          </label>

          {/* Deadline */}
          <div className="space-y-1.5">
            <Label htmlFor="deadline" className="text-sm">
              Deadline{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="deadline"
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              min={new Date().toISOString().split("T")[0]}
              className="w-48"
            />
          </div>
        </div>
      )}

      {/* ── Submit ── */}
      {claimType && (
        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={() => { setClaimType(null); setDetails({}); }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            ← Choose different type
          </button>
          <Button
            onClick={submit}
            disabled={submitting || !canSubmit()}
            className="min-w-[140px]"
          >
            {submitting ? "Submitting…" : "Submit Claim"}
          </Button>
        </div>
      )}
    </div>
  );
}
