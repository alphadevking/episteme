"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type ChangeEvent,
  type FormEvent,
  type DragEvent,
} from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CheckCircle2Icon,
  UploadCloudIcon,
  FileTextIcon,
  CodeIcon,
  TagIcon,
  ShieldIcon,
  LinkIcon,
  FolderIcon,
  XIcon,
  BuildingIcon,
  ChevronDownIcon,
  LayersIcon,
  LockIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";

// ── Static options with display labels ───────────────────────────────────────
const NAMESPACE_OPTIONS = [
  { value: "admissions",      label: "Admissions" },
  { value: "academic-policy", label: "Academic Policy" },
  { value: "financial-aid",   label: "Financial Aid" },
  { value: "programmes",      label: "Programmes" },
  { value: "staff-internal",  label: "Staff Internal" },
  { value: "general",         label: "General" },
];

const CATEGORY_OPTIONS = [
  { value: "admissions",      label: "Admissions" },
  { value: "academic-policy", label: "Academic Policy" },
  { value: "financial-aid",   label: "Financial Aid" },
  { value: "programmes",      label: "Programmes" },
  { value: "staff-internal",  label: "Staff Internal" },
  { value: "general",         label: "General" },
];

const CONTENT_TYPE_OPTIONS = [
  { value: "general",      label: "General" },
  { value: "policy",       label: "Policy" },
  { value: "handbook",     label: "Handbook" },
  { value: "faq",          label: "FAQ" },
  { value: "announcement", label: "Announcement" },
  { value: "catalogue",    label: "Catalogue" },
  { value: "markdown",     label: "Markdown" },
];

const ROLES       = ["prospective", "student", "parent", "staff", "hod"];
const ROLE_LABELS: Record<string, string> = {
  prospective: "Prospective",
  student:     "Student",
  parent:      "Parent",
  staff:       "Staff",
  hod:         "HOD",
};

type InputMode = "file" | "markdown" | "plaintext";

// ── Scope types ───────────────────────────────────────────────────────────────
interface Institution { id: string; name: string; code: string }
interface Faculty     { id: string; name: string; code: string; institution_id: string }
interface Department  { id: string; name: string; code: string; faculty_id: string }
interface Program     { id: string; name: string; code: string; department_id: string }

// ── Shared field styles ───────────────────────────────────────────────────────
const inputBase =
  "w-full h-9 rounded-lg border border-input bg-background px-3 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring transition-colors";

const selectBase =
  "w-full h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring transition-colors appearance-none cursor-pointer";

// ── Section header ────────────────────────────────────────────────────────────
function SectionHeading({ icon: Icon, label }: { icon: React.ElementType; label: string }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

// ── Labelled select wrapper ───────────────────────────────────────────────────
function LabelledSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <select value={value} onChange={onChange} className={selectBase} disabled={disabled}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <div className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center">
        <ChevronDownIcon className="size-3.5 text-muted-foreground" />
      </div>
    </div>
  );
}

