"use client";

// components/user/settings-shell.tsx

import { useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  ArrowLeftIcon,
  UserRoundIcon,
  GraduationCapIcon,
  SparklesIcon,
  BriefcaseIcon,
  BookOpenIcon,
  CheckIcon,
  CheckCircle2Icon,
  Loader2Icon,
} from "lucide-react";
import type { SettingsInitial } from "@/components/user/settings-form";
import { LEVEL_OPTIONS } from "@/lib/constants/academic";

const STAFF_TITLE_OPTIONS = [
  "Lecturer", "Senior Lecturer", "Associate Professor", "Professor",
  "HOD", "Dean", "Admin Staff", "Lab Technician", "Other",
];

type SectionId = "profile" | "context" | "ai";
type NavItem   = { id: SectionId; label: string; Icon: ComponentType<{ className?: string }> };

// ── Field wrapper — ensures label always stacks above input ──────────────────
function Field({ label, optional, children }: { label: string; optional?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium leading-none text-foreground">
        {label}
        {optional && <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
      </span>
      {children}
    </div>
  );
}

export function SettingsShell({ initial }: { initial: SettingsInitial }) {
  const router = useRouter();

  const [firstName,  setFirstName]  = useState(initial.firstName);
  const [lastName,   setLastName]   = useState(initial.lastName);
  const [phone,      setPhone]      = useState(initial.phone);
  const [programme,  setProgramme]  = useState(initial.programme);
  const [level,      setLevel]      = useState(initial.level);
  const [department, setDepartment] = useState(initial.department);
  const [staffTitle, setStaffTitle] = useState(initial.staffTitle);
  const [verbosity,  setVerbosity]  = useState<"concise" | "detailed">(initial.verbosity);
  const [progFilter, setProgFilter] = useState("");
  const [deptFilter, setDeptFilter] = useState("");

  const [activeSection, setActiveSection] = useState<SectionId>("profile");
  const [saving,  setSaving]  = useState(false);
  const [success, setSuccess] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const isDirty =
    firstName  !== initial.firstName  ||
    lastName   !== initial.lastName   ||
    phone      !== initial.phone      ||
    programme  !== initial.programme  ||
    level      !== initial.level      ||
    department !== initial.department ||
    staffTitle !== initial.staffTitle ||
    verbosity  !== initial.verbosity;

  const contextItem = (): NavItem | null => {
    if (initial.primaryRole === "student")
      return { id: "context", label: "Academic context",   Icon: GraduationCapIcon };
    if (initial.primaryRole === "staff")
      return { id: "context", label: "Staff context",      Icon: BriefcaseIcon };
    if (["prospective", "parent", "guardian"].includes(initial.primaryRole))
      return { id: "context", label: "Programme interest", Icon: BookOpenIcon };
    return null;
  };

  const navItems: NavItem[] = [
    { id: "profile", label: "Profile",        Icon: UserRoundIcon },
    ...(contextItem() ? [contextItem()!] : []),
    { id: "ai",      label: "AI preferences", Icon: SparklesIcon  },
  ];

  const filteredProgrammes  = progFilter.trim()
    ? initial.programmes.filter((p) => `${p.name} ${p.code}`.toLowerCase().includes(progFilter.toLowerCase()))
    : initial.programmes;

  const filteredDepartments = deptFilter.trim()
    ? initial.departments.filter((d) => `${d.name} ${d.code}`.toLowerCase().includes(deptFilter.toLowerCase()))
    : initial.departments;

  const handleSave = async () => {
    if (!isDirty) return;
    setSaving(true); setSuccess(false); setError(null);

    const res  = await fetch("/api/profile", {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        firstName:  firstName.trim()  || undefined,
        lastName:   lastName.trim()   || undefined,
        phone:      phone.trim()      || undefined,
        programme:  programme.trim()  || undefined,
        level:      level             || undefined,
        department: department.trim() || undefined,
        staffTitle: staffTitle        || undefined,
        verbosity,
      }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { setError(json.error ?? "Something went wrong."); }
    else         { setSuccess(true); setTimeout(() => setSuccess(false), 3000); }
  };

  const sectionMeta: Record<SectionId, { title: string; description: string }> = {
    profile: {
      title: "Profile",
      description: "Your display name and contact details across the platform.",
    },
    context: {
      title: contextItem()?.label ?? "Context",
      description:
        initial.primaryRole === "student"  ? "Used by the AI to give you year- and programme-specific answers."
        : initial.primaryRole === "staff"  ? "Helps the AI scope answers to your department and position."
        : "Helps the AI focus on relevant admission information.",
    },
    ai: {
      title: "AI preferences",
      description: "Control how Episteme responds to your questions.",
    },
  };

  const meta = sectionMeta[activeSection];

  return (
    <div className="flex h-dvh flex-col bg-background">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur-sm">
        <button
          type="button"
          onClick={() => router.back()}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          <span className="hidden sm:inline">Back</span>
        </button>
        <Separator orientation="vertical" className="h-4" />
        <span className="text-sm font-semibold tracking-tight">Settings</span>
      </header>

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Desktop sidebar */}
        <aside className="hidden md:flex w-52 shrink-0 flex-col border-r py-5 px-3 bg-sidebar">
          <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
            Settings
          </p>
          {navItems.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveSection(id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors text-left",
                activeSection === id
                  ? "bg-sidebar-accent text-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <Icon className={cn("size-4 shrink-0", activeSection === id ? "text-primary" : "")} />
              {label}
            </button>
          ))}
        </aside>

        {/* Mobile tab strip */}
        <div className="md:hidden absolute top-12 left-0 right-0 z-10 flex overflow-x-auto border-b bg-background scrollbar-none">
          {navItems.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveSection(id)}
              className={cn(
                "flex shrink-0 items-center gap-2 border-b-2 px-5 py-3 text-sm font-medium whitespace-nowrap transition-colors",
                activeSection === id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </div>

        {/* Content + save bar */}
        <div className="flex flex-1 flex-col overflow-hidden md:pt-0 pt-[49px]">

          {/* Scrollable form area */}
          <div className="flex-1 overflow-y-auto">
            <div className="px-6 py-8 sm:px-10 lg:px-16 max-w-2xl">

              {/* Section heading */}
              <div className="mb-8">
                <h1 className="font-serif text-xl font-semibold tracking-tight">{meta.title}</h1>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{meta.description}</p>
              </div>

              {/* ── Profile ── */}
              {activeSection === "profile" && (
                <div className="space-y-5">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="First name">
                      <Input id="firstName" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" />
                    </Field>
                    <Field label="Last name">
                      <Input id="lastName" value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
                    </Field>
                  </div>
                  <Field label="Phone" optional>
                    <Input
                      id="phone"
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      autoComplete="tel"
                      placeholder="+234 800 000 0000"
                      className="max-w-xs"
                    />
                  </Field>
                </div>
              )}

              {/* ── Context ── */}
              {activeSection === "context" && (
                <div className="space-y-6">

                  {/* Student */}
                  {initial.primaryRole === "student" && (
                    <>
                      <Field label="Programme">
                        {initial.programmes.length > 0 ? (
                          <div className="space-y-2">
                            {initial.programmes.length > 6 && (
                              <Input
                                placeholder="Filter programmes…"
                                value={progFilter}
                                onChange={(e) => setProgFilter(e.target.value)}
                              />
                            )}
                            <div className="max-h-56 overflow-y-auto rounded-lg border bg-background divide-y divide-border/40">
                              {filteredProgrammes.map((p) => {
                                const lbl = `${p.name} (${p.code})`;
                                const sel = programme === lbl;
                                return (
                                  <button
                                    key={p.id}
                                    type="button"
                                    onClick={() => setProgramme(sel ? "" : lbl)}
                                    className={cn(
                                      "flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition-colors",
                                      "hover:bg-muted/50 first:rounded-t-lg last:rounded-b-lg",
                                      sel && "bg-primary/5 font-medium text-primary",
                                    )}
                                  >
                                    {lbl}
                                    {sel && <CheckIcon className="size-4 shrink-0 text-primary" />}
                                  </button>
                                );
                              })}
                            </div>
                            {!programme && (
                              <Input value={programme} onChange={(e) => setProgramme(e.target.value)} placeholder="Or type your programme…" />
                            )}
                          </div>
                        ) : (
                          <Input value={programme} onChange={(e) => setProgramme(e.target.value)} placeholder="e.g. B.Sc. Computer Science" />
                        )}
                      </Field>

                      <Field label="Current level">
                        <div className="flex flex-wrap gap-2 pt-0.5">
                          {LEVEL_OPTIONS.map((l) => (
                            <button
                              key={l}
                              type="button"
                              onClick={() => setLevel(level === l ? "" : l)}
                              className={cn(
                                "rounded-full border px-4 py-1.5 text-sm transition-colors",
                                level === l
                                  ? "border-primary/50 bg-primary/10 font-medium text-primary"
                                  : "border-border hover:bg-muted/50",
                              )}
                            >
                              {l}
                            </button>
                          ))}
                        </div>
                      </Field>
                    </>
                  )}

                  {/* Staff */}
                  {initial.primaryRole === "staff" && (
                    <>
                      <Field label="Department">
                        {initial.departments.length > 0 ? (
                          <div className="space-y-2">
                            {initial.departments.length > 6 && (
                              <Input
                                placeholder="Filter departments…"
                                value={deptFilter}
                                onChange={(e) => setDeptFilter(e.target.value)}
                              />
                            )}
                            <div className="max-h-56 overflow-y-auto rounded-lg border bg-background divide-y divide-border/40">
                              {filteredDepartments.map((d) => {
                                const lbl = `${d.name} (${d.code})`;
                                const sel = department === lbl;
                                return (
                                  <button
                                    key={d.id}
                                    type="button"
                                    onClick={() => setDepartment(sel ? "" : lbl)}
                                    className={cn(
                                      "flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition-colors",
                                      "hover:bg-muted/50 first:rounded-t-lg last:rounded-b-lg",
                                      sel && "bg-primary/5 font-medium text-primary",
                                    )}
                                  >
                                    {lbl}
                                    {sel && <CheckIcon className="size-4 shrink-0 text-primary" />}
                                  </button>
                                );
                              })}
                            </div>
                            {!department && (
                              <Input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Or type your department…" />
                            )}
                          </div>
                        ) : (
                          <Input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="e.g. Computer Science" />
                        )}
                      </Field>

                      <Field label="Role / title">
                        <div className="flex flex-wrap gap-2 pt-0.5">
                          {STAFF_TITLE_OPTIONS.map((t) => (
                            <button
                              key={t}
                              type="button"
                              onClick={() => setStaffTitle(staffTitle === t ? "" : t)}
                              className={cn(
                                "rounded-full border px-4 py-1.5 text-sm transition-colors",
                                staffTitle === t
                                  ? "border-primary/50 bg-primary/10 font-medium text-primary"
                                  : "border-border hover:bg-muted/50",
                              )}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </Field>
                    </>
                  )}

                  {/* Prospective / parent */}
                  {["prospective", "parent", "guardian"].includes(initial.primaryRole) && (
                    <Field label="Programme of interest">
                      <Input
                        value={programme}
                        onChange={(e) => setProgramme(e.target.value)}
                        placeholder="e.g. Computer Science, Medicine…"
                      />
                    </Field>
                  )}
                </div>
              )}

              {/* ── AI preferences ── */}
              {activeSection === "ai" && (
                <div className="space-y-3">
                  {(["concise", "detailed"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setVerbosity(v)}
                      className={cn(
                        "flex w-full items-start gap-4 rounded-xl border px-5 py-4 text-left transition-colors",
                        verbosity === v ? "border-primary/40 bg-primary/5" : "border-border hover:bg-muted/40",
                      )}
                    >
                      <span className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                        verbosity === v ? "border-primary bg-primary" : "border-muted-foreground/40",
                      )}>
                        {verbosity === v && <span className="size-1.5 rounded-full bg-white" />}
                      </span>
                      <span>
                        <span className={cn("block text-sm font-semibold capitalize", verbosity === v ? "text-primary" : "")}>
                          {v}
                        </span>
                        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                          {v === "concise"
                            ? "Short, direct answers — best for quick lookups."
                            : "Thorough explanations — best when you need full context."}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}

            </div>
          </div>

          {/* ── Save bar ── */}
          <div className="shrink-0 border-t bg-background/80 backdrop-blur-sm">
            <div className="flex items-center justify-between gap-4 px-6 py-3 sm:px-10 lg:px-16 max-w-2xl">
              <div className="text-sm min-h-[1.25rem]">
                {error        && <span className="text-destructive">{error}</span>}
                {!error && success && (
                  <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2Icon className="size-4" /> Changes saved
                  </span>
                )}
                {!error && !success && isDirty && (
                  <span className="text-muted-foreground text-[13px]">You have unsaved changes.</span>
                )}
              </div>
              <Button onClick={handleSave} disabled={saving || !isDirty} className="min-w-[120px] shrink-0">
                {saving ? <><Loader2Icon className="mr-2 size-4 animate-spin" />Saving…</> : "Save changes"}
              </Button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
