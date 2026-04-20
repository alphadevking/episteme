"use client";

// components/user/settings-shell.tsx
// Full settings page: thread sidebar + settings nav + section panels.

import { useState, type ComponentType } from "react";
import Link from "next/link";
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
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

// ── Constants ────────────────────────────────────────────────────────────────

const STAFF_TITLE_OPTIONS = [
  "Lecturer", "Senior Lecturer", "Associate Professor", "Professor",
  "HOD", "Dean", "Admin Staff", "Lab Technician", "Other",
];

// ── Nav types ─────────────────────────────────────────────────────────────────

type SectionId = "profile" | "context" | "ai";

type NavItem = {
  id: SectionId;
  label: string;
  Icon: ComponentType<{ className?: string }>;
};

// ── Shell ─────────────────────────────────────────────────────────────────────

export function SettingsShell({ initial }: { initial: SettingsInitial }) {
  // ── Form state ──────────────────────────────────────────────────────────
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [phone, setPhone] = useState(initial.phone);
  const [programme, setProgramme] = useState(initial.programme);
  const [level, setLevel] = useState(initial.level);
  const [department, setDepartment] = useState(initial.department);
  const [staffTitle, setStaffTitle] = useState(initial.staffTitle);
  const [verbosity, setVerbosity] = useState<"concise" | "detailed">(initial.verbosity);
  const [progFilter, setProgFilter] = useState("");
  const [deptFilter, setDeptFilter] = useState("");

  // ── UI state ────────────────────────────────────────────────────────────
  const [activeSection, setActiveSection] = useState<SectionId>("profile");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Dirty check: only enable save when something actually changed ────────
  const isDirty =
    firstName !== initial.firstName ||
    lastName !== initial.lastName ||
    phone !== initial.phone ||
    programme !== initial.programme ||
    level !== initial.level ||
    department !== initial.department ||
    staffTitle !== initial.staffTitle ||
    verbosity !== initial.verbosity;

  // ── Nav items (context section is role-dependent) ────────────────────────
  const contextItem = (): NavItem | null => {
    if (initial.primaryRole === "student")
      return { id: "context", label: "Academic context", Icon: GraduationCapIcon };
    if (initial.primaryRole === "staff")
      return { id: "context", label: "Staff context", Icon: BriefcaseIcon };
    if (["prospective", "parent", "guardian"].includes(initial.primaryRole))
      return { id: "context", label: "Programme interest", Icon: BookOpenIcon };
    return null;
  };

  const navItems: NavItem[] = [
    { id: "profile", label: "Profile", Icon: UserRoundIcon },
    ...(contextItem() ? [contextItem()!] : []),
    { id: "ai", label: "AI preferences", Icon: SparklesIcon },
  ];

  // ── Filtered lists ───────────────────────────────────────────────────────
  const filteredProgrammes = progFilter.trim()
    ? initial.programmes.filter((p) =>
      `${p.name} ${p.code}`.toLowerCase().includes(progFilter.toLowerCase()))
    : initial.programmes;

  const filteredDepartments = deptFilter.trim()
    ? initial.departments.filter((d) =>
      `${d.name} ${d.code}`.toLowerCase().includes(deptFilter.toLowerCase()))
    : initial.departments;

  // ── Save ─────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!isDirty) return;
    setSaving(true);
    setSuccess(false);
    setError(null);

    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        phone: phone.trim() || undefined,
        programme: programme.trim() || undefined,
        level: level || undefined,
        department: department.trim() || undefined,
        staffTitle: staffTitle || undefined,
        verbosity,
      }),
    });

    const json = await res.json();
    setSaving(false);

    if (!res.ok) {
      setError(json.error ?? "Something went wrong.");
    } else {
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    }
  };

  // ── Section meta ─────────────────────────────────────────────────────────
  const sectionMeta: Record<SectionId, { title: string; description: string }> = {
    profile: {
      title: "Profile",
      description: "Your display name and contact details across the platform.",
    },
    context: {
      title: contextItem()?.label ?? "Context",
      description:
        initial.primaryRole === "student"
          ? "Used by the AI to give you year- and programme-specific answers."
          : initial.primaryRole === "staff"
            ? "Helps the AI scope answers to your department and position."
            : "Helps the AI focus on relevant admission information.",
    },
    ai: {
      title: "AI preferences",
      description: "Control how Episteme responds to your questions.",
    },
  };

  const meta = sectionMeta[activeSection];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <SidebarProvider>
      <div className="flex h-dvh w-full pr-0.5">
        <ThreadListSidebar />

        <SidebarInset>
          {/* ── Top bar ── */}
          <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/30 px-4 backdrop-blur-sm">
            <SidebarTrigger className="-ml-1 size-8" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link
                      href="/chat"
                      className="font-medium tracking-tight text-muted-foreground transition-colors hover:text-foreground"
                    >
                      Episteme Chat
                    </Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="font-medium tracking-tight text-foreground/80">
                    Settings
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </header>

          {/* ── Body ── */}
          <div className="flex flex-1 overflow-hidden">

            {/* ── Settings nav ── */}
            <nav className="w-[200px] shrink-0 overflow-y-auto border-r py-4 px-2">
              <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                Settings
              </p>
              {navItems.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveSection(id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                    activeSection === id
                      ? "bg-sidebar-accent text-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                  )}
                >
                  <Icon className={cn(
                    "size-4 shrink-0 transition-colors",
                    activeSection === id ? "text-primary" : "",
                  )} />
                  {label}
                </button>
              ))}
            </nav>

            {/* ── Section content + save bar ── */}
            <div className="flex flex-1 flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto">
                <div className="mx-auto max-w-xl px-8 py-8">

                  {/* Section heading */}
                  <div className="mb-7">
                    <h1 className="font-serif font-semibold text-xl tracking-tight">
                      {meta.title}
                    </h1>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      {meta.description}
                    </p>
                  </div>

                  {/* ── Profile ── */}
                  {activeSection === "profile" && (
                    <div className="space-y-5">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label htmlFor="firstName" className="text-[13px]">
                            First name
                          </Label>
                          <Input
                            id="firstName"
                            value={firstName}
                            onChange={(e) => setFirstName(e.target.value)}
                            autoComplete="given-name"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="lastName" className="text-[13px]">
                            Last name
                          </Label>
                          <Input
                            id="lastName"
                            value={lastName}
                            onChange={(e) => setLastName(e.target.value)}
                            autoComplete="family-name"
                          />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="phone" className="text-[13px]">
                          Phone{" "}
                          <span className="font-normal text-muted-foreground">
                            (optional)
                          </span>
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

                  {/* ── Context ── */}
                  {activeSection === "context" && (
                    <div className="space-y-6">

                      {/* Student: programme + level */}
                      {initial.primaryRole === "student" && (
                        <>
                          {initial.programmes.length > 0 ? (
                            <div className="space-y-1.5">
                              <Label className="text-[13px]">Programme</Label>
                              {initial.programmes.length > 6 && (
                                <Input
                                  placeholder="Filter programmes…"
                                  value={progFilter}
                                  onChange={(e) => setProgFilter(e.target.value)}
                                  className="mb-2"
                                />
                              )}
                              <div className="max-h-52 overflow-y-auto rounded-lg border bg-background">
                                {filteredProgrammes.map((p) => {
                                  const label = `${p.name} (${p.code})`;
                                  const selected = programme === label;
                                  return (
                                    <button
                                      key={p.id}
                                      type="button"
                                      onClick={() => setProgramme(selected ? "" : label)}
                                      className={cn(
                                        "flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px] transition-colors",
                                        "hover:bg-muted/50 first:rounded-t-lg last:rounded-b-lg",
                                        selected && "bg-primary/5 text-primary",
                                      )}
                                    >
                                      {label}
                                      {selected && (
                                        <CheckIcon className="size-3.5 shrink-0 text-primary" />
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                              {!programme && (
                                <Input
                                  value={programme}
                                  onChange={(e) => setProgramme(e.target.value)}
                                  placeholder="Or type your programme…"
                                  className="mt-2"
                                />
                              )}
                            </div>
                          ) : (
                            <div className="space-y-1.5">
                              <Label htmlFor="progFreeText" className="text-[13px]">
                                Programme
                              </Label>
                              <Input
                                id="progFreeText"
                                value={programme}
                                onChange={(e) => setProgramme(e.target.value)}
                                placeholder="e.g. B.Sc. Computer Science"
                              />
                            </div>
                          )}

                          <div className="space-y-2">
                            <Label className="text-[13px]">Current level</Label>
                            <div className="flex flex-wrap gap-2">
                              {LEVEL_OPTIONS.map((l) => (
                                <button
                                  key={l}
                                  type="button"
                                  onClick={() => setLevel(level === l ? "" : l)}
                                  className={cn(
                                    "rounded-full border px-3.5 py-1.5 text-[13px] transition-colors",
                                    level === l
                                      ? "border-primary/50 bg-primary/10 font-medium text-primary"
                                      : "border-border hover:bg-muted/50",
                                  )}
                                >
                                  {l}
                                </button>
                              ))}
                            </div>
                          </div>
                        </>
                      )}

                      {/* Staff: department + title */}
                      {initial.primaryRole === "staff" && (
                        <>
                          {initial.departments.length > 0 ? (
                            <div className="space-y-1.5">
                              <Label className="text-[13px]">Department</Label>
                              {initial.departments.length > 6 && (
                                <Input
                                  placeholder="Filter departments…"
                                  value={deptFilter}
                                  onChange={(e) => setDeptFilter(e.target.value)}
                                  className="mb-2"
                                />
                              )}
                              <div className="max-h-52 overflow-y-auto rounded-lg border bg-background">
                                {filteredDepartments.map((d) => {
                                  const label = `${d.name} (${d.code})`;
                                  const selected = department === label;
                                  return (
                                    <button
                                      key={d.id}
                                      type="button"
                                      onClick={() => setDepartment(selected ? "" : label)}
                                      className={cn(
                                        "flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px] transition-colors",
                                        "hover:bg-muted/50 first:rounded-t-lg last:rounded-b-lg",
                                        selected && "bg-primary/5 text-primary",
                                      )}
                                    >
                                      {label}
                                      {selected && (
                                        <CheckIcon className="size-3.5 shrink-0 text-primary" />
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                              {!department && (
                                <Input
                                  value={department}
                                  onChange={(e) => setDepartment(e.target.value)}
                                  placeholder="Or type your department…"
                                  className="mt-2"
                                />
                              )}
                            </div>
                          ) : (
                            <div className="space-y-1.5">
                              <Label htmlFor="deptFreeText" className="text-[13px]">
                                Department
                              </Label>
                              <Input
                                id="deptFreeText"
                                value={department}
                                onChange={(e) => setDepartment(e.target.value)}
                                placeholder="e.g. Computer Science"
                              />
                            </div>
                          )}

                          <div className="space-y-2">
                            <Label className="text-[13px]">Role</Label>
                            <div className="flex flex-wrap gap-2">
                              {STAFF_TITLE_OPTIONS.map((t) => (
                                <button
                                  key={t}
                                  type="button"
                                  onClick={() => setStaffTitle(staffTitle === t ? "" : t)}
                                  className={cn(
                                    "rounded-full border px-3.5 py-1.5 text-[13px] transition-colors",
                                    staffTitle === t
                                      ? "border-primary/50 bg-primary/10 font-medium text-primary"
                                      : "border-border hover:bg-muted/50",
                                  )}
                                >
                                  {t}
                                </button>
                              ))}
                            </div>
                          </div>
                        </>
                      )}

                      {/* Prospective / parent: programme interest */}
                      {["prospective", "parent", "guardian"].includes(initial.primaryRole) && (
                        <div className="space-y-1.5">
                          <Label htmlFor="progInterest" className="text-[13px]">
                            Programme of interest
                          </Label>
                          <Input
                            id="progInterest"
                            value={programme}
                            onChange={(e) => setProgramme(e.target.value)}
                            placeholder="e.g. Computer Science, Medicine…"
                          />
                        </div>
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
                            "flex w-full items-start gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors",
                            verbosity === v
                              ? "border-primary/40 bg-primary/5"
                              : "border-border hover:bg-muted/40",
                          )}
                        >
                          <span className={cn(
                            "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                            verbosity === v
                              ? "border-primary bg-primary"
                              : "border-muted-foreground/40",
                          )}>
                            {verbosity === v && (
                              <span className="size-1.5 rounded-full bg-white" />
                            )}
                          </span>
                          <span>
                            <span className={cn(
                              "block text-[13px] font-medium capitalize",
                              verbosity === v ? "text-primary" : "text-foreground",
                            )}>
                              {v}
                            </span>
                            <span className="mt-0.5 block text-[12px] text-muted-foreground">
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

              {/* ── Sticky save bar ── */}
              <div className="shrink-0 border-t bg-background/60 px-8 py-4 backdrop-blur-sm">
                <div className="mx-auto flex max-w-xl items-center justify-between gap-4">
                  <div className="text-[13px]">
                    {error && (
                      <span className="text-destructive">{error}</span>
                    )}
                    {!error && success && (
                      <span className="flex items-center gap-1.5 text-success dark:text-success">
                        <CheckCircle2Icon className="size-4" />
                        Changes saved
                      </span>
                    )}
                    {!error && !success && isDirty && (
                      <span className="text-muted-foreground">You have unsaved changes.</span>
                    )}
                  </div>
                  <Button
                    onClick={handleSave}
                    disabled={saving || !isDirty}
                    className="min-w-[120px]"
                  >
                    {saving ? (
                      <>
                        <Loader2Icon className="mr-2 size-4 animate-spin" />
                        Saving…
                      </>
                    ) : (
                      "Save changes"
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