// ── Multi-select pill picker ──────────────────────────────────────────────────
function MultiPicker<T extends { id: string; name: string; code: string }>({
  label,
  items,
  selected,
  onToggle,
  placeholder,
  disabled,
  loading,
}: {
  label: string;
  items: T[];
  selected: string[];
  onToggle: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selectedItems = items.filter((i) => selected.includes(i.id));

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <div
        onClick={() => !disabled && !loading && setOpen((o) => !o)}
        className={`min-h-9 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-sm transition-colors ${
          disabled || loading
            ? "opacity-50 cursor-not-allowed"
            : "cursor-pointer hover:border-ring/40"
        }`}
      >
        {loading ? (
          <span className="text-muted-foreground/50 text-xs">Loading...</span>
        ) : selectedItems.length === 0 ? (
          <span className="text-muted-foreground/50">
            {placeholder ?? `Select ${label.toLowerCase()}...`}
          </span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {selectedItems.map((item) => (
              <span
                key={item.id}
                className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
              >
                {item.name}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggle(item.id); }}
                  className="hover:text-destructive transition-colors"
                >
                  <XIcon className="size-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {open && !disabled && !loading && (
        <div className="rounded-lg border border-input bg-popover shadow-md overflow-hidden">
          {items.length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-muted-foreground">No options available</p>
          ) : (
            <div className="max-h-44 overflow-y-auto divide-y divide-border/50">
              {items.map((item) => {
                const active = selected.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onToggle(item.id)}
                    className={`w-full flex items-center px-3 py-2 text-xs text-left transition-colors ${
                      active ? "bg-primary/8 text-primary font-medium" : "hover:bg-muted/60 text-foreground"
                    }`}
                  >
                    <span className="flex-1">{item.name}</span>
                    <span className="text-muted-foreground font-mono mr-2">{item.code}</span>
                    {active && <CheckCircle2Icon className="size-3 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function KbUploadDialog() {
  const router   = useRouter();
  const fileRef  = useRef<HTMLInputElement>(null);
  const supabase = createSupabaseBrowserClient();

  const [open,        setOpen]        = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [success,     setSuccess]     = useState(false);
  const [mode,        setMode]        = useState<InputMode>("file");
  const [dragging,    setDragging]    = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);

  // ── Scope state ──────────────────────────────────────────────────────────────
  const [isSuperadmin,     setIsSuperadmin]     = useState(false);
  const [adminInstitution, setAdminInstitution] = useState<Institution | null>(null);
  const [institutions,     setInstitutions]     = useState<Institution[]>([]);
  const [faculties,        setFaculties]        = useState<Faculty[]>([]);
  const [departments,      setDepartments]      = useState<Department[]>([]);
  const [programs,         setPrograms]         = useState<Program[]>([]);

  const [scopeLoading, setScopeLoading] = useState(false);
  const [facLoading,   setFacLoading]   = useState(false);
  const [deptLoading,  setDeptLoading]  = useState(false);
  const [progLoading,  setProgLoading]  = useState(false);

  const [selectedInstitution, setSelectedInstitution] = useState<string>("");
  const [selectedFaculties,   setSelectedFaculties]   = useState<string[]>([]);
  const [selectedDepartments, setSelectedDepartments] = useState<string[]>([]);
  const [selectedPrograms,    setSelectedPrograms]    = useState<string[]>([]);

  const activeInstitutionId = isSuperadmin
    ? selectedInstitution
    : (adminInstitution?.id ?? "");

  // ── Form state ───────────────────────────────────────────────────────────────
  const [form, setForm] = useState({
    docId:       "",
    fileName:    "",
    namespace:   "general",
    category:    "general",
    contentType: "general",
    source:      "",
    roles:       ["prospective"] as string[],
    updatedAt:   new Date().toISOString().split("T")[0],
    textContent: "",
  });

  function field(key: keyof typeof form) {
    return (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  function toggleRole(role: string) {
    setForm((f) => ({
      ...f,
      roles: f.roles.includes(role)
        ? f.roles.filter((r) => r !== role)
        : [...f.roles, role],
    }));
  }

  // ── Resolve current user on open ─────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setScopeLoading(true);

    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { setScopeLoading(false); return; }

      const { data: profile } = await supabase
        .from("users")
        .select("is_superadmin, institution_id")
        .eq("auth_id", user.id)
        .maybeSingle();

      const superadmin = profile?.is_superadmin === true;
      setIsSuperadmin(superadmin);

      if (superadmin) {
        // Superadmin: load all institutions for the picker
        const { data: insts } = await supabase
          .from("institutions")
          .select("id, name, code")
          .eq("is_active", true)
          .order("name");
        setInstitutions((insts ?? []) as Institution[]);
      } else {
        // Regular admin: resolve and lock their own institution
        const instId = profile?.institution_id ?? null;
        if (instId) {
          const { data: inst } = await supabase
            .from("institutions")
            .select("id, name, code")
            .eq("id", instId)
            .maybeSingle();
          if (inst) setAdminInstitution(inst as Institution);
        }
      }

      setScopeLoading(false);
    });
  }, [open]);

  // ── Cascade: faculties ────────────────────────────────────────────────────────
  useEffect(() => {
    setSelectedFaculties([]);
    setFaculties([]);
    setSelectedDepartments([]);
    setDepartments([]);
    setSelectedPrograms([]);
    setPrograms([]);
    if (!activeInstitutionId) return;
    setFacLoading(true);
    supabase
      .from("faculties")
      .select("id, name, code, institution_id")
      .eq("institution_id", activeInstitutionId)
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => { setFaculties((data ?? []) as Faculty[]); setFacLoading(false); });
  }, [activeInstitutionId]);

  // ── Cascade: departments ──────────────────────────────────────────────────────
  useEffect(() => {
    setSelectedDepartments([]);
    setDepartments([]);
    setSelectedPrograms([]);
    setPrograms([]);
    if (selectedFaculties.length === 0) return;
    setDeptLoading(true);
    supabase
      .from("departments")
      .select("id, name, code, faculty_id")
      .in("faculty_id", selectedFaculties)
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => { setDepartments((data ?? []) as Department[]); setDeptLoading(false); });
  }, [selectedFaculties]);

  // ── Cascade: programs ─────────────────────────────────────────────────────────
  useEffect(() => {
    setSelectedPrograms([]);
    setPrograms([]);
    if (selectedDepartments.length === 0) return;
    setProgLoading(true);
    supabase
      .from("programs")
      .select("id, name, code, department_id")
      .in("department_id", selectedDepartments)
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => { setPrograms((data ?? []) as Program[]); setProgLoading(false); });
  }, [selectedDepartments]);

  function toggleMulti(id: string, setter: React.Dispatch<React.SetStateAction<string[]>>) {
    setter((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  // ── Dialog reset ─────────────────────────────────────────────────────────────
  function handleOpenChange(val: boolean) {
    if (!val) {
      setError(null);
      setSuccess(false);
      setDroppedFile(null);
      setDragging(false);
      setIsSuperadmin(false);
      setAdminInstitution(null);
      setInstitutions([]);
      setSelectedInstitution("");
      setSelectedFaculties([]);
      setSelectedDepartments([]);
      setSelectedPrograms([]);
    }
    setOpen(val);
  }

  // ── File handling ─────────────────────────────────────────────────────────────
  const acceptFile = useCallback((file: File) => {
    setDroppedFile(file);
    setForm((f) => ({ ...f, fileName: f.fileName || file.name }));
  }, []);

  function onDragOver(e: DragEvent) { e.preventDefault(); setDragging(true); }
  function onDragLeave()            { setDragging(false); }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) acceptFile(file);
  }
  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) acceptFile(file);
  }

  // ── Submit ────────────────────────────────────────────────────────────────────
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const resolvedInstitution = isSuperadmin
        ? (institutions.find((i) => i.id === selectedInstitution) ?? null)
        : adminInstitution;

      const scopeMeta: Record<string, unknown> = {};
      if (resolvedInstitution) {
        scopeMeta.institutionId   = resolvedInstitution.id;
        scopeMeta.institutionName = resolvedInstitution.name;
      }
      if (selectedFaculties.length > 0) {
        scopeMeta.facultyIds   = selectedFaculties;
        scopeMeta.facultyNames = faculties
          .filter((f) => selectedFaculties.includes(f.id))
          .map((f) => f.name);
      }
      if (selectedDepartments.length > 0) {
        scopeMeta.departmentIds   = selectedDepartments;
        scopeMeta.departmentNames = departments
          .filter((d) => selectedDepartments.includes(d.id))
          .map((d) => d.name);
      }
      if (selectedPrograms.length > 0) {
        scopeMeta.programIds   = selectedPrograms;
        scopeMeta.programNames = programs
          .filter((p) => selectedPrograms.includes(p.id))
          .map((p) => p.name);
        // Legacy compat: single string for existing Pinecone metadata filters
        scopeMeta.programme = programs
          .filter((p) => selectedPrograms.includes(p.id))
          .map((p) => p.name)
          .join(", ");
      }

      const facultyLabel = selectedFaculties.length > 0
        ? (faculties.find((f) => f.id === selectedFaculties[0])?.name ?? "")
        : "";

      const body: Record<string, unknown> = {
        docId:       form.docId || `doc-${Date.now()}`,
        fileName:    form.fileName,
        namespace:   form.namespace,
        category:    form.category,
        contentType: form.contentType,
        faculty:     facultyLabel,
        source:      form.source,
        roles:       form.roles,
        updatedAt:   new Date(form.updatedAt).toISOString(),
        scope:       scopeMeta,
      };

      if (mode === "file") {
        const file = droppedFile ?? fileRef.current?.files?.[0];
        if (!file) { setError("Please select or drop a file."); setLoading(false); return; }
        const buffer = await file.arrayBuffer();
        const bytes  = new Uint8Array(buffer);
        let binary   = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        body.fileBufferBase64 = btoa(binary);
        if (!body.fileName) body.fileName = file.name;
      } else if (mode === "markdown") {
        body.markdownContent = form.textContent;
        body.contentType     = "markdown";
      } else {
        body.plainTextContent = form.textContent;
      }

      const res  = await fetch("/api/admin/kb", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) { setError(data.error ?? "Ingestion failed."); setLoading(false); return; }

      setSuccess(true);
      setTimeout(() => { setOpen(false); setSuccess(false); router.refresh(); }, 1600);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  // ── Scope summary ─────────────────────────────────────────────────────────────
  const resolvedInstName = isSuperadmin
    ? (institutions.find((i) => i.id === selectedInstitution)?.name ?? null)
    : (adminInstitution?.name ?? null);

  const scopeSummary = [
    resolvedInstName,
    selectedFaculties.length > 0
      ? `${selectedFaculties.length} ${selectedFaculties.length === 1 ? "faculty" : "faculties"}`
      : null,
    selectedDepartments.length > 0
      ? `${selectedDepartments.length} dept${selectedDepartments.length > 1 ? "s" : ""}`
      : null,
    selectedPrograms.length > 0
      ? `${selectedPrograms.length} program${selectedPrograms.length > 1 ? "s" : ""}`
      : null,
  ].filter(Boolean).join(" › ");

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <UploadCloudIcon className="size-4 mr-2" />
          Ingest Document
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-xl p-0 gap-0 overflow-hidden flex flex-col max-h-[92vh]">
        <DialogHeader className="px-6 py-4 border-b shrink-0">
          <DialogTitle className="text-base font-semibold flex items-center gap-2">
            <UploadCloudIcon className="size-4 text-primary" />
            Ingest Document
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Add content to the knowledge base for AI retrieval.
          </p>
        </DialogHeader>

        {success ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 ring-4 ring-primary/5">
              <CheckCircle2Icon className="size-7 text-primary" />
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold">Document ingested</p>
              <p className="text-xs text-muted-foreground mt-1">The knowledge base has been updated.</p>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

              {/* ── Source type tabs ── */}
              <div className="grid grid-cols-3 gap-1 rounded-xl border bg-muted/40 p-1">
                {([
                  { id: "file",      icon: UploadCloudIcon, label: "File Upload" },
                  { id: "markdown",  icon: CodeIcon,        label: "Markdown"    },
                  { id: "plaintext", icon: FileTextIcon,    label: "Plain Text"  },
                ] as { id: InputMode; icon: React.ElementType; label: string }[]).map(({ id, icon: Icon, label }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setMode(id)}
                    className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition-all ${
                      mode === id
                        ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    {label}
                  </button>
                ))}
              </div>

              {/* ── Content input ── */}
              {mode === "file" ? (
                <div
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop}
                  onClick={() => !droppedFile && fileRef.current?.click()}
                  className={`relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors cursor-pointer ${
                    dragging
                      ? "border-primary bg-primary/5"
                      : droppedFile
                      ? "border-primary/40 bg-primary/5 cursor-default"
                      : "border-border bg-muted/20 hover:border-primary/40 hover:bg-muted/40"
                  }`}
                >
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".pdf,.docx,.doc,.html,.htm,.png,.jpg,.jpeg,.tiff"
                    className="sr-only"
                    onChange={onFileChange}
                  />
                  {droppedFile ? (
                    <>
                      <div className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                        <FileTextIcon className="size-5 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">{droppedFile.name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {(droppedFile.size / 1024).toFixed(0)} KB
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setDroppedFile(null); }}
                        className="absolute top-3 right-3 flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                      >
                        <XIcon className="size-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      <div className={`flex size-10 items-center justify-center rounded-full transition-colors ${dragging ? "bg-primary/10" : "bg-muted"}`}>
                        <UploadCloudIcon className={`size-5 transition-colors ${dragging ? "text-primary" : "text-muted-foreground"}`} />
                      </div>
                      <div>
                        <p className="text-sm font-medium">
                          {dragging ? "Drop to upload" : "Drop file here or click to browse"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">PDF, DOCX, HTML, PNG, JPG, TIFF</p>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">
                    {mode === "markdown" ? "Markdown Content" : "Plain Text Content"}
                  </Label>
                  <textarea
                    value={form.textContent}
                    onChange={field("textContent")}
                    rows={6}
                    required
                    placeholder={
                      mode === "markdown"
                        ? "# Document Title\n\nPaste markdown content here..."
                        : "Paste announcement, policy, or general information..."
                    }
                    className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm font-mono resize-none placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring transition-colors"
                  />
                </div>
              )}

              {/* ── Identity ── */}
              <div className="space-y-3">
                <SectionHeading icon={FolderIcon} label="Identity" />
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      File Name <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      value={form.fileName}
                      onChange={field("fileName")}
                      placeholder="admissions-policy.pdf"
                      required
                      className={inputBase}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      Doc ID{" "}
                      <span className="text-muted-foreground font-normal">(auto-generated)</span>
                    </Label>
                    <Input
                      value={form.docId}
                      onChange={field("docId")}
                      placeholder="admissions-2025"
                      className={inputBase}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium flex items-center gap-1.5">
                    <LinkIcon className="size-3 text-muted-foreground" />
                    Source URL / Reference <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    value={form.source}
                    onChange={field("source")}
                    placeholder="https://university.edu/admissions"
                    required
                    className={inputBase}
                  />
                </div>
              </div>

              {/* ── Scope ── */}
              <div className="space-y-3">
                <SectionHeading icon={BuildingIcon} label="Scope" />

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Institution</Label>
                  {scopeLoading ? (
                    <div className={`${inputBase} flex items-center text-muted-foreground/50 text-xs`}>
                      Resolving...
                    </div>
                  ) : isSuperadmin ? (
                    <>
                      <div className="relative">
                        <select
                          value={selectedInstitution}
                          onChange={(e) => setSelectedInstitution(e.target.value)}
                          className={selectBase}
                        >
                          <option value="">All institutions (global)</option>
                          {institutions.map((i) => (
                            <option key={i.id} value={i.id}>{i.name} ({i.code})</option>
                          ))}
                        </select>
                        <div className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center">
                          <ChevronDownIcon className="size-3.5 text-muted-foreground" />
                        </div>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Leave blank to make this document available across all institutions.
                      </p>
                    </>
                  ) : (
                    <div className="flex items-center gap-2.5 h-9 rounded-lg border border-border bg-muted/40 px-3">
                      <LockIcon className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-sm text-foreground">
                        {adminInstitution?.name ?? "Unknown institution"}
                      </span>
                      {adminInstitution?.code && (
                        <span className="ml-auto text-xs font-mono text-muted-foreground">
                          {adminInstitution.code}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <MultiPicker
                  label="Faculties"
                  items={faculties}
                  selected={selectedFaculties}
                  onToggle={(id) => toggleMulti(id, setSelectedFaculties)}
                  placeholder={!activeInstitutionId ? "Select an institution first" : "All faculties (institution-wide)"}
                  disabled={!activeInstitutionId}
                  loading={facLoading}
                />
                <MultiPicker
                  label="Departments"
                  items={departments}
                  selected={selectedDepartments}
                  onToggle={(id) => toggleMulti(id, setSelectedDepartments)}
                  placeholder={selectedFaculties.length === 0 ? "Select faculties first" : "All departments in selected faculties"}
                  disabled={selectedFaculties.length === 0}
                  loading={deptLoading}
                />
                <MultiPicker
                  label="Programs"
                  items={programs}
                  selected={selectedPrograms}
                  onToggle={(id) => toggleMulti(id, setSelectedPrograms)}
                  placeholder={selectedDepartments.length === 0 ? "Select departments first" : "All programs in selected departments"}
                  disabled={selectedDepartments.length === 0}
                  loading={progLoading}
                />

                {scopeSummary && (
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                    <LayersIcon className="size-3.5 text-muted-foreground shrink-0" />
                    <p className="text-xs text-muted-foreground">
                      Scoped to:{" "}
                      <span className="font-medium text-foreground">{scopeSummary}</span>
                    </p>
                  </div>
                )}
              </div>

              {/* ── Classification ── */}
              <div className="space-y-3">
                <SectionHeading icon={TagIcon} label="Classification" />
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      Namespace <span className="text-destructive">*</span>
                    </Label>
                    <LabelledSelect
                      value={form.namespace}
                      onChange={field("namespace")}
                      options={NAMESPACE_OPTIONS}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      Category <span className="text-destructive">*</span>
                    </Label>
                    <LabelledSelect
                      value={form.category}
                      onChange={field("category")}
                      options={CATEGORY_OPTIONS}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Content Type</Label>
                    <LabelledSelect
                      value={form.contentType}
                      onChange={field("contentType")}
                      options={CONTENT_TYPE_OPTIONS}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Document Date</Label>
                    <Input
                      type="date"
                      value={form.updatedAt}
                      onChange={field("updatedAt")}
                      className={inputBase}
                    />
                  </div>
                </div>
              </div>

              {/* ── Access ── */}
              <div className="space-y-3">
                <SectionHeading icon={ShieldIcon} label="Access" />
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">
                    Visible to Roles <span className="text-destructive">*</span>
                  </Label>
                  <div className="flex flex-wrap gap-2 pt-0.5">
                    {ROLES.map((role) => {
                      const active = form.roles.includes(role);
                      return (
                        <button
                          key={role}
                          type="button"
                          onClick={() => toggleRole(role)}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                            active
                              ? "border-primary bg-primary text-primary-foreground shadow-sm"
                              : "border-border bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                          }`}
                        >
                          {active && <CheckCircle2Icon className="size-3 shrink-0" />}
                          {ROLE_LABELS[role]}
                        </button>
                      );
                    })}
                  </div>
                  {form.roles.length === 0 && (
                    <p className="text-xs text-muted-foreground">Select at least one role.</p>
                  )}
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-3">
                  <XIcon className="size-3.5 text-destructive shrink-0 mt-0.5" />
                  <p className="text-xs text-destructive leading-snug">{error}</p>
                </div>
              )}
            </div>

            {/* ── Footer ── */}
            <div className="shrink-0 flex items-center justify-end gap-2 border-t px-6 py-4 bg-muted/20">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setOpen(false)}
                className="text-muted-foreground"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={loading || form.roles.length === 0}
                className="min-w-[120px]"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Ingesting...
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <UploadCloudIcon className="size-3.5" />
                    Ingest Document
                  </span>
                )}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
