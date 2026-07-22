"use client";

import {
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  type ChangeEvent,
  type FormEvent,
  type DragEvent,
} from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { Button } from "@/components/ui/button";
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
  ArrowLeftIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LEVEL_OPTIONS } from "@/lib/constants/academic";
import { NAMESPACE_OPTIONS, CATEGORY_OPTIONS, CONTENT_TYPE_OPTIONS, ROLES, ROLE_LABELS } from "@/lib/constants/kb";
import { inputBase, selectBase, LabelledSelect, PillToggleGroup } from "@/components/admin/form-controls";

type InputMode = "file" | "markdown" | "plaintext";

// ── Scope types ───────────────────────────────────────────────────────────────
interface Institution { id: string; name: string; code: string }
interface Faculty     { id: string; name: string; code: string; institution_id: string }
interface Department  { id: string; name: string; code: string; faculty_id: string }
interface Program     { id: string; name: string; code: string; department_id: string }

// ── Pipeline progress ─────────────────────────────────────────────────────────
const PIPELINE_STEPS = ["extracting", "chunking", "embedding", "upserting", "saving"] as const;
type PipelineStep = typeof PIPELINE_STEPS[number];
type StepStatus   = "pending" | "active" | "done" | "error";

const STEP_LABEL: Record<PipelineStep, string> = {
  extracting: "Extracting text content",
  chunking:   "Building knowledge chunks",
  embedding:  "Generating embeddings",
  upserting:  "Indexing in knowledge base",
  saving:     "Saving document record",
};

const STEP_DESCRIPTION: Record<PipelineStep, string> = {
  extracting: "Parsing document structure",
  chunking:   "Splitting into parent / child chunks",
  embedding:  "Generating dense + sparse vectors",
  upserting:  "Writing vectors to Pinecone",
  saving:     "Persisting record to registry",
};

const INITIAL_STATUSES: Record<PipelineStep, StepStatus> =
  Object.fromEntries(PIPELINE_STEPS.map((s) => [s, "pending"])) as Record<PipelineStep, StepStatus>;

// ── Section heading ───────────────────────────────────────────────────────────
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

