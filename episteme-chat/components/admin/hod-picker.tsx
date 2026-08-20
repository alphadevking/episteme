// components/admin/hod-picker.tsx
// HOD assignment — searches existing staff/hod users OR accepts email.
// Used in the department detail page.
"use client";

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchIcon, UserCheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";

type UserResult = {
  id:         string;
  email:      string;
  first_name: string | null;
  last_name:  string | null;
  primary_role: string;
};

type Props = {
  departmentId:  string;
  institutionId: string;
  currentHod?:   { id: string; email: string; first_name: string | null; last_name: string | null } | null;
};

export function HODPicker({ departmentId, institutionId, currentHod }: Props) {
  const supabase    = createSupabaseBrowserClient();
  const router      = useRouter();

  const [mode,      setMode]      = useState<"search" | "email">("search");
  const [query,     setQuery]     = useState("");
  const [email,     setEmail]     = useState("");
  const [results,   setResults]   = useState<UserResult[]>([]);
  const [selected,  setSelected]  = useState<UserResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [success,   setSuccess]   = useState(false);

  // Debounce (mirrors filter-bar.tsx) + a request counter so a slow response
  // to an earlier keystroke can't overwrite a later, faster one.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeq   = useRef(0);

  // ── Search existing users in this institution ─────────────────────────
  // fn_search_hod_candidates (SECURITY DEFINER) does the eligibility check —
  // primary_role OR roles[] contains staff/hod/admin — and derives the
  // institution scope server-side via current_admin_institution_id(),
  // instead of trusting the institutionId prop. p_query is a bound SQL
  // parameter, not a hand-built PostgREST filter string, so there's no
  // filter-syntax escaping to get wrong.
  const runSearch = useCallback(async (q: string) => {
    const seq = ++searchSeq.current;
    setSearching(true);

    const { data, error: searchErr } = await supabase.rpc(
      "fn_search_hod_candidates",
      { p_query: q },
    );

    if (seq !== searchSeq.current) return; // a newer search superseded this one
    if (searchErr) { setError(searchErr.message); setSearching(false); return; }
    setResults((data as UserResult[]) ?? []);
    setSearching(false);
  }, [supabase]);

  const search = useCallback((q: string) => {
    setQuery(q);
    setSelected(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.length < 2) { setResults([]); return; }
    debounceRef.current = setTimeout(() => runSearch(q), 300);
  }, [runSearch]);

  // ── Assign HOD ────────────────────────────────────────────────────────
  // Two writes: fn_admin_set_user_role (SECURITY DEFINER — enforces caller
  // is admin/superadmin, same institution) grants the actual 'hod' role,
  // then departments.hod_user_id links them to this department. Without the
  // first call, fn_assert_active_hod() (the /hod route gate) still sees the
  // user's old role and keeps them out, even though the department shows
  // them as HOD — see provision-admin-form.tsx for the equivalent pattern
  // for admins, and user-actions.tsx for the same RPC used generically.
  const assign = async () => {
    setError(null);
    setSaving(true);

    let userId: string | null = null;

    if (mode === "search" && selected) {
      userId = selected.id;
    } else if (mode === "email" && email.trim()) {
      const { data } = await supabase
        .from("users")
        .select("id")
        .eq("email", email.trim())
        .eq("institution_id", institutionId)
        .maybeSingle();

      if (!data) {
        setError("No user found with that email in this institution.");
        setSaving(false);
        return;
      }
      userId = data.id;
    }

    if (!userId) {
      setError("Please select or enter a user.");
      setSaving(false);
      return;
    }

    const { error: roleErr } = await supabase.rpc("fn_admin_set_user_role", {
      p_target_user_id: userId,
      p_role: "hod",
    });

    if (roleErr) { setError(roleErr.message); setSaving(false); return; }

    const { error: err } = await supabase
      .from("departments")
      .update({ hod_user_id: userId })
      .eq("id", departmentId);

    setSaving(false);

    if (err) { setError(err.message); return; }

    setSuccess(true);
    setTimeout(() => {
      setSuccess(false);
      router.refresh();
    }, 1500);
  };

  // ── Clear HOD ─────────────────────────────────────────────────────────
  // Mirrors assign(): unlink the department AND step the user's role back
  // down. There's no dedicated "remove role" RPC — fn_admin_set_user_role
  // sets the role directly (see user-actions.tsx's role dropdown, which
  // includes 'hod' as one of several settable values) — so "demote to
  // staff" is the closest equivalent to what an admin would do by hand via
  // that dropdown. Without this, a removed HOD would keep hod-level access
  // (including the /hod portal and trust-4 retrieval) indefinitely.
  const clear = async () => {
    setSaving(true);

    if (currentHod) {
      await supabase.rpc("fn_admin_set_user_role", {
        p_target_user_id: currentHod.id,
        p_role: "staff",
      });
    }

    await supabase
      .from("departments")
      .update({ hod_user_id: null })
      .eq("id", departmentId);
    setSaving(false);
    router.refresh();
  };

  return (
    <div className="rounded-lg border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Head of Department (HOD)</h3>
        {currentHod && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground h-7"
            onClick={clear}
            disabled={saving}
          >
            Remove HOD
          </Button>
        )}
      </div>

      {/* Current HOD */}
      {currentHod && (
        <div className="flex items-center gap-3 rounded-md bg-muted/50 px-3 py-2.5">
          <UserCheckIcon className="size-4 text-primary shrink-0" />
          <div>
            <p className="text-sm font-medium">
              {[currentHod.first_name, currentHod.last_name].filter(Boolean).join(" ") || "—"}
            </p>
            <p className="text-xs text-muted-foreground">{currentHod.email}</p>
          </div>
        </div>
      )}

      {/* Mode tabs */}
      <div className="flex gap-1 rounded-md border p-1 bg-muted/30">
        {(["search", "email"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              if (debounceRef.current) clearTimeout(debounceRef.current);
              searchSeq.current++; // invalidate any in-flight search response
              setMode(m); setResults([]); setSelected(null); setQuery(""); setEmail("");
            }}
            className={[
              "flex-1 rounded py-1.5 text-xs font-medium transition-colors",
              mode === m
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {m === "search" ? "Search users" : "Enter email"}
          </button>
        ))}
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      {success && (
        <p className="text-xs text-success font-medium">HOD assigned successfully.</p>
      )}

      {/* Search mode */}
      {mode === "search" && (
        <div className="space-y-2">
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              className="pl-8 text-sm h-9"
              placeholder="Search by name or email…"
              value={query}
              onChange={(e) => search(e.target.value)}
            />
          </div>
          {searching && <p className="text-xs text-muted-foreground">Searching…</p>}
          {results.length > 0 && !selected && (
            <div className="max-h-40 overflow-y-auto rounded-md border divide-y text-sm">
              {results.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => { setSelected(u); setQuery([u.first_name, u.last_name].filter(Boolean).join(" ") || u.email); setResults([]); }}
                  className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/60 transition-colors text-left"
                >
                  <div>
                    <span className="font-medium">{[u.first_name, u.last_name].filter(Boolean).join(" ") || "—"}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{u.email}</span>
                  </div>
                  <span className="text-xs text-muted-foreground capitalize">{u.primary_role}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Email mode */}
      {mode === "email" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Staff email address</Label>
          <Input
            type="email"
            placeholder="staff@institution.edu"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-9 text-sm"
          />
        </div>
      )}

      <Button
        onClick={assign}
        disabled={saving || success || (mode === "search" ? !selected : !email.trim())}
        size="sm"
        className="w-full"
      >
        {saving ? "Assigning…" : success ? "Assigned!" : `Assign ${currentHod ? "new " : ""}HOD`}
      </Button>
    </div>
  );
}