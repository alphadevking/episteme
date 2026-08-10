"use client";

// components/user/settings-shell.tsx
//
// The settings UI. Editing model:
//
//   values   — what the form currently shows
//   baseline — what the server last confirmed is stored
//
// Dirty state is `diffSettings(baseline, values)`, and that same diff is what
// gets sent. Two consequences worth stating, because the previous version got
// both wrong:
//
//  1. Only genuinely-changed fields are transmitted, so a save cannot clobber a
//     field the user never touched.
//  2. `baseline` is replaced with the server's echo after every save, so the
//     form re-baselines against reality. Previously `initial` was a prop that
//     never changed, which left "You have unsaved changes" showing forever and
//     the Save button permanently enabled after a successful save.
//
// Clearing a field is a first-class operation end to end — see
// lib/settings/schema.ts for why that needed a contract rather than a patch.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ArrowLeftIcon,
  UserRoundIcon,
  GraduationCapIcon,
  SparklesIcon,
  BriefcaseIcon,
  BookOpenIcon,
  ShieldCheckIcon,
  PaletteIcon,
  CircleUserIcon,
  CheckIcon,
  CheckCircle2Icon,
  AlertCircleIcon,
  ClockIcon,
  XCircleIcon,
  Loader2Icon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  XIcon,
  ShieldAlertIcon,
  DownloadIcon,
  UploadIcon,
  Trash2Icon,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AVATAR_ACCEPT, AVATAR_MAX_BYTES, DELETE_CONFIRMATION } from "@/lib/account/constants";
import type { SettingsData, SettingsOption } from "@/lib/settings/types";
import type { SettingsValues, ThemePref } from "@/lib/settings/schema";
import {
  SETTINGS_LIMITS,
  STAFF_TITLE_OPTIONS,
  settingsPatchSchema,
  formatSettingsIssue,
} from "@/lib/settings/schema";
import { diffSettings } from "@/lib/settings/patch";
import { LEVEL_OPTIONS } from "@/lib/constants/academic";

// ── Section model ───────────────────────────────────────────────────────────

type SectionId = "profile" | "context" | "ai" | "appearance" | "account" | "access" | "privacy";

type NavItem = {
  id: SectionId;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  /** Value keys owned by this section — drives the per-section unsaved dot. */
  fields: (keyof SettingsValues)[];
};

// ── Access model, mirrored from episteme-core's retrieval gate ──────────────
//
// Plain-English restatement of TRUST_NAMESPACES in
// episteme-core/src/mastra/security/retrieval-gate.ts. The number itself comes
// from the shared `deriveTrustLevel`, so it cannot disagree with what retrieval
// enforces; only this wording lives here.

const TRUST_TIERS: Record<number, { name: string; blurb: string; scope: string[] }> = {
  1: {
    name:  "Public",
    blurb: "You can ask about anything published openly by the university.",
    scope: ["Admissions", "Programmes", "General information"],
  },
  2: {
    name:  "Public",
    blurb: "You can ask about anything published openly by the university.",
    scope: ["Admissions", "Programmes", "General information"],
  },
  3: {
    name:  "Verified student",
    blurb: "Your matric number is verified, so academic policy and fee information are included.",
    scope: ["Admissions", "Programmes", "General information", "Academic policy", "Fees & financial aid"],
  },
  4: {
    name:  "Full access",
    blurb: "Your staff role grants access to internal documents in addition to everything above.",
    scope: [
      "Admissions", "Programmes", "General information",
      "Academic policy", "Fees & financial aid", "Staff-internal documents",
    ],
  },
};

// ── Small presentational primitives ─────────────────────────────────────────

