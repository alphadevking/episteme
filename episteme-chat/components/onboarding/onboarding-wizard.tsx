// components/onboarding/onboarding-wizard.tsx
"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  JOURNEY_STEPS,
  useOnboarding,
  type OnboardingRole,
  type StepData,
} from "@/lib/hooks/use-onboarding";
import { LEVEL_OPTIONS } from "@/lib/constants/academic";
import { cn } from "@/lib/utils";
import {
  BookOpenIcon,
  CheckCircle2Icon,
  GraduationCapIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { useEffect, useState } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

type WizardProps = {
  sessionId: string;
  userId: string;
  totalSteps: number;
  initialStep: number;
  initialData: Record<string, unknown>;
  prefill?: {
    firstName?: string;
    lastName?: string;
    role?: string;
  };
};

// ── Root wizard ────────────────────────────────────────────────────────────

export function OnboardingWizard(props: WizardProps) {
  const onboarding = useOnboarding({
    sessionId: props.sessionId,
    userId: props.userId,
    totalSteps: props.totalSteps,
    initialStep: props.initialStep,
    initialData: props.initialData,
  });

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg space-y-8">

        <div className="space-y-1 text-center">
          <div className="flex justify-center mb-3">
            <Logo width={48} height={48} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Welcome to Episteme
          </h1>
          <p className="text-sm text-muted-foreground">
            Let&apos;s get your account set up — it only takes a minute.
          </p>
        </div>

        <ProgressBar current={onboarding.step} total={onboarding.totalSteps} />

        {onboarding.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {onboarding.error}
          </div>
        )}

        <div className="rounded-xl border bg-card p-6 shadow-sm">

          {/* Step 1 — identity: role + name (all journeys) */}
          {onboarding.stepKey === "identity" && (
            <StepIdentity
              prefill={props.prefill}
              current={{
                role: onboarding.data.role,
                firstName: onboarding.data.firstName,
                lastName: onboarding.data.lastName,
                phone: onboarding.data.phone,
              }}
              onNext={(payload) => onboarding.next(payload)}
              saving={onboarding.saving}
            />
          )}

          {/* Step 2 — prospective & parent: institution search */}
          {onboarding.stepKey === "institution_search" && (
            <StepInstitutionSearch
              current={onboarding.data.institutionId}
              onNext={(id, name) => onboarding.next({ institutionId: id, institutionName: name })}
              onBack={onboarding.back}
              saving={onboarding.saving}
            />
          )}

          {/* Step 2 — student: institution + student ID */}
          {onboarding.stepKey === "student_id_verify" && (
            <StepStudentIdVerify
              current={{
                institutionId: onboarding.data.institutionId,
                studentId: onboarding.data.studentId,
                trustLevel: onboarding.data.trustLevel,
              }}
              onNext={(id, name, studentId, trustLevel) =>
                onboarding.next({ institutionId: id, institutionName: name, studentId, trustLevel })
              }
              onBack={onboarding.back}
              saving={onboarding.saving}
            />
          )}

          {/* Step 2 — staff: institution verify */}
          {onboarding.stepKey === "institution_verify" && (
            <StepInstitutionVerify
              current={onboarding.data.institutionId}
              onNext={(id, name) => onboarding.next({ institutionId: id, institutionName: name })}
              onBack={onboarding.back}
              saving={onboarding.saving}
            />
          )}

          {/* Step 3 — prospective: programme interest */}
          {onboarding.stepKey === "programme_interest" && (
            <StepProgrammeInterest
              institutionId={onboarding.data.institutionId}
              current={onboarding.data.programmeInterest}
              onNext={(programmeInterest) => onboarding.next({ programmeInterest })}
              onBack={onboarding.back}
              saving={onboarding.saving}
            />
          )}

          {/* Step 3 — student: confirm current programme + level */}
          {onboarding.stepKey === "programme_confirm" && (
            <StepProgrammeConfirm
              institutionId={onboarding.data.institutionId}
              current={onboarding.data.programmeName}
              currentLevel={onboarding.data.level}
              onNext={(programmeName, level) => onboarding.next({ programmeName, level })}
              onBack={onboarding.back}
              saving={onboarding.saving}
            />
          )}

          {/* Step 3 — parent: link to ward */}
          {onboarding.stepKey === "ward_link" && (
            <StepWardLink
              current={{ wardStudentId: onboarding.data.wardStudentId, wardRelationship: onboarding.data.wardRelationship }}
              onNext={(wardStudentId, wardRelationship) => onboarding.next({ wardStudentId, wardRelationship })}
              onBack={onboarding.back}
              saving={onboarding.saving}
            />
          )}

          {/* Step 3 — staff: department + role title */}
          {onboarding.stepKey === "department" && (
            <StepDepartment
              institutionId={onboarding.data.institutionId}
              current={onboarding.data.department}
              currentTitle={onboarding.data.staffTitle}
              onNext={(department, staffTitle) => onboarding.next({ department, staffTitle })}
              onBack={onboarding.back}
              saving={onboarding.saving}
            />
          )}

          {/* Step 4 — preferences + review (all journeys) */}
          {onboarding.stepKey === "preferences" && (
            <StepPreferences
              data={onboarding.data}
              onComplete={(verbosity) => onboarding.complete({ verbosity })}
              onBack={onboarding.back}
              saving={onboarding.saving}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Progress bar ───────────────────────────────────────────────────────────

function ProgressBar({ current, total }: { current: number; total: number }) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Step {current} of {total}</span>
        <span>{Math.round((current / total) * 100)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500"
          style={{ width: `${(current / total) * 100}%` }}
        />
      </div>
    </div>
  );
}

// ── Shared: debounce hook ──────────────────────────────────────────────────

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ── Shared: institution search field ──────────────────────────────────────

type InstitutionResult = { id: string; name: string };

function InstitutionSearchField({
  selectedId,
  onSelect,
}: {
  selectedId?: string;
  onSelect: (id: string, name: string) => void;
}) {
  const supabase = createSupabaseBrowserClient();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InstitutionResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedName, setSelectedName] = useState("");
  const debouncedQuery = useDebounce(query, 300);

  // Confirmed = a result has been picked and the input hasn't been edited since.
  const confirmed = !!selectedName && !!selectedId;

  useEffect(() => {
    if (confirmed) { setResults([]); return; }
    if (debouncedQuery.length < 2) { setResults([]); return; }
    setSearching(true);
    supabase
      .rpc("fn_search_institutions", { p_query: debouncedQuery })
      .then(({ data }) => {
        setResults((data ?? []) as InstitutionResult[]);
        setSearching(false);
      });
  }, [debouncedQuery, supabase, confirmed]);

  const handleSelect = (inst: InstitutionResult) => {
    setSelectedName(inst.name);
    setQuery(inst.name);
    setResults([]);
    onSelect(inst.id, inst.name);
  };

  const handleClear = () => {
    setSelectedName("");
    setQuery("");
    setResults([]);
  };

  // ── Confirmed state — show chip instead of search + list ──────────────
  if (confirmed) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5">
        <CheckCircle2Icon className="size-4 shrink-0 text-primary" />
        <span className="flex-1 text-sm font-medium text-primary">{selectedName}</span>
        <button
          type="button"
          onClick={handleClear}
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors"
        >
          Change
        </button>
      </div>
    );
  }

  // ── Search state ───────────────────────────────────────────────────────
  return (
    <div className="space-y-2">
      <div className="relative">
        <SearchIcon className="absolute left-2.5 top-2.5 size-4 text-muted-foreground pointer-events-none" />
        <Input
          placeholder="Search institutions…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); }}
          autoComplete="off"
          className="pl-8"
          autoFocus
        />
      </div>
      {searching && (
        <p className="text-xs text-muted-foreground animate-pulse">Searching…</p>
      )}
      {results.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded-md border shadow-sm">
          {results.map((inst) => (
            <button
              key={inst.id}
              type="button"
              onClick={() => handleSelect(inst)}
              className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60"
            >
              {inst.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Shared: DB-backed searchable list ─────────────────────────────────────
// Used for programmes and departments — loads all options for the institution
// upfront (institutions have O(100) programmes, not millions) then filters locally.

type ListOption = { id: string; label: string };

function SearchableList({
  options,
  loading,
  value,
  onChange,
  placeholder,
  emptyText = "No results.",
}: {
  options: ListOption[];
  loading: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  emptyText?: string;
}) {
  const [filter, setFilter] = useState("");
  const filtered = filter.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()))
    : options;

  return (
    <div className="space-y-2">
      {/* Filter input — only shown when there are enough options to warrant it */}
      {options.length > 6 && (
        <div className="relative">
          <SearchIcon className="absolute left-2.5 top-2.5 size-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder={placeholder}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-8"
          />
        </div>
      )}

      {loading && (
        <div className="space-y-1.5 py-1">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">{emptyText}</p>
      )}

      {!loading && filtered.length > 0 && (
        <div className="max-h-52 overflow-y-auto rounded-md border shadow-sm">
          {filtered.map((opt) => {
            const isSelected = value === opt.label;
            return (
              <button
                key={opt.id}
                type="button"
                // Clicking the selected item again deselects it
                onClick={() => onChange(isSelected ? "" : opt.label)}
                className={cn(
                  "w-full px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/60",
                  isSelected && "bg-primary/5 font-medium text-primary",
                )}
              >
                <span className="flex items-center justify-between">
                  {opt.label}
                  {isSelected && <CheckCircle2Icon className="size-4 shrink-0 text-primary" />}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Always allow free-text fallback if nothing matched */}
      {!loading && options.length > 0 && value && !options.find((o) => o.label === value) && (
        <p className="text-xs text-muted-foreground">
          Using custom value: <span className="font-medium text-foreground">{value}</span>
        </p>
      )}
    </div>
  );
}

// ── Step 1: Identity — role + name ─────────────────────────────────────────

const ROLES: {
  value: OnboardingRole;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
    {
      value: "prospective",
      label: "Prospective Student",
      description: "I'm exploring or applying to a university",
      icon: <BookOpenIcon className="size-5" />,
    },
    {
      value: "student",
      label: "Current Student",
      description: "I'm currently studying at a university",
      icon: <GraduationCapIcon className="size-5" />,
    },
    {
      value: "parent",
      label: "Parent / Guardian",
      description: "I'm supporting a student",
      icon: <UsersIcon className="size-5" />,
    },
    // "staff" is intentionally not self-selectable here. Staff/HOD accounts are
    // provisioned only via an admin-issued invite link (fn_redeem_invite_token),
    // never through self-service onboarding — see app/onboarding/redeem/page.tsx.
  ];

function StepIdentity({
  prefill,
  current,
  onNext,
  saving,
}: {
  prefill?: { firstName?: string; lastName?: string; role?: string };
  current: {
    role?: OnboardingRole;
    firstName?: string;
    lastName?: string;
    phone?: string;
  };
  onNext: (data: Partial<StepData>) => void;
  saving: boolean;
}) {
  const [role, setRole] = useState<OnboardingRole | undefined>(current.role);

  // Resolve first/last name from session data, then prefill, then split the raw OAuth name.
  // prefill.lastName comes from the DB's last_name column (set by the auth trigger).
  // The split is a fallback for legacy rows where the full name landed in first_name.
  const rawName = current.firstName || prefill?.firstName || "";
  const spaceIdx = rawName.indexOf(" ");
  const splitFirst = spaceIdx > -1 ? rawName.slice(0, spaceIdx) : rawName;
  const splitLast = spaceIdx > -1 ? rawName.slice(spaceIdx + 1) : "";

  const [firstName, setFirstName] = useState(splitFirst);
  const [lastName, setLastName] = useState(
    current.lastName || prefill?.lastName || splitLast
  );
  const [phone, setPhone] = useState(current.phone ?? "");

  const canContinue = !!role && firstName.trim().length > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canContinue) return;
    onNext({ role, firstName: firstName.trim(), lastName: lastName.trim(), phone: phone.trim() });
  };

  return (
    <form className="space-y-6" onSubmit={submit}>
      {/* Role selection */}
      <div className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">What describes you best?</h2>
          <p className="text-sm text-muted-foreground">
            We&apos;ll personalise your experience based on your role.
          </p>
        </div>
        <div className="grid gap-2">
          {ROLES.map((r) => (
            <button
              key={r.value}
              type="button"
              onClick={() => setRole(r.value)}
              className={cn(
                "flex items-center gap-3 rounded-lg border p-3 text-left transition-colors",
                role === r.value
                  ? "border-primary bg-primary/5 text-primary"
                  : "hover:bg-muted/50",
              )}
            >
              <span className="shrink-0 text-current">{r.icon}</span>
              <span className="flex-1">
                <span className="block text-sm font-medium">{r.label}</span>
                <span className="block text-xs text-muted-foreground">{r.description}</span>
              </span>
              {role === r.value && <CheckCircle2Icon className="size-4 shrink-0 text-primary" />}
            </button>
          ))}
        </div>
      </div>

      {/* Name + phone — shown once a role is picked */}
      {role && (
        <div className="space-y-3 border-t pt-4">
          <div>
            <h2 className="text-base font-semibold">Your details</h2>
            <p className="text-sm text-muted-foreground">
              This is how you&apos;ll appear across the platform.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="firstName">First name *</Label>
              <Input
                id="firstName"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
                autoComplete="given-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lastName">Last name</Label>
              <Input
                id="lastName"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                autoComplete="family-name"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="phone">
              Phone <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="tel"
              placeholder="+234 800 000 0000"
            />
          </div>
        </div>
      )}

      <Button type="submit" className="w-full" disabled={!canContinue || saving}>
        {saving ? "Saving…" : "Continue"}
      </Button>
    </form>
  );
}

// ── Step 2a: Institution search — prospective & parent ─────────────────────

function StepInstitutionSearch({
  current,
  onNext,
  onBack,
  saving,
}: {
  current?: string;
  onNext: (id: string, name: string) => void;
  onBack: () => void;
  saving: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(current);
  const [selectedName, setSelectedName] = useState("");

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Which institution are you at?</h2>
        <p className="text-sm text-muted-foreground">Search by name.</p>
      </div>
      <InstitutionSearchField
        selectedId={selectedId}
        onSelect={(id, name) => { setSelectedId(id); setSelectedName(name); }}
      />
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onBack}>Back</Button>
        <Button
          className="flex-1"
          disabled={!selectedId || saving}
          onClick={() => selectedId && onNext(selectedId, selectedName)}
        >
          {saving ? "Saving…" : "Continue"}
        </Button>
      </div>
    </div>
  );
}

// ── Step 2b: Student ID verify — student ─────────────────────────────────

type VerifyState = "idle" | "verifying" | "claimed" | "error";

const TRUST_BADGE: Record<number, { label: string; className: string }> = {
  2: { label: "Claimed", className: "bg-warning-bg text-warning border-warning" },
  3: { label: "Portal verified", className: "bg-success-bg text-success border-success" },
  4: { label: "Fully verified", className: "bg-success-bg text-success border-success" },
};

function StepStudentIdVerify({
  current,
  onNext,
  onBack,
  saving,
}: {
  current: { institutionId?: string; studentId?: string; trustLevel?: number };
  onNext: (id: string, name: string, studentId: string, trustLevel: number) => void;
  onBack: () => void;
  saving: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(current.institutionId);
  const [selectedName, setSelectedName] = useState("");
  const [studentId, setStudentId] = useState(current.studentId ?? "");
  const [trustLevel, setTrustLevel] = useState<number>(current.trustLevel ?? 0);
  const [verifyState, setVerifyState] = useState<VerifyState>(
    (current.trustLevel ?? 0) >= 2 ? "claimed" : "idle",
  );
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const canVerify = !!selectedId && studentId.trim().length > 0;
  const canContinue = verifyState === "claimed" && !!selectedId;

  const verify = async () => {
    if (!canVerify || !selectedId) return;
    setVerifyState("verifying");
    setVerifyError(null);
    try {
      const res = await fetch("/api/verify-student", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matricNumber: studentId.trim(), institutionId: selectedId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setVerifyError(json.error ?? "Verification failed.");
        setVerifyState("error");
        return;
      }
      setTrustLevel(json.trustLevel);
      setVerifyState("claimed");
    } catch {
      setVerifyError("Network error — please try again.");
      setVerifyState("error");
    }
  };

  const badge = trustLevel >= 2 ? (TRUST_BADGE[trustLevel] ?? TRUST_BADGE[2]) : null;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Verify your student status</h2>
        <p className="text-sm text-muted-foreground">
          Select your institution and enter your matric number.
        </p>
      </div>

      <InstitutionSearchField
        selectedId={selectedId}
        onSelect={(id, name) => {
          if (id !== selectedId) {
            setVerifyState("idle");
            setTrustLevel(0);
            setVerifyError(null);
          }
          setSelectedId(id);
          setSelectedName(name);
        }}
      />

      <div className="space-y-1.5">
        <Label htmlFor="studentId">Matric number *</Label>
        <div className="flex gap-2">
          <Input
            id="studentId"
            value={studentId}
            onChange={(e) => {
              setStudentId(e.target.value);
              setVerifyState("idle");
              setTrustLevel(0);
              setVerifyError(null);
            }}
            placeholder="e.g. 19/ENG/EEE/001 or PG/PSC201254"
            className="flex-1"
          />
          <Button
            type="button"
            variant="outline"
            disabled={!canVerify || verifyState === "verifying"}
            onClick={verify}
            className="shrink-0"
          >
            {verifyState === "verifying" ? "Checking…" : "Verify"}
          </Button>
        </div>

        {badge && verifyState === "claimed" && (
          <p className={cn(
            "inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium",
            badge.className,
          )}>
            <CheckCircle2Icon className="size-3" />
            {badge.label}
          </p>
        )}
        {verifyError && (
          <p className="text-xs text-destructive">{verifyError}</p>
        )}
        {verifyState === "idle" && canVerify && (
          <p className="text-xs text-muted-foreground">
            Click Verify to record your matric number.
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onBack}>Back</Button>
        <Button
          className="flex-1"
          disabled={!canContinue || saving}
          onClick={() => selectedId && onNext(selectedId, selectedName, studentId.trim(), trustLevel)}
        >
          {saving ? "Saving…" : "Continue"}
        </Button>
      </div>
    </div>
  );
}

// ── Step 2c: Institution verify — staff ───────────────────────────────────

function StepInstitutionVerify({
  current,
  onNext,
  onBack,
  saving,
}: {
  current?: string;
  onNext: (id: string, name: string) => void;
  onBack: () => void;
  saving: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(current);
  const [selectedName, setSelectedName] = useState("");

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Which institution do you work at?</h2>
        <p className="text-sm text-muted-foreground">Search by name.</p>
      </div>
      <InstitutionSearchField
        selectedId={selectedId}
        onSelect={(id, name) => { setSelectedId(id); setSelectedName(name); }}
      />
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onBack}>Back</Button>
        <Button
          className="flex-1"
          disabled={!selectedId || saving}
          onClick={() => selectedId && onNext(selectedId, selectedName)}
        >
          {saving ? "Saving…" : "Continue"}
        </Button>
      </div>
    </div>
  );
}

// ── Step 3a: Programme interest — prospective ─────────────────────────────

function StepProgrammeInterest({
  institutionId,
  current,
  onNext,
  onBack,
  saving,
}: {
  institutionId?: string;
  current?: string;
  onNext: (programme: string) => void;
  onBack: () => void;
  saving: boolean;
}) {
  const supabase = createSupabaseBrowserClient();
  const [options, setOptions] = useState<ListOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const [freeText, setFreeText] = useState("");

  useEffect(() => {
    if (!institutionId) return;
    setLoading(true);
    supabase
      .from("programs")
      .select("id, name, code")
      .eq("institution_id", institutionId)
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => {
        setOptions((data ?? []).map((p) => ({ id: p.id, label: `${p.name} (${p.code})` })));
        setLoading(false);
      });
  }, [institutionId, supabase]);

  // Effective value: list selection takes priority, free-text is fallback
  const effectiveValue = value || freeText.trim();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onNext(effectiveValue || "Not specified");
  };

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div>
        <h2 className="text-base font-semibold">What programme interests you?</h2>
        <p className="text-sm text-muted-foreground">
          This helps the AI tailor admission information to you.
        </p>
      </div>

      {institutionId ? (
        <>
          <SearchableList
            options={options}
            loading={loading}
            value={value}
            onChange={(v) => { setValue(v); setFreeText(""); }}
            placeholder="Filter programmes…"
            emptyText="No programmes found. Type below to enter manually."
          />
          {/* Free-text fallback if not in list or institution has no programmes */}
          {(!loading && (options.length === 0 || !value)) && (
            <div className="space-y-1.5">
              <Label htmlFor="progFreeText">
                Or type your programme{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="progFreeText"
                value={freeText}
                onChange={(e) => { setFreeText(e.target.value); setValue(""); }}
                placeholder="e.g. Computer Science, Medicine, Law…"
              />
            </div>
          )}
        </>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="programme">Programme of interest</Label>
          <Input
            id="programme"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="e.g. Computer Science, Medicine, Law…"
          />
        </div>
      )}

      <div className="flex gap-2">
        <Button type="button" variant="outline" className="flex-1" onClick={onBack}>Back</Button>
        <Button type="submit" className="flex-1" disabled={saving}>
          {saving ? "Saving…" : "Continue"}
        </Button>
      </div>
    </form>
  );
}

// ── Step 3b: Programme confirm — student ─────────────────────────────────

function StepProgrammeConfirm({
  institutionId,
  current,
  currentLevel,
  onNext,
  onBack,
  saving,
}: {
  institutionId?: string;
  current?: string;
  currentLevel?: string;
  onNext: (programme: string, level: string) => void;
  onBack: () => void;
  saving: boolean;
}) {
  const supabase = createSupabaseBrowserClient();
  const [options, setOptions] = useState<ListOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const [freeText, setFreeText] = useState("");
  const [level, setLevel] = useState(currentLevel ?? "");

  useEffect(() => {
    if (!institutionId) return;
    setLoading(true);
    supabase
      .from("programs")
      .select("id, name, code")
      .eq("institution_id", institutionId)
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => {
        setOptions((data ?? []).map((p) => ({ id: p.id, label: `${p.name} (${p.code})` })));
        setLoading(false);
      });
  }, [institutionId, supabase]);

  const effectiveProgramme = value || freeText.trim();
  const canContinue = !!effectiveProgramme && !!level;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canContinue) return;
    onNext(effectiveProgramme, level);
  };

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div>
        <h2 className="text-base font-semibold">Your programme &amp; level</h2>
        <p className="text-sm text-muted-foreground">
          The AI uses these to give you year- and programme-specific answers.
        </p>
      </div>

      {/* Programme picker */}
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Programme *</Label>
        {institutionId ? (
          <>
            <SearchableList
              options={options}
              loading={loading}
              value={value}
              onChange={(v) => { setValue(v); setFreeText(""); }}
              placeholder="Filter programmes…"
              emptyText="No programmes found. Type below to enter manually."
            />
            {(!loading && (options.length === 0 || !value)) && (
              <Input
                value={freeText}
                onChange={(e) => { setFreeText(e.target.value); setValue(""); }}
                placeholder="e.g. B.Sc. Computer Science"
              />
            )}
          </>
        ) : (
          <Input
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="e.g. B.Sc. Computer Science"
            required
          />
        )}
      </div>

      {/* Level picker */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Current level *</Label>
        <div className="grid grid-cols-4 gap-2">
          {LEVEL_OPTIONS.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLevel(l)}
              className={cn(
                "rounded-lg border px-2 py-2 text-sm transition-colors",
                level === l
                  ? "border-primary bg-primary/5 font-medium text-primary"
                  : "hover:bg-muted/50",
              )}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <Button type="button" variant="outline" className="flex-1" onClick={onBack}>Back</Button>
        <Button type="submit" className="flex-1" disabled={!canContinue || saving}>
          {saving ? "Saving…" : "Continue"}
        </Button>
      </div>
    </form>
  );
}

// ── Step 3c: Ward link — parent ────────────────────────────────────────────

type WardRelationship = "parent" | "guardian" | "sponsor";

const RELATIONSHIP_OPTIONS: { value: WardRelationship; label: string }[] = [
  { value: "parent", label: "Parent" },
  { value: "guardian", label: "Guardian" },
  { value: "sponsor", label: "Sponsor" },
];

function StepWardLink({
  current,
  onNext,
  onBack,
  saving,
}: {
  current?: { wardStudentId?: string; wardRelationship?: WardRelationship };
  onNext: (wardStudentId: string, wardRelationship: WardRelationship) => void;
  onBack: () => void;
  saving: boolean;
}) {
  const [matric, setMatric] = useState(current?.wardStudentId ?? "");
  const [relationship, setRelationship] = useState<WardRelationship>(current?.wardRelationship ?? "parent");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onNext(matric.trim(), relationship);
  };

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div>
        <h2 className="text-base font-semibold">Link to your ward</h2>
        <p className="text-sm text-muted-foreground">
          Enter your ward&apos;s matric number. You can correct it later if needed.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>Your relationship</Label>
        <div className="grid grid-cols-3 gap-2">
          {RELATIONSHIP_OPTIONS.map((r) => (
            <button
              key={r.value}
              type="button"
              onClick={() => setRelationship(r.value)}
              className={cn(
                "rounded-lg border px-3 py-2 text-sm transition-colors",
                relationship === r.value
                  ? "border-primary bg-primary/5 font-medium text-primary"
                  : "hover:bg-muted/50",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wardId">
          Ward&apos;s matric number{" "}
          <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="wardId"
          value={matric}
          onChange={(e) => setMatric(e.target.value)}
          placeholder="e.g. 23/ENG/EEE/001 or PG/PSC201254"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          If you don&apos;t have it now, skip — you can add it from your profile later.
        </p>
      </div>

      <div className="flex gap-2">
        <Button type="button" variant="outline" className="flex-1" onClick={onBack}>Back</Button>
        <Button type="submit" className="flex-1" disabled={saving}>
          {saving ? "Saving…" : "Continue"}
        </Button>
      </div>
    </form>
  );
}

// ── Step 3d: Department + staff title — staff ──────────────────────────────

const STAFF_TITLE_OPTIONS = [
  "Lecturer", "Senior Lecturer", "Associate Professor", "Professor",
  "HOD", "Dean", "Admin Staff", "Lab Technician", "Other",
];

function StepDepartment({
  institutionId,
  current,
  currentTitle,
  onNext,
  onBack,
  saving,
}: {
  institutionId?: string;
  current?: string;
  currentTitle?: string;
  onNext: (department: string, staffTitle: string) => void;
  onBack: () => void;
  saving: boolean;
}) {
  const supabase = createSupabaseBrowserClient();
  const [options, setOptions] = useState<ListOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const [freeText, setFreeText] = useState("");
  const [staffTitle, setStaffTitle] = useState(currentTitle ?? "");

  useEffect(() => {
    if (!institutionId) return;
    setLoading(true);
    supabase
      .from("departments")
      .select("id, name, code")
      .eq("institution_id", institutionId)
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => {
        setOptions((data ?? []).map((d) => ({ id: d.id, label: `${d.name} (${d.code})` })));
        setLoading(false);
      });
  }, [institutionId, supabase]);

  const effectiveDept = value || freeText.trim();
  const canContinue = !!effectiveDept && !!staffTitle;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canContinue) return;
    onNext(effectiveDept, staffTitle);
  };

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div>
        <h2 className="text-base font-semibold">Your department &amp; role</h2>
        <p className="text-sm text-muted-foreground">
          Helps the AI scope answers to your department and position.
        </p>
      </div>

      {/* Department picker */}
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Department *</Label>
        {institutionId ? (
          <>
            <SearchableList
              options={options}
              loading={loading}
              value={value}
              onChange={(v) => { setValue(v); setFreeText(""); }}
              placeholder="Filter departments…"
              emptyText="No departments found. Type below to enter manually."
            />
            {(!loading && (options.length === 0 || !value)) && (
              <Input
                value={freeText}
                onChange={(e) => { setFreeText(e.target.value); setValue(""); }}
                placeholder="e.g. Computer Science, Mechanical Engineering…"
              />
            )}
          </>
        ) : (
          <Input
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="e.g. Computer Science, Mechanical Engineering…"
            required
          />
        )}
      </div>

      {/* Staff title picker */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Your role *</Label>
        <div className="grid grid-cols-3 gap-2">
          {STAFF_TITLE_OPTIONS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setStaffTitle(t)}
              className={cn(
                "rounded-lg border px-2 py-2 text-sm transition-colors",
                staffTitle === t
                  ? "border-primary bg-primary/5 font-medium text-primary"
                  : "hover:bg-muted/50",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <Button type="button" variant="outline" className="flex-1" onClick={onBack}>Back</Button>
        <Button type="submit" className="flex-1" disabled={!canContinue || saving}>
          {saving ? "Saving…" : "Continue"}
        </Button>
      </div>
    </form>
  );
}

// ── Step 4: Preferences + review — all journeys ────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  prospective: "Prospective Student",
  student: "Current Student",
  parent: "Parent / Guardian",
  guardian: "Parent / Guardian",
  staff: "Staff / Faculty",
};

function StepPreferences({
  data,
  onComplete,
  onBack,
  saving,
}: {
  data: StepData;
  onComplete: (verbosity: "concise" | "detailed") => void;
  onBack: () => void;
  saving: boolean;
}) {
  const [verbosity, setVerbosity] = useState<"concise" | "detailed">(
    data.verbosity ?? "concise",
  );

  const roleLabel = data.role ? (ROLE_LABELS[data.role] ?? data.role) : "—";
  const programme = data.programmeInterest ?? data.programmeName ?? null;

  const summary = [
    { label: "Role", value: roleLabel },
    { label: "Institution", value: data.institutionName ?? "—" },
    programme ? { label: "Programme", value: programme } : null,
    data.level ? { label: "Level", value: data.level } : null,
    data.department ? { label: "Department", value: data.department } : null,
    data.staffTitle ? { label: "Staff role", value: data.staffTitle } : null,
    data.studentId ? { label: "Student ID", value: data.studentId } : null,
    { label: "Name", value: [data.firstName, data.lastName].filter(Boolean).join(" ") || "—" },
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Almost there!</h2>
        <p className="text-sm text-muted-foreground">
          Set your AI preference, then review and confirm.
        </p>
      </div>

      {/* Verbosity preference */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">AI response style</Label>
        <div className="grid grid-cols-2 gap-2">
          {(["concise", "detailed"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setVerbosity(v)}
              className={cn(
                "rounded-lg border px-4 py-2.5 text-sm transition-colors capitalize",
                verbosity === v
                  ? "border-primary bg-primary/5 font-medium text-primary"
                  : "hover:bg-muted/50",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {verbosity === "concise"
            ? "Short, direct answers — best for quick lookups."
            : "Thorough explanations — best when you need full context."}
        </p>
      </div>

      {/* Summary review */}
      <dl className="divide-y rounded-lg border text-sm">
        {summary.map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between px-4 py-2.5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="flex gap-2">
        <Button type="button" variant="outline" className="flex-1" onClick={onBack}>
          Back
        </Button>
        <Button
          className="flex-1"
          disabled={saving}
          onClick={() => onComplete(verbosity)}
        >
          {saving ? "Setting up…" : "Get started"}
        </Button>
      </div>
    </div>
  );
}
