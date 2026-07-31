"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Loader2Icon, TagIcon, ShieldIcon, LayersIcon, CalendarIcon } from "lucide-react";
import { LabelledSelect, PillToggleGroup, inputBase } from "@/components/admin/form-controls";
import { CATEGORY_OPTIONS, CONTENT_TYPE_OPTIONS, ROLES, ROLE_LABELS } from "@/lib/constants/kb";
import { LEVEL_OPTIONS } from "@/lib/constants/academic";
import type { KbDocument } from "@/lib/types/kb";

type Props = {
  doc: KbDocument;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
};

export function EditScopeDialog({ doc, open, onOpenChange, onSaved }: Props) {
  const [roles,       setRoles]       = useState<string[]>(doc.roles);
  const [levels,      setLevels]      = useState<string[]>(doc.levels);
  const [programme,   setProgramme]   = useState(doc.programme ?? "");
  const [category,    setCategory]    = useState(doc.category);
  const [contentType, setContentType] = useState(doc.contentType);
  // Content date drives the freshness signal. <input type="date"> needs YYYY-MM-DD.
  // A document may be genuinely undated, in which case the field starts empty.
  const originalDate = doc.updatedAt?.split("T")[0] ?? "";
  const [docDate,     setDocDate]     = useState(originalDate);

  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  const levelsCleared    = doc.levels.length > 0 && levels.length === 0;
  const programmeCleared = !!doc.programme && programme.trim() === "";
  // Same Pinecone limitation as levels/programme: a metadata patch merges keys
  // and cannot remove one, so a dated document cannot be returned to undated
  // here. Blocked explicitly rather than silently ignored — the admin would
  // otherwise clear the field, save, and see the old date reappear.
  const dateCleared      = !!doc.updatedAt && docDate.trim() === "";
  const canSave = roles.length > 0 && !levelsCleared && !programmeCleared && !dateCleared && !saving;

  function toggleRole(role: string) {
    setRoles((r) => (r.includes(role) ? r.filter((x) => x !== role) : [...r, role]));
  }
  function toggleLevel(level: string) {
    setLevels((l) => (l.includes(level) ? l.filter((x) => x !== level) : [...l, level]));
  }

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        roles,
        category,
        contentType,
      };
      // Content date — only send when it's a valid date and actually changed,
      // so an untouched field is a no-op. Setting a date on a previously
      // undated document is allowed (undated -> dated); the reverse is blocked
      // above by dateCleared.
      if (docDate && docDate !== originalDate) {
        body.updatedAt = new Date(docDate).toISOString();
      }
      // Levels/programme can only be widened or changed here, never cleared to
      // empty (Pinecone metadata patch can't remove a key) — omit when unchanged
      // from an already-unscoped state, so an untouched blank field is a no-op
      // rather than triggering the backend's "cannot clear" rejection.
      if (levels.length > 0) body.levels = levels;
      if (programme.trim()) body.programme = programme.trim();

      const res = await fetch(`/api/admin/kb/${encodeURIComponent(doc.docId)}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setError(data.error ?? "Failed to update scope.");
        setSaving(false);
        return;
      }

      toast.success(`Updated scope for "${doc.fileName}".`);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Scope</DialogTitle>
          <DialogDescription>
            Updates tags on <span className="font-mono">{doc.fileName}</span> in place — no re-extraction
            or re-embedding. To reprocess the document&rsquo;s content, use Re-ingest instead.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium flex items-center gap-1.5">
                <TagIcon className="size-3 text-muted-foreground" /> Category
              </Label>
              <LabelledSelect value={category} onChange={(e) => setCategory(e.target.value)} options={CATEGORY_OPTIONS} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Content Type</Label>
              <LabelledSelect value={contentType} onChange={(e) => setContentType(e.target.value)} options={CONTENT_TYPE_OPTIONS} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium flex items-center gap-1.5">
              <CalendarIcon className="size-3 text-muted-foreground" /> Document Date
              <span className="text-muted-foreground font-normal">(content&rsquo;s own date — drives the &ldquo;may be outdated&rdquo; signal)</span>
            </Label>
            <Input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} className={inputBase} />
            {!doc.updatedAt && !docDate && (
              <p className="text-[11px] text-muted-foreground">
                This source is undated — its age is unknown, so it carries no &ldquo;may be
                outdated&rdquo; warning. Set a date only if you know the content&rsquo;s own date.
              </p>
            )}
            {dateCleared && (
              <p className="text-[11px] text-destructive">
                Clearing an existing document date isn&rsquo;t supported here — restore a value, or use Re-ingest to make it undated.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              Programme <span className="text-muted-foreground font-normal">(cannot be cleared here — use Re-ingest)</span>
            </Label>
            <Input
              value={programme}
              onChange={(e) => setProgramme(e.target.value)}
              placeholder="e.g. Computer Science (leave blank if not currently scoped)"
              className={inputBase}
            />
            {programmeCleared && (
              <p className="text-[11px] text-destructive">
                Clearing an existing programme scope isn&rsquo;t supported here — restore a value, or use Re-ingest to unscope it.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium flex items-center gap-1.5">
              <LayersIcon className="size-3 text-muted-foreground" /> Level Scope
              <span className="text-muted-foreground font-normal">(select all that apply)</span>
            </Label>
            <PillToggleGroup options={LEVEL_OPTIONS} selected={levels} onToggle={toggleLevel} />
            {levelsCleared && (
              <p className="text-[11px] text-destructive">
                Clearing all levels back to &ldquo;all levels&rdquo; isn&rsquo;t supported here — select at least one, or use Re-ingest.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium flex items-center gap-1.5">
              <ShieldIcon className="size-3 text-muted-foreground" /> Visible to Roles
            </Label>
            <PillToggleGroup options={ROLES} selected={roles} onToggle={toggleRole} labels={ROLE_LABELS} />
            {roles.length === 0 && (
              <p className="text-[11px] text-destructive">Select at least one role.</p>
            )}
          </div>

          {error && (
            <p className="text-xs text-destructive leading-snug">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving && <Loader2Icon className="size-3.5 mr-1.5 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