function Field({
  label, optional, hint, children,
}: { label: string; optional?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium leading-none text-foreground">
        {label}
        {optional && <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
      </span>
      {children}
      {hint && <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** A read-only label/value row for information the user cannot change here. */
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground text-right">{children}</span>
    </div>
  );
}

function Badge({
  tone = "neutral", children,
}: { tone?: "neutral" | "success" | "warning" | "danger" | "primary"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        tone === "success" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        tone === "warning" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        tone === "danger"  && "bg-destructive/10 text-destructive",
        tone === "primary" && "bg-primary/10 text-primary",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/**
 * A single-select chip row. Clicking the active chip clears the value.
 *
 * A stored value outside `options` is rendered as an extra chip rather than
 * dropped. Live data has `user_ai_context.level = 'Postgraduate'`, which is not
 * in LEVEL_OPTIONS — without this, that user's level shows as unset even though
 * it is set, and the only way to "fix" it is to overwrite a legitimate value.
 * Showing it keeps the form honest about what is actually stored.
 */
function ChipGroup<T extends string>({
  options, value, onChange, clearable = true,
}: { options: readonly T[]; value: string; onChange: (v: string) => void; clearable?: boolean }) {
  const allOptions = useMemo(
    () => (value && !options.includes(value as T) ? [...options, value as T] : options),
    [options, value],
  );

  return (
    <div className="flex flex-wrap gap-2 pt-0.5">
      {allOptions.map((option) => {
        const selected = value === option;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(selected && clearable ? "" : option)}
            className={cn(
              "rounded-full border px-4 py-1.5 text-sm transition-colors",
              selected
                ? "border-primary/50 bg-primary/10 font-medium text-primary"
                : "border-border hover:bg-muted/50",
            )}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A filterable list picker over institution records, with a free-text fallback.
 *
 * The stored value is the rendered label ("Computer Science (CSC)"), not the
 * row id — that is the existing storage shape, which the AI reads as free text
 * from `user_ai_context`. Free text is also why the fallback input has to
 * exist: a user whose programme is not in the list must still be able to say
 * what it is.
 */
function RecordPicker({
  options, value, onChange, filterPlaceholder, freePlaceholder,
}: {
  options: SettingsOption[];
  value: string;
  onChange: (v: string) => void;
  filterPlaceholder: string;
  freePlaceholder: string;
}) {
  const [filter, setFilter] = useState("");

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.name} ${o.code}`.toLowerCase().includes(q));
  }, [options, filter]);

  if (options.length === 0) {
    return (
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={freePlaceholder} />
    );
  }

  const isCustom = value.length > 0 && !options.some((o) => `${o.name} (${o.code})` === value);

  return (
    <div className="space-y-2">
      {options.length > 6 && (
        <Input placeholder={filterPlaceholder} value={filter} onChange={(e) => setFilter(e.target.value)} />
      )}

      <div className="max-h-56 divide-y divide-border/40 overflow-y-auto rounded-lg border bg-background">
        {visible.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No matches.</p>
        ) : (
          visible.map((option) => {
            const label    = `${option.name} (${option.code})`;
            const selected = value === label;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                onClick={() => onChange(selected ? "" : label)}
                className={cn(
                  "flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition-colors",
                  "first:rounded-t-lg last:rounded-b-lg hover:bg-muted/50",
                  selected && "bg-primary/5 font-medium text-primary",
                )}
              >
                {label}
                {selected && <CheckIcon className="size-4 shrink-0 text-primary" />}
              </button>
            );
          })
        )}
      </div>

      {/* Free-text entry, shown when nothing is picked or the value is custom. */}
      {(!value || isCustom) && (
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={freePlaceholder} />
      )}

      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <XIcon className="size-3" /> Clear selection
        </button>
      )}
    </div>
  );
}

/**
 * A group of large radio cards.
 *
 * Built on a real `<fieldset>` + native `<input type="radio">` rather than
 * buttons carrying `role="radio"`. The ARIA role is only half the contract —
 * it also obliges the author to implement roving tabindex and arrow-key
 * navigation, which a `<button role="radio">` does not get for free. Native
 * inputs bring correct keyboard behaviour, group semantics and screen-reader
 * announcement ("2 of 3") with no JavaScript, so the accessible version is also
 * the simpler one. The input is `sr-only`; the card is the visible label.
 */
function RadioCardGroup<T extends string>({
  name, legend, value, options, onChange,
}: {
  name: string;
  legend: string;
  value: T;
  options: readonly { value: T; title: string; description: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-3 text-sm font-medium">{legend}</legend>
      <div className="space-y-3">
        {options.map((option) => {
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              className={cn(
                "flex w-full cursor-pointer items-start gap-4 rounded-xl border px-5 py-4 transition-colors",
                "focus-within:ring-2 focus-within:ring-primary/40",
                selected ? "border-primary/40 bg-primary/5" : "border-border hover:bg-muted/40",
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                  selected ? "border-primary bg-primary" : "border-muted-foreground/40",
                )}
              >
                {selected && <span className="size-1.5 rounded-full bg-primary-foreground" />}
              </span>
              <span>
                <span className={cn("block text-sm font-semibold", selected && "text-primary")}>
                  {option.title}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** `as const` so `value` narrows to ThemePref rather than widening to string. */
const THEME_CARDS = [
  { value: "light",  label: "Light",  Icon: SunIcon,     hint: "Always use the light theme." },
  { value: "dark",   label: "Dark",   Icon: MoonIcon,    hint: "Always use the dark theme." },
  { value: "system", label: "System", Icon: MonitorIcon, hint: "Match your device's appearance setting." },
] as const satisfies readonly {
  value: ThemePref;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  hint: string;
}[];

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  email:  "Email & password",
};

// ── Main component ──────────────────────────────────────────────────────────

export function SettingsShell({ data }: { data: SettingsData }) {
  const router = useRouter();
  const { setTheme } = useTheme();

  const [baseline, setBaseline] = useState<SettingsValues>(data.values);
  const [values,   setValues]   = useState<SettingsValues>(data.values);

  const [activeSection, setActiveSection] = useState<SectionId>("profile");
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);

  // Avatar and deletion sit outside the `values`/`baseline` diff model: they are
  // immediate actions against their own endpoints, not fields staged for a save.
  // Only the UPLOADED avatar is state — the provider's photo is fixed for the
  // session. Keeping them separate means removing an upload falls back to the
  // provider photo automatically, rather than blanking to initials.
  const [uploadedAvatarUrl, setUploadedAvatarUrl] = useState(data.account.uploadedAvatarUrl);
  const avatarUrl = uploadedAvatarUrl ?? data.account.providerAvatarUrl;
  const [avatarBusy,    setAvatarBusy]    = useState(false);
  const [avatarError,   setAvatarError]   = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [exporting,     setExporting]     = useState(false);
  const [exportError,   setExportError]   = useState<string | null>(null);
  const [deleteOpen,    setDeleteOpen]    = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteReason,  setDeleteReason]  = useState("");
  const [deleting,      setDeleting]      = useState(false);
  const [deleteError,   setDeleteError]   = useState<string | null>(null);

  const set = useCallback(<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setSaved(false);
    setError(null);
  }, []);

  // ── Dirty tracking ────────────────────────────────────────────────────
  const patch      = useMemo(() => diffSettings(baseline, values), [baseline, values]);
  const dirtyKeys  = useMemo(() => new Set(Object.keys(patch)), [patch]);
  const isDirty    = dirtyKeys.size > 0;

  // Validate as the user types so a save can't fail on something the form
  // could have told them about immediately.
  const validation   = useMemo(() => settingsPatchSchema.safeParse(patch), [patch]);
  const localError   = validation.success
    ? null
    : validation.error.issues.map(formatSettingsIssue)[0] ?? "Some fields need attention.";

  // ── Adopt the stored theme once on mount ──────────────────────────────
  // The stored value is authoritative across devices; next-themes' localStorage
  // copy is only authoritative on this one. See use-theme-preference.ts for why
  // this sync lives here rather than in the chat layout.
  const themeSynced = useRef(false);
  useEffect(() => {
    if (themeSynced.current) return;
    themeSynced.current = true;
    setTheme(data.values.theme);
  }, [setTheme, data.values.theme]);

  // ── Warn before losing unsaved edits on a hard navigation ─────────────
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  const goBack = useCallback(() => {
    // In-app navigation is ours to guard; `beforeunload` never fires for it.
    if (isDirty && !window.confirm("You have unsaved changes. Leave without saving?")) return;
    router.back();
  }, [isDirty, router]);

  // ── Save ──────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!isDirty || !validation.success || saving) return;

    setSaving(true);
    setSaved(false);
    setError(null);

    try {
      const res = await fetch("/api/profile", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(validation.data),
      });

      // A 500 can arrive as an HTML error page. The old code called
      // `res.json()` unguarded, which threw and left `saving` stuck true
      // forever with nothing shown to the user.
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        values?: SettingsValues;
        error?: string;
      };

      // Re-baseline against what the server actually stored — on success AND on
      // partial failure. On failure this leaves the form dirty for exactly the
      // fields that did not persist, so retrying sends only those.
      if (json.values) setBaseline(json.values);

      if (!res.ok) {
        setError(json.error ?? `Couldn't save changes (${res.status}).`);
        return;
      }

      if (json.values) {
        // Adopt server-normalised values (trimming, etc.) so the form shows
        // precisely what is stored.
        setValues(json.values);
        setTheme(json.values.theme);
      }
      setSaved(true);
      // Refresh server components so the sidebar badge picks up a name change.
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }, [isDirty, validation, saving, router, setTheme]);

  // Clear the success note after a moment, but never while still dirty.
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 4000);
    return () => clearTimeout(t);
  }, [saved]);

  // ── Avatar ────────────────────────────────────────────────────────────
  const uploadAvatar = useCallback(async (file: File) => {
    setAvatarError(null);

    // Checked again on the server (and by the bucket), but failing here saves
    // the user a 2 MB round trip to be told no.
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError("Images must be 2 MB or smaller.");
      return;
    }

    setAvatarBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res  = await fetch("/api/account/avatar", { method: "POST", body });
      const json = (await res.json().catch(() => ({}))) as { avatarUrl?: string; error?: string };

      if (!res.ok) {
        setAvatarError(json.error ?? `Upload failed (${res.status}).`);
        return;
      }
      setUploadedAvatarUrl(json.avatarUrl ?? null);
      router.refresh();
    } catch {
      setAvatarError("Couldn't reach the server. Check your connection.");
    } finally {
      setAvatarBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [router]);

  const removeAvatar = useCallback(async () => {
    setAvatarError(null);
    setAvatarBusy(true);
    try {
      const res = await fetch("/api/account/avatar", { method: "DELETE" });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setAvatarError(json.error ?? `Couldn't remove the image (${res.status}).`);
        return;
      }
      setUploadedAvatarUrl(null);
      router.refresh();
    } catch {
      setAvatarError("Couldn't reach the server. Check your connection.");
    } finally {
      setAvatarBusy(false);
    }
  }, [router]);

  // ── Data export ───────────────────────────────────────────────────────
  const exportData = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch("/api/account/export");

      // A failure has to be visible. Returning silently here just stopped the
      // spinner with no download and no message, which is indistinguishable
      // from a browser that blocked the save — the user retries forever.
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setExportError(json.error ?? `Couldn't prepare the export (${res.status}).`);
        return;
      }

      // Streamed to a blob and clicked rather than navigated to, so the
      // Content-Disposition download can't be mistaken for a page navigation
      // (which would drop the user out of the settings screen on some browsers).
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `episteme-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setExporting(false);
    }
  }, []);

  // ── Account deletion ──────────────────────────────────────────────────
  const deleteAccount = useCallback(async () => {
    if (deleteConfirm.trim() !== DELETE_CONFIRMATION) return;

    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/account/delete", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ confirm: deleteConfirm.trim(), reason: deleteReason.trim() || null }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };

      if (!res.ok) {
        // 409 carries the function's own refusal text (superadmin, or last
        // remaining admin) — it is written for the user, so show it verbatim.
        setDeleteError(json.error ?? `Couldn't delete the account (${res.status}).`);
        return;
      }

      const { createSupabaseBrowserClient } = await import("@/lib/supabase/browser");
      await createSupabaseBrowserClient().auth.signOut({ scope: "global" });
      router.replace("/sign-in");
    } catch {
      setDeleteError("Couldn't reach the server. Check your connection.");
    } finally {
      setDeleting(false);
    }
  }, [deleteConfirm, deleteReason, router]);

  const signOutEverywhere = useCallback(async () => {
    if (!window.confirm("Sign out of Episteme on all your devices?")) return;
    setSigningOutEverywhere(true);
    const { createSupabaseBrowserClient } = await import("@/lib/supabase/browser");
    await createSupabaseBrowserClient().auth.signOut({ scope: "global" });
    router.replace("/sign-in");
  }, [router]);

  // ── Navigation ────────────────────────────────────────────────────────
  const { account, verification, wards, trustLevel } = data;
  const role = account.primaryRole;

  const contextNav = ((): NavItem | null => {
    if (role === "student")
      return {
        id: "context", label: "Academic context", Icon: GraduationCapIcon,
        title: "Academic context",
        description: "Used by the AI to give you programme- and year-specific answers.",
        fields: ["programme", "level"],
      };
    if (role === "staff" || role === "hod")
      return {
        id: "context", label: "Staff context", Icon: BriefcaseIcon,
        title: "Staff context",
        description: "Helps the AI scope answers to your department and position.",
        fields: ["department", "staffTitle"],
      };
    if (["prospective", "parent", "guardian"].includes(role))
      return {
        id: "context", label: "Programme interest", Icon: BookOpenIcon,
        title: "Programme interest",
        description: "Helps the AI focus on the admission information relevant to you.",
        fields: ["programme"],
      };
    return null;
  })();

  const navItems: NavItem[] = [
    {
      id: "profile", label: "Profile", Icon: UserRoundIcon,
      title: "Profile",
      description: "Your name and contact details across the platform.",
      fields: ["firstName", "lastName", "displayName", "phone"],
    },
    ...(contextNav ? [contextNav] : []),
    {
      id: "ai", label: "AI preferences", Icon: SparklesIcon,
      title: "AI preferences",
      description: "Control the length and shape of Episteme's answers.",
      fields: ["verbosity", "answerFormat"],
    },
    {
      id: "appearance", label: "Appearance", Icon: PaletteIcon,
      title: "Appearance",
      description: "How Episteme looks. Saved to your account, so it follows you to other devices.",
      fields: ["theme"],
    },
    {
      id: "account", label: "Account", Icon: CircleUserIcon,
      title: "Account",
      description: "Your sign-in details and account standing.",
      fields: [],
    },
    {
      id: "access", label: "Access & verification", Icon: ShieldCheckIcon,
      title: "Access & verification",
      description: "What Episteme is allowed to look at when it answers you.",
      fields: [],
    },
    {
      id: "privacy", label: "Data & privacy", Icon: ShieldAlertIcon,
      title: "Data & privacy",
      description: "Take a copy of your data, or close your account.",
      fields: [],
    },
  ];

  const meta = navItems.find((n) => n.id === activeSection) ?? navItems[0];
  const sectionIsDirty = (item: NavItem) => item.fields.some((f) => dirtyKeys.has(f));

  const tier = TRUST_TIERS[trustLevel] ?? TRUST_TIERS[1];

  return (
    <div className="flex h-dvh flex-col bg-background">

      {/* ── Header ────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur-sm">
        <button
          type="button"
          onClick={goBack}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          <span className="hidden sm:inline">Back</span>
        </button>
        <Separator orientation="vertical" className="h-4" />
        <span className="text-sm font-semibold tracking-tight">Settings</span>
      </header>

      <div className="flex flex-1 overflow-hidden">

        {/* ── Desktop sidebar ─────────────────────────────────────────── */}
        <aside className="hidden w-56 shrink-0 flex-col border-r bg-sidebar px-3 py-5 md:flex">
          <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
            Settings
          </p>
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveSection(item.id)}
              aria-current={activeSection === item.id ? "page" : undefined}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors",
                activeSection === item.id
                  ? "bg-sidebar-accent text-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <item.Icon className={cn("size-4 shrink-0", activeSection === item.id && "text-primary")} />
              <span className="flex-1 truncate">{item.label}</span>
              {sectionIsDirty(item) && (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                  title="Unsaved changes in this section"
                />
              )}
            </button>
          ))}
        </aside>

        {/* ── Mobile tab strip ────────────────────────────────────────── */}
        <div className="scrollbar-none absolute left-0 right-0 top-12 z-10 flex overflow-x-auto border-b bg-background md:hidden">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveSection(item.id)}
              className={cn(
                "flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-5 py-3 text-sm font-medium transition-colors",
                activeSection === item.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <item.Icon className="size-4" />
              {item.label}
              {sectionIsDirty(item) && <span className="size-1.5 rounded-full bg-primary" />}
            </button>
          ))}
        </div>

        {/* ── Content ─────────────────────────────────────────────────── */}
        <div className="flex flex-1 flex-col overflow-hidden pt-[49px] md:pt-0">
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-2xl px-6 py-8 sm:px-10 lg:px-16">

              <div className="mb-8">
                <h1 className="font-serif text-xl font-semibold tracking-tight">{meta.title}</h1>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{meta.description}</p>
              </div>

              {/* ── Profile ── */}
              {activeSection === "profile" && (
                <div className="space-y-5">

                  {/* ── Avatar ── */}
                  <div className="flex flex-wrap items-center gap-5">
                    <Avatar className="size-20 shrink-0 border">
                      {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
                      <AvatarFallback className="bg-primary/15 text-xl font-semibold text-primary">
                        {(values.displayName || values.firstName || account.email || "?")
                          .charAt(0)
                          .toUpperCase()}
                      </AvatarFallback>
                    </Avatar>

                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={avatarBusy}
                          onClick={() => fileInputRef.current?.click()}
                        >
                          {avatarBusy
                            ? <><Loader2Icon className="mr-2 size-4 animate-spin" />Working…</>
                            : <><UploadIcon className="mr-2 size-4" />Upload photo</>}
                        </Button>
                        {/* Only an uploaded photo can be removed. Offering
                            "Remove" for the provider's photo was a button that
                            cleared an already-null column and changed nothing
                            on screen. */}
                        {uploadedAvatarUrl && (
                          <Button variant="ghost" size="sm" disabled={avatarBusy} onClick={removeAvatar}>
                            Remove
                          </Button>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        PNG, JPEG or WebP. Up to 2 MB.
                        {!uploadedAvatarUrl && account.providerAvatarUrl && (
                          <> Currently using your {PROVIDER_LABELS[account.provider ?? ""] ?? "sign-in"} photo.</>
                        )}
                      </p>
                      {avatarError && (
                        <p className="flex items-start gap-1.5 text-xs text-destructive">
                          <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
                          {avatarError}
                        </p>
                      )}
                    </div>

                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={AVATAR_ACCEPT}
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void uploadAvatar(file);
                      }}
                    />
                  </div>

                  <Separator />

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="First name">
                      <Input
                        value={values.firstName}
                        onChange={(e) => set("firstName", e.target.value)}
                        maxLength={SETTINGS_LIMITS.firstName}
                        autoComplete="given-name"
                      />
                    </Field>
                    <Field label="Last name">
                      <Input
                        value={values.lastName}
                        onChange={(e) => set("lastName", e.target.value)}
                        maxLength={SETTINGS_LIMITS.lastName}
                        autoComplete="family-name"
                      />
                    </Field>
                  </div>

                  <Field
                    label="Display name"
                    optional
                    hint="Shown instead of your full name across Episteme. Leave empty to use your first and last name."
                  >
                    <Input
                      value={values.displayName}
                      onChange={(e) => set("displayName", e.target.value)}
                      maxLength={SETTINGS_LIMITS.displayName}
                      placeholder={[values.firstName, values.lastName].filter(Boolean).join(" ") || "Your name"}
                    />
                  </Field>

                  <Field label="Phone" optional hint="Used by your institution to reach you about verification.">
                    <Input
                      type="tel"
                      value={values.phone}
                      onChange={(e) => set("phone", e.target.value)}
                      maxLength={SETTINGS_LIMITS.phone}
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
                  {role === "student" && (
                    <>
                      <Field label="Programme">
                        <RecordPicker
                          options={data.programmes}
                          value={values.programme}
                          onChange={(v) => set("programme", v)}
                          filterPlaceholder="Filter programmes…"
                          freePlaceholder="e.g. B.Sc. Computer Science"
                        />
                      </Field>
                      <Field label="Current level">
                        <ChipGroup
                          options={LEVEL_OPTIONS}
                          value={values.level}
                          onChange={(v) => set("level", v)}
                        />
                      </Field>
                    </>
                  )}

                  {(role === "staff" || role === "hod") && (
                    <>
                      <Field label="Department">
                        <RecordPicker
                          options={data.departments}
                          value={values.department}
                          onChange={(v) => set("department", v)}
                          filterPlaceholder="Filter departments…"
                          freePlaceholder="e.g. Computer Science"
                        />
                      </Field>
                      <Field label="Role / title">
                        <ChipGroup
                          options={STAFF_TITLE_OPTIONS}
                          value={values.staffTitle}
                          onChange={(v) => set("staffTitle", v)}
                        />
                      </Field>
                    </>
                  )}

                  {["prospective", "parent", "guardian"].includes(role) && (
                    <Field label="Programme of interest" optional>
                      <RecordPicker
                        options={data.programmes}
                        value={values.programme}
                        onChange={(v) => set("programme", v)}
                        filterPlaceholder="Filter programmes…"
                        freePlaceholder="e.g. Computer Science, Medicine…"
                      />
                    </Field>
                  )}
                </div>
              )}

              {/* ── AI preferences ── */}
              {activeSection === "ai" && (
                <div className="space-y-8">
                  <RadioCardGroup
                    name="verbosity"
                    legend="Answer length"
                    value={values.verbosity}
                    onChange={(v) => set("verbosity", v)}
                    options={[
                      {
                        value: "concise",
                        title: "Concise",
                        description: "Short, direct answers — best for quick lookups.",
                      },
                      {
                        value: "detailed",
                        title: "Detailed",
                        description: "Thorough explanations with the surrounding context and caveats.",
                      },
                    ]}
                  />

                  <RadioCardGroup
                    name="answerFormat"
                    legend="Answer format"
                    value={values.answerFormat}
                    onChange={(v) => set("answerFormat", v)}
                    options={[
                      {
                        value: "prose",
                        title: "Prose",
                        description: "Flowing paragraphs. Reads naturally for policy and explanation.",
                      },
                      {
                        value: "steps",
                        title: "Steps",
                        description:
                          "Numbered steps wherever the answer is a procedure — applications, payments, registration.",
                      },
                    ]}
                  />

                  <p className="text-xs leading-relaxed text-muted-foreground">
                    These affect how answers are written, never which sources Episteme is allowed to read.
                    Source access is governed by your role and verification — see Access &amp; verification.
                  </p>
                </div>
              )}

              {/* ── Appearance ── */}
              {activeSection === "appearance" && (
                <fieldset>
                  <legend className="sr-only">Theme</legend>
                  <div className="space-y-3">
                    {THEME_CARDS.map(({ value, label, Icon, hint }) => {
                      const selected = values.theme === value;
                      return (
                        <label
                          key={value}
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-4 rounded-xl border px-5 py-4 transition-colors",
                            "focus-within:ring-2 focus-within:ring-primary/40",
                            selected ? "border-primary/40 bg-primary/5" : "border-border hover:bg-muted/40",
                          )}
                        >
                          <input
                            type="radio"
                            name="theme"
                            value={value}
                            checked={selected}
                            onChange={() => {
                              set("theme", value);
                              setTheme(value); // live preview; persisted on save
                            }}
                            className="sr-only"
                          />
                          <Icon className={cn("size-5 shrink-0", selected && "text-primary")} />
                          <span className="flex-1">
                            <span className={cn("block text-sm font-semibold", selected && "text-primary")}>
                              {label}
                            </span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
                          </span>
                          {selected && <CheckIcon className="size-4 shrink-0 text-primary" />}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              )}

              {/* ── Account ── */}
              {activeSection === "account" && (
                <div className="space-y-8">
                  <div className="divide-y divide-border/60 rounded-xl border px-5">
                    <InfoRow label="Email">
                      <span className="flex flex-wrap items-center justify-end gap-2">
                        <span className="break-all">{account.email}</span>
                        {account.emailVerified
                          ? <Badge tone="success"><CheckCircle2Icon className="size-3" />Verified</Badge>
                          : <Badge tone="warning"><AlertCircleIcon className="size-3" />Unverified</Badge>}
                      </span>
                    </InfoRow>
                    <InfoRow label="Sign-in method">
                      {PROVIDER_LABELS[account.provider ?? ""] ?? titleCase(account.provider ?? "unknown")}
                    </InfoRow>
                    <InfoRow label="Account status">
                      <Badge tone={account.status === "active" ? "success" : "warning"}>
                        {titleCase(account.status)}
                      </Badge>
                    </InfoRow>
                    <InfoRow label="Role">
                      <span className="flex flex-wrap justify-end gap-1.5">
                        <Badge tone="primary">{titleCase(data.effectiveRole)}</Badge>
                        {account.isSuperadmin && <Badge tone="danger">Superadmin</Badge>}
                        {account.roles
                          .filter((r) => r !== data.effectiveRole)
                          .map((r) => <Badge key={r}>{titleCase(r)}</Badge>)}
                      </span>
                    </InfoRow>
                    {account.institutionName && (
                      <InfoRow label="Institution">{account.institutionName}</InfoRow>
                    )}
                    <InfoRow label="Member since">{formatDate(account.createdAt)}</InfoRow>
                    <InfoRow label="Last sign-in">{formatDate(account.lastLoginAt)}</InfoRow>
                  </div>

                  <div>
                    <p className="text-sm font-medium">Security</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Ends your Episteme session on every device, including this one. Use this if you signed in
                      somewhere you no longer trust.
                    </p>
                    <Button
                      variant="outline"
                      className="mt-3"
                      onClick={signOutEverywhere}
                      disabled={signingOutEverywhere}
                    >
                      {signingOutEverywhere ? (
                        <><Loader2Icon className="mr-2 size-4 animate-spin" />Signing out…</>
                      ) : (
                        "Sign out everywhere"
                      )}
                    </Button>
                  </div>

                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Your email address and role are managed by your institution and can&apos;t be edited here.
                    Contact your institution administrator if either is wrong.
                  </p>
                </div>
              )}

              {/* ── Access & verification ── */}
              {activeSection === "access" && (
                <div className="space-y-8">

                  {/* Trust tier */}
                  <div className="rounded-xl border p-5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold">{tier.name}</span>
                      <Badge tone="primary">Level {trustLevel} of 4</Badge>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{tier.blurb}</p>

                    <div className="mt-4 flex gap-1" aria-hidden>
                      {[1, 2, 3, 4].map((n) => (
                        <span
                          key={n}
                          className={cn(
                            "h-1.5 flex-1 rounded-full",
                            n <= trustLevel ? "bg-primary" : "bg-muted",
                          )}
                        />
                      ))}
                    </div>

                    <p className="mt-4 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                      Episteme can search
                    </p>
                    <ul className="mt-2 space-y-1.5">
                      {tier.scope.map((item) => (
                        <li key={item} className="flex items-center gap-2 text-sm">
                          <CheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Student verification */}
                  {verification && (
                    <div>
                      <p className="text-sm font-medium">Student verification</p>
                      <div className="mt-3 divide-y divide-border/60 rounded-xl border px-5">
                        <InfoRow label="Matric number">
                          <span className="font-mono">{verification.matricNumber}</span>
                        </InfoRow>
                        <InfoRow label="Status">
                          {verification.status === "admin_verified" ? (
                            <Badge tone="success"><CheckCircle2Icon className="size-3" />Verified</Badge>
                          ) : verification.status === "pending" ? (
                            <Badge tone="warning"><ClockIcon className="size-3" />Awaiting review</Badge>
                          ) : (
                            <Badge tone="danger"><XCircleIcon className="size-3" />Rejected</Badge>
                          )}
                        </InfoRow>
                        {verification.verifiedAt && (
                          <InfoRow label="Verified on">{formatDate(verification.verifiedAt)}</InfoRow>
                        )}
                        {verification.method && (
                          <InfoRow label="Method">{titleCase(verification.method)}</InfoRow>
                        )}
                      </div>

                      {verification.status === "rejected" && (
                        <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
                          {verification.rejectionReason && (
                            <p className="text-xs italic leading-relaxed text-muted-foreground">
                              {verification.rejectionReason}
                            </p>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            className="mt-2"
                            onClick={() => router.push("/onboarding")}
                          >
                            Re-submit matric number
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                  {!verification && ["student", "prospective"].includes(role) && (
                    <div className="rounded-xl border border-dashed p-5">
                      <p className="text-sm font-medium">Not verified yet</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Verify your matric number to unlock academic policy and fee information.
                      </p>
                      <Button size="sm" variant="outline" className="mt-3" onClick={() => router.push("/onboarding")}>
                        Verify matric number
                      </Button>
                    </div>
                  )}

                  {/* Linked wards */}
                  {wards.length > 0 && (
                    <div>
                      <p className="text-sm font-medium">Linked students</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        What Episteme may discuss about each ward. These permissions are set by your institution.
                      </p>
                      <div className="mt-3 space-y-3">
                        {wards.map((ward, i) => (
                          <div key={`${ward.matric ?? ward.name ?? i}`} className="rounded-xl border p-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-sm font-medium">{ward.name ?? "Pending student"}</span>
                              <Badge tone={ward.status === "verified" ? "success" : "warning"}>
                                {titleCase(ward.status)}
                              </Badge>
                            </div>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {titleCase(ward.relationship)}
                              {ward.matric && <> · <span className="font-mono">{ward.matric}</span></>}
                            </p>
                            <div className="mt-3 flex flex-wrap gap-1.5">
                              {([
                                ["Academic records", ward.canViewAcademic],
                                ["Fees",             ward.canViewFees],
                                ["Attendance",       ward.canViewAttendance],
                              ] as [string, boolean][]).map(([label, allowed]) => (
                                <Badge key={label} tone={allowed ? "success" : "neutral"}>
                                  {allowed ? <CheckIcon className="size-3" /> : <XIcon className="size-3" />}
                                  {label}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Access is enforced when Episteme searches, not by hiding answers afterwards. Changing your
                    programme or level above adjusts what it looks for — never what you&apos;re allowed to see.
                  </p>
                </div>
              )}

              {/* ── Data & privacy ── */}
              {activeSection === "privacy" && (
                <div className="space-y-8">

                  {/* Export */}
                  <div className="rounded-xl border p-5">
                    <p className="text-sm font-medium">Export your data</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Downloads a JSON file containing your profile, preferences, verification records, chat
                      threads and messages. It does not include records about you written by administrators.
                    </p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={exportData} disabled={exporting}>
                      {exporting
                        ? <><Loader2Icon className="mr-2 size-4 animate-spin" />Preparing…</>
                        : <><DownloadIcon className="mr-2 size-4" />Download my data</>}
                    </Button>

                    {exportError && (
                      <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
                        <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
                        {exportError}
                      </p>
                    )}
                  </div>

                  {/* Danger zone */}
                  <div className="rounded-xl border border-destructive/30 bg-destructive/[0.03] p-5">
                    <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                      <ShieldAlertIcon className="size-4" /> Close your account
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Your account is deactivated immediately and you&apos;re signed out everywhere. Your data is
                      retained so your institution can restore the account if this was a mistake — contact your
                      administrator to undo it.
                    </p>

                    {!deleteOpen ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => { setDeleteOpen(true); setDeleteError(null); }}
                      >
                        <Trash2Icon className="mr-2 size-4" />
                        Close account
                      </Button>
                    ) : (
                      <div className="mt-4 space-y-3">
                        <Field label="Why are you leaving?" optional>
                          <Input
                            value={deleteReason}
                            onChange={(e) => setDeleteReason(e.target.value)}
                            maxLength={500}
                            placeholder="Optional — helps your institution improve Episteme"
                          />
                        </Field>

                        <Field
                          label={`Type ${DELETE_CONFIRMATION} to confirm`}
                          hint="This exact phrase is required, and is checked again on the server."
                        >
                          <Input
                            value={deleteConfirm}
                            onChange={(e) => setDeleteConfirm(e.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={DELETE_CONFIRMATION}
                          />
                        </Field>

                        {deleteError && (
                          <p className="flex items-start gap-1.5 text-xs text-destructive">
                            <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
                            {deleteError}
                          </p>
                        )}

                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            className="bg-destructive text-white hover:bg-destructive/90"
                            disabled={deleting || deleteConfirm.trim() !== DELETE_CONFIRMATION}
                            onClick={deleteAccount}
                          >
                            {deleting
                              ? <><Loader2Icon className="mr-2 size-4 animate-spin" />Closing…</>
                              : "Permanently close my account"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={deleting}
                            onClick={() => {
                              setDeleteOpen(false);
                              setDeleteConfirm("");
                              setDeleteReason("");
                              setDeleteError(null);
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

            </div>
          </div>

          {/* ── Save bar ─────────────────────────────────────────────── */}
          <div className="shrink-0 border-t bg-background/80 backdrop-blur-sm">
            <div className="flex max-w-2xl items-center justify-between gap-4 px-6 py-3 sm:px-10 lg:px-16">
              <div className="min-h-[1.25rem] text-sm">
                {(error ?? localError) ? (
                  <span className="flex items-start gap-1.5 text-destructive">
                    <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                    <span className="text-[13px] leading-snug">{error ?? localError}</span>
                  </span>
                ) : saved ? (
                  <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2Icon className="size-4" /> Changes saved
                  </span>
                ) : isDirty ? (
                  <span className="text-[13px] text-muted-foreground">
                    {dirtyKeys.size} unsaved {dirtyKeys.size === 1 ? "change" : "changes"}.
                  </span>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {isDirty && !saving && (
                  <Button
                    variant="ghost"
                    onClick={() => { setValues(baseline); setTheme(baseline.theme); setError(null); }}
                  >
                    Discard
                  </Button>
                )}
                <Button
                  onClick={handleSave}
                  disabled={saving || !isDirty || Boolean(localError)}
                  className="min-w-[120px]"
                >
                  {saving ? <><Loader2Icon className="mr-2 size-4 animate-spin" />Saving…</> : "Save changes"}
                </Button>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