// ── Multi-select pill picker ──────────────────────────────────────────────────
function MultiPicker<T extends { id: string; name: string; code: string }>({
  label, items, selected, onToggle, placeholder, disabled, loading,
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
          disabled || loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:border-ring/40"
        }`}
      >
        {loading ? (
          <span className="text-muted-foreground/50 text-xs">Loading...</span>
        ) : selectedItems.length === 0 ? (
          <span className="text-muted-foreground/50">{placeholder ?? `Select ${label.toLowerCase()}...`}</span>
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

// ── Step icon ─────────────────────────────────────────────────────────────────
function StepIcon({ status }: { status: StepStatus }) {
  if (status === "done")
    return <CheckCircle2Icon className="size-5 shrink-0 text-primary" />;
  if (status === "error")
    return <XIcon className="size-5 shrink-0 text-destructive" />;
  if (status === "active")
    return (
      <span className="size-5 shrink-0 flex items-center justify-center">
        <span className="size-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </span>
    );
  return (
    <span className="size-5 shrink-0 flex items-center justify-center">
      <span className="size-2.5 rounded-full bg-border" />
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function IngestPage() {
  const router   = useRouter();
  const fileRef  = useRef<HTMLInputElement>(null);
  // Stable client — createSupabaseBrowserClient must not be called on every render.
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [submitting,   setSubmitting]   = useState(false);
  const [succeeded,    setSucceeded]    = useState(false);
  const [error,        setError]        = useState<string | null>(null);

  // uploading = before SSE starts (file upload + connection); streaming = SSE flowing
  const [phase,         setPhase]         = useState<"uploading" | "streaming">("uploading");
  const [elapsed,       setElapsed]       = useState(0);
  const [stepDurations, setStepDurations] = useState<Partial<Record<PipelineStep, number>>>({});
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeStepRef      = useRef<PipelineStep | null>(null);
  const stepStartRef       = useRef<number>(0);

  function startElapsedTimer() {
    stopElapsedTimer();
    setElapsed(0);
    elapsedIntervalRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
  }
  function stopElapsedTimer() {
    if (elapsedIntervalRef.current) { clearInterval(elapsedIntervalRef.current); elapsedIntervalRef.current = null; }
  }
  const [mode,         setMode]         = useState<InputMode>("file");
  const [dragging,     setDragging]     = useState(false);
  const [droppedFile,  setDroppedFile]  = useState<File | null>(null);

  // ── Scope state ──────────────────────────────────────────────────────────────
  const [isSuperadmin,     setIsSuperadmin]     = useState(false);
  const [adminInstitution, setAdminInstitution] = useState<Institution | null>(null);
  const [institutions,     setInstitutions]     = useState<Institution[]>([]);
  const [faculties,        setFaculties]        = useState<Faculty[]>([]);
  const [departments,      setDepartments]      = useState<Department[]>([]);
  const [programs,         setPrograms]         = useState<Program[]>([]);

  const [scopeLoading, setScopeLoading] = useState(true);
  const [facLoading,   setFacLoading]   = useState(false);
  const [deptLoading,  setDeptLoading]  = useState(false);
  const [progLoading,  setProgLoading]  = useState(false);

  const [selectedInstitution, setSelectedInstitution] = useState("");
  const [selectedFaculties,   setSelectedFaculties]   = useState<string[]>([]);
  const [selectedDepartments, setSelectedDepartments] = useState<string[]>([]);
  const [selectedPrograms,    setSelectedPrograms]    = useState<string[]>([]);

  const activeInstitutionId = isSuperadmin ? selectedInstitution : (adminInstitution?.id ?? "");

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
    levels:      [] as string[],
  });

  // ── Pipeline progress ────────────────────────────────────────────────────────
  const [stepStatuses, setStepStatuses] = useState<Record<PipelineStep, StepStatus>>(INITIAL_STATUSES);
  const [stepDetails,  setStepDetails]  = useState<Partial<Record<PipelineStep, string>>>({});

  function field(key: keyof typeof form) {
    return (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  function toggleRole(role: string) {
    setForm((f) => ({
      ...f,
      roles: f.roles.includes(role) ? f.roles.filter((r) => r !== role) : [...f.roles, role],
    }));
  }

  function toggleLevel(level: string) {
    setForm((f) => ({
      ...f,
      levels: f.levels.includes(level) ? f.levels.filter((l) => l !== level) : [...f.levels, level],
    }));
  }

  // ── Load admin user on mount ─────────────────────────────────────────────────
  useEffect(() => {
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
        const { data: insts } = await supabase
          .from("institutions")
          .select("id, name, code")
          .eq("is_active", true)
          .order("name");
        setInstitutions((insts ?? []) as Institution[]);
      } else {
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
  }, []);

  // ── Cascade: faculties ────────────────────────────────────────────────────────
  useEffect(() => {
    setSelectedFaculties([]); setFaculties([]);
    setSelectedDepartments([]); setDepartments([]);
    setSelectedPrograms([]); setPrograms([]);
    if (!activeInstitutionId) return;
    setFacLoading(true);
    supabase.from("faculties").select("id, name, code, institution_id")
      .eq("institution_id", activeInstitutionId).eq("is_active", true).order("name")
      .then(({ data }) => { setFaculties((data ?? []) as Faculty[]); setFacLoading(false); });
  }, [activeInstitutionId]);

  // ── Cascade: departments ──────────────────────────────────────────────────────
  useEffect(() => {
    setSelectedDepartments([]); setDepartments([]);
    setSelectedPrograms([]); setPrograms([]);
    if (selectedFaculties.length === 0) return;
    setDeptLoading(true);
    supabase.from("departments").select("id, name, code, faculty_id")
      .in("faculty_id", selectedFaculties).eq("is_active", true).order("name")
      .then(({ data }) => { setDepartments((data ?? []) as Department[]); setDeptLoading(false); });
  }, [selectedFaculties]);

  // ── Cascade: programs ─────────────────────────────────────────────────────────
  useEffect(() => {
    setSelectedPrograms([]); setPrograms([]);
    if (selectedDepartments.length === 0) return;
    setProgLoading(true);
    supabase.from("programs").select("id, name, code, department_id")
      .in("department_id", selectedDepartments).eq("is_active", true).order("name")
      .then(({ data }) => { setPrograms((data ?? []) as Program[]); setProgLoading(false); });
  }, [selectedDepartments]);

  function toggleMulti(id: string, setter: React.Dispatch<React.SetStateAction<string[]>>) {
    setter((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  // ── Doc ID generation ─────────────────────────────────────────────────────────
  async function generateDocId(file: File): Promise<string> {
    const instCode = (
      isSuperadmin
        ? institutions.find((i) => i.id === selectedInstitution)?.code
        : adminInstitution?.code
    )?.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

    const fileSlug = file.name
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");

    const base = [instCode, fileSlug].filter(Boolean).join("-");

    const { data } = await supabase
      .from("kb_document_sources")
      .select("doc_id")
      .like("doc_id", `${base}-%`);

    const counters = (data ?? [])
      .map((r) => { const m = (r.doc_id as string).match(/-(\d+)$/); return m ? parseInt(m[1], 10) : 0; })
      .filter((n) => !isNaN(n));

    const next = counters.length > 0 ? Math.max(...counters) + 1 : 1;
    return `${base}-${String(next).padStart(3, "0")}`;
  }

  const acceptFile = useCallback(async (file: File) => {
    setDroppedFile(file);
    setForm((f) => ({ ...f, fileName: f.fileName || file.name }));
    const docId = await generateDocId(file);
    setForm((f) => ({ ...f, docId: f.docId || docId }));
  }, [adminInstitution, isSuperadmin, institutions, selectedInstitution, supabase]);

  function onDragOver(e: DragEvent) { e.preventDefault(); setDragging(true); }
  function onDragLeave()            { setDragging(false); }
  function onDrop(e: DragEvent) {
    e.preventDefault(); setDragging(false);
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
    setSubmitting(true);
    setPhase("uploading");
    setStepStatuses(INITIAL_STATUSES);
    setStepDetails({});
    setStepDurations({});
    setElapsed(0);
    activeStepRef.current = null;
    stepStartRef.current  = 0;

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
        scopeMeta.facultyNames = faculties.filter((f) => selectedFaculties.includes(f.id)).map((f) => f.name);
      }
      if (selectedDepartments.length > 0) {
        scopeMeta.departmentIds   = selectedDepartments;
        scopeMeta.departmentNames = departments.filter((d) => selectedDepartments.includes(d.id)).map((d) => d.name);
      }
      if (selectedPrograms.length > 0) {
        scopeMeta.programIds   = selectedPrograms;
        scopeMeta.programNames = programs.filter((p) => selectedPrograms.includes(p.id)).map((p) => p.name);
      }

      const facultyLabel = selectedFaculties.length > 0
        ? (faculties.find((f) => f.id === selectedFaculties[0])?.name ?? "")
        : "";

      const selectedProgramObjs = programs.filter((p) => selectedPrograms.includes(p.id));
      const programmeValue = selectedProgramObjs.length === 1
        ? `${selectedProgramObjs[0].name} (${selectedProgramObjs[0].code})`
        : undefined;

      const body: Record<string, unknown> = {
        docId:       form.docId,
        fileName:    form.fileName,
        namespace:   form.namespace,
        category:    form.category,
        contentType: form.contentType,
        faculty:     facultyLabel,
        source:      form.source,
        roles:       form.roles,
        updatedAt:   new Date(form.updatedAt).toISOString(),
        scope:       scopeMeta,
        ...(programmeValue      ? { programme: programmeValue } : {}),
        ...(form.levels.length > 0 ? { levels: form.levels }    : {}),
      };

      if (mode === "file") {
        const file = droppedFile ?? fileRef.current?.files?.[0];
        if (!file) { setError("Please select or drop a file."); setSubmitting(false); return; }
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

      const res = await fetch("/api/admin/kb", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });

      if (!res.headers.get("content-type")?.includes("text/event-stream")) {
        const data = await res.json() as { error?: string };
        setError(data.error ?? "Ingestion failed.");
        setSubmitting(false);
        return;
      }

      // SSE confirmed — transition from uploading to the live stepper
      setPhase("streaming");
      setStepStatuses((prev) => ({ ...prev, extracting: "active" }));
      activeStepRef.current = "extracting";
      stepStartRef.current  = Date.now();
      startElapsedTimer();

      const reader  = res.body!.getReader();
      const decoder = new TextDecoder();
      let   buffer  = "";

      function applyProgress(data: Record<string, unknown>) {
        const step = data.step as PipelineStep;
        const idx  = PIPELINE_STEPS.indexOf(step);
        if (idx === -1) return;

        const now = Date.now();

        // Record duration for the step that just finished
        if (activeStepRef.current && activeStepRef.current !== step && stepStartRef.current > 0) {
          const prev = activeStepRef.current;
          const secs = (now - stepStartRef.current) / 1000;
          setStepDurations((d) => ({ ...d, [prev]: secs }));
        }

        activeStepRef.current = step;
        stepStartRef.current  = now;
        startElapsedTimer();

        setStepStatuses((prev) => {
          const next = { ...prev };
          PIPELINE_STEPS.forEach((s, i) => {
            next[s] = i < idx ? "done" : i === idx ? "active" : "pending";
          });
          return next;
        });
        if (step === "embedding" && typeof data.parents === "number") {
          setStepDetails((d) => ({ ...d, chunking: `${data.parents} parents · ${data.children} children` }));
        }
        if (step === "upserting" && typeof data.chunks === "number") {
          setStepDetails((d) => ({ ...d, embedding: `${data.chunks} chunks embedded` }));
        }
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const evtMatch  = block.match(/^event: (\w+)/m);
          const dataMatch = block.match(/^data: (.+)/m);
          if (!evtMatch || !dataMatch) continue;
          const eventType = evtMatch[1];
          const payload   = JSON.parse(dataMatch[1]) as Record<string, unknown>;
          if (eventType === "progress") {
            applyProgress(payload);
          } else if (eventType === "done") {
            stopElapsedTimer();
            // Record duration for the last active step
            if (activeStepRef.current && stepStartRef.current > 0) {
              const last = activeStepRef.current;
              const secs = (Date.now() - stepStartRef.current) / 1000;
              setStepDurations((d) => ({ ...d, [last]: secs }));
            }
            setStepStatuses(Object.fromEntries(PIPELINE_STEPS.map((s) => [s, "done"])) as Record<PipelineStep, StepStatus>);
            setSucceeded(true);
            setTimeout(() => router.push("/admin/knowledge"), 2000);
          } else if (eventType === "error") {
            stopElapsedTimer();
            setError((payload.error as string) ?? "Ingestion failed.");
            setStepStatuses((prev) => {
              const active = PIPELINE_STEPS.find((s) => prev[s] === "active");
              if (!active) return prev;
              return { ...prev, [active]: "error" };
            });
            setSubmitting(false);
            return;
          }
        }
      }
    } catch (err) {
      stopElapsedTimer();
      setError(String(err));
      setSubmitting(false);
    }
  }

  // ── Scope summary ─────────────────────────────────────────────────────────────
  const resolvedInstName = isSuperadmin
    ? (institutions.find((i) => i.id === selectedInstitution)?.name ?? null)
    : (adminInstitution?.name ?? null);

  const scopeSummary = [
    resolvedInstName,
    selectedFaculties.length > 0 ? `${selectedFaculties.length} ${selectedFaculties.length === 1 ? "faculty" : "faculties"}` : null,
    selectedDepartments.length > 0 ? `${selectedDepartments.length} dept${selectedDepartments.length > 1 ? "s" : ""}` : null,
    selectedPrograms.length > 0 ? `${selectedPrograms.length} program${selectedPrograms.length > 1 ? "s" : ""}` : null,
  ].filter(Boolean).join(" › ");

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-5xl mx-auto space-y-6">

      {/* ── Page header ── */}
      <div className="flex items-center gap-4">
        <Link
          href="/admin/knowledge"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeftIcon className="size-3.5" />
          Knowledge Base
        </Link>
        <span className="text-border">/</span>
        <span className="text-sm font-medium">Ingest Document</span>
      </div>

      <div>
        <h1 className="text-xl font-semibold tracking-tight">Ingest Document</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Add content to the knowledge base for AI retrieval.
        </p>
      </div>

      {/* ── Success state ── */}
      {succeeded ? (
        <div className="flex flex-col items-center justify-center gap-4 py-24 rounded-xl border bg-card">
          <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 ring-4 ring-primary/5">
            <CheckCircle2Icon className="size-7 text-primary" />
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold">Document ingested</p>
            <p className="text-xs text-muted-foreground mt-1">Returning to knowledge base...</p>
          </div>
        </div>

      ) : submitting ? (
        /* ── Pipeline progress ── */
        <div className="rounded-xl border bg-card overflow-hidden">

          {/* Progress bar — steps completed / total */}
          {phase === "streaming" && (() => {
            const done = PIPELINE_STEPS.filter((s) => stepStatuses[s] === "done").length;
            const pct  = Math.round((done / PIPELINE_STEPS.length) * 100);
            return (
              <div className="h-0.5 bg-border w-full">
                <div
                  className="h-full bg-primary transition-all duration-700 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
            );
          })()}

          <div className="px-8 py-10 space-y-8">

            {/* ── Uploading phase ── */}
            {phase === "uploading" ? (
              <div className="flex flex-col items-center gap-5 py-4">
                <div className="relative flex size-14 items-center justify-center">
                  <span className="absolute inset-0 rounded-full bg-primary/10 animate-ping opacity-60" />
                  <span className="relative flex size-10 items-center justify-center rounded-full bg-primary/10">
                    <UploadCloudIcon className="size-5 text-primary" />
                  </span>
                </div>
                <div className="text-center space-y-1">
                  <p className="text-sm font-semibold">Uploading and connecting&hellip;</p>
                  <p className="text-xs text-muted-foreground">Sending document to the ingestion pipeline.</p>
                </div>
                {/* Skeleton stepper — shows what's coming */}
                <div className="mt-2 max-w-xs w-full space-y-4 opacity-30">
                  {PIPELINE_STEPS.map((step) => (
                    <div key={step} className="flex items-center gap-3">
                      <span className="size-2.5 rounded-full bg-border shrink-0" />
                      <span className="text-xs text-muted-foreground">{STEP_LABEL[step]}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              /* ── Streaming phase ── */
              <>
                <div className="text-center space-y-1">
                  <p className="text-sm font-semibold">Ingesting document</p>
                  <p className="text-xs text-muted-foreground">This may take a minute for large files.</p>
                </div>

                <div className="max-w-sm mx-auto space-y-0">
                  {PIPELINE_STEPS.map((step, i) => {
                    const status  = stepStatuses[step];
                    const isLast  = i === PIPELINE_STEPS.length - 1;
                    const dur     = stepDurations[step];
                    const isActive = status === "active";
                    return (
                      <div key={step} className="relative flex items-start gap-4">
                        {/* Connector line */}
                        {!isLast && (
                          <div className={`absolute left-[9px] top-5 w-px h-10 transition-colors duration-500 ${
                            status === "done" ? "bg-primary/50" : "bg-border"
                          }`} />
                        )}
                        <div className="shrink-0 mt-0.5">
                          <StepIcon status={status} />
                        </div>
                        <div className="flex-1 min-w-0 pb-6">
                          <div className="flex items-baseline gap-2">
                            <p className={`text-sm font-medium leading-none transition-colors ${
                              status === "pending" ? "text-muted-foreground/60" : "text-foreground"
                            }`}>
                              {STEP_LABEL[step]}
                            </p>
                            {/* Active: live elapsed counter */}
                            {isActive && (
                              <span className="text-[11px] tabular-nums text-primary font-mono">
                                {elapsed}s
                              </span>
                            )}
                            {/* Done: duration badge */}
                            {status === "done" && dur !== undefined && (
                              <span className="text-[11px] tabular-nums text-muted-foreground font-mono">
                                {dur < 1 ? `${Math.round(dur * 1000)}ms` : `${dur.toFixed(1)}s`}
                              </span>
                            )}
                          </div>
                          {/* Step description (always shown when not pending) */}
                          {status !== "pending" && (
                            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                              {stepDetails[step] ?? STEP_DESCRIPTION[step]}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {error && (
              <div className="max-w-sm mx-auto flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-3">
                <XIcon className="size-3.5 text-destructive shrink-0 mt-0.5" />
                <div className="flex-1 space-y-2">
                  <p className="text-xs text-destructive leading-snug">{error}</p>
                  <button
                    type="button"
                    onClick={() => { stopElapsedTimer(); setSubmitting(false); setError(null); setStepStatuses(INITIAL_STATUSES); setStepDetails({}); setStepDurations({}); }}
                    className="text-xs text-destructive underline underline-offset-2"
                  >
                    Try again
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

      ) : (
        /* ── Form ── */
        <form onSubmit={handleSubmit}>
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">

            {/* ── Left column: content + identity + classification + access ── */}
            <div className="space-y-6">

              {/* Content */}
              <div className="rounded-xl border bg-card px-6 py-5 space-y-4">
                <SectionHeading icon={UploadCloudIcon} label="Content" />

                {/* Mode tabs */}
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

                {mode === "file" ? (
                  <div
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    onDrop={onDrop}
                    onClick={() => !droppedFile && fileRef.current?.click()}
                    className={`relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors cursor-pointer ${
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
                          <p className="text-sm font-medium">{droppedFile.name}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{(droppedFile.size / 1024).toFixed(0)} KB</p>
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
                          <p className="text-sm font-medium">{dragging ? "Drop to upload" : "Drop file here or click to browse"}</p>
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
                      rows={8}
                      required
                      placeholder={
                        mode === "markdown"
                          ? "# Document Title\n\nPaste markdown content here..."
                          : "Paste announcement, policy, or general information..."
                      }
                      className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm font-mono resize-y placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring transition-colors"
                    />
                  </div>
                )}
              </div>

              {/* Identity */}
              <div className="rounded-xl border bg-card px-6 py-5 space-y-4">
                <SectionHeading icon={FolderIcon} label="Identity" />
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      File Name <span className="text-destructive">*</span>
                    </Label>
                    <Input value={form.fileName} onChange={field("fileName")} placeholder="admissions-policy.pdf" required className={inputBase} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      Doc ID <span className="text-muted-foreground font-normal">(from filename — editable)</span>
                    </Label>
                    <Input value={form.docId} onChange={field("docId")} placeholder="uniben-admissions-001" required className={inputBase} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium flex items-center gap-1.5">
                    <LinkIcon className="size-3 text-muted-foreground" />
                    Source URL / Reference <span className="text-destructive">*</span>
                  </Label>
                  <Input value={form.source} onChange={field("source")} placeholder="https://university.edu/admissions" required className={inputBase} />
                </div>
              </div>

              {/* Classification */}
              <div className="rounded-xl border bg-card px-6 py-5 space-y-4">
                <SectionHeading icon={TagIcon} label="Classification" />
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Namespace <span className="text-destructive">*</span></Label>
                    <LabelledSelect value={form.namespace} onChange={field("namespace")} options={NAMESPACE_OPTIONS} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Category <span className="text-destructive">*</span></Label>
                    <LabelledSelect value={form.category} onChange={field("category")} options={CATEGORY_OPTIONS} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Content Type</Label>
                    <LabelledSelect value={form.contentType} onChange={field("contentType")} options={CONTENT_TYPE_OPTIONS} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      Document Date{" "}
                      <span className="text-muted-foreground font-normal">(the content&rsquo;s own date — drives the &ldquo;may be outdated&rdquo; signal)</span>
                    </Label>
                    <Input type="date" value={form.updatedAt} onChange={field("updatedAt")} className={inputBase} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">
                    Level Scope <span className="text-muted-foreground font-normal">(select all that apply — leave blank for all levels)</span>
                  </Label>
                  <PillToggleGroup options={LEVEL_OPTIONS} selected={form.levels} onToggle={toggleLevel} />
                </div>
              </div>

              {/* Access */}
              <div className="rounded-xl border bg-card px-6 py-5 space-y-4">
                <SectionHeading icon={ShieldIcon} label="Access" />
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Visible to Roles <span className="text-destructive">*</span></Label>
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

            {/* ── Right column: scope ── */}
            <div className="space-y-4 lg:sticky lg:top-6">
              <div className="rounded-xl border bg-card px-6 py-5 space-y-4">
                <SectionHeading icon={BuildingIcon} label="Scope" />

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Institution</Label>
                  {scopeLoading ? (
                    <div className={`${inputBase} flex items-center text-muted-foreground/50 text-xs`}>Resolving...</div>
                  ) : isSuperadmin ? (
                    <>
                      <div className="relative">
                        <select value={selectedInstitution} onChange={(e) => setSelectedInstitution(e.target.value)} className={selectBase}>
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
                      <span className="text-sm">{adminInstitution?.name ?? "Unknown institution"}</span>
                      {adminInstitution?.code && (
                        <span className="ml-auto text-xs font-mono text-muted-foreground">{adminInstitution.code}</span>
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
                  placeholder={selectedFaculties.length === 0 ? "Select faculties first" : "All departments"}
                  disabled={selectedFaculties.length === 0}
                  loading={deptLoading}
                />
                <MultiPicker
                  label="Programs"
                  items={programs}
                  selected={selectedPrograms}
                  onToggle={(id) => toggleMulti(id, setSelectedPrograms)}
                  placeholder={selectedDepartments.length === 0 ? "Select departments first" : "All programs"}
                  disabled={selectedDepartments.length === 0}
                  loading={progLoading}
                />

                {scopeSummary && (
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                    <LayersIcon className="size-3.5 text-muted-foreground shrink-0" />
                    <p className="text-xs text-muted-foreground">
                      Scoped to: <span className="font-medium text-foreground">{scopeSummary}</span>
                    </p>
                  </div>
                )}
              </div>

              {/* Submit */}
              <div className="flex gap-3">
                <Button type="button" variant="outline" className="flex-1" onClick={() => router.push("/admin/knowledge")}>
                  Cancel
                </Button>
                <Button type="submit" className="flex-1" disabled={form.roles.length === 0}>
                  <UploadCloudIcon className="size-3.5 mr-1.5" />
                  Ingest Document
                </Button>
              </div>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
