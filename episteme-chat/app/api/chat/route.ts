// app/api/chat/route.ts
import { JSONSchema7, type UIMessage } from "ai";
import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
// Role → retrieval space and trust derivation live in a pure, unit-tested
// module. Both are derived from the verified `users` row only — never from the
// user-writable `user_ai_context` — and forwarded as trusted headers, never via
// the system prompt, so the model can neither see nor alter them.
import {
  RETRIEVAL_ROLE,
  resolveEffectiveRole,
  resolveRetrievalRoles,
  isPlatformAdmin,
  deriveTrustLevel,
} from "@/lib/session-derivation";

export const maxDuration = 30;

// ── Constants ─────────────────────────────────────────────────────────────────
const RATE_LIMIT_REQUESTS  = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
// Max messages sent to Mastra. Older messages are dropped — Mastra memory
// covers long-term recall via its own lastMessages window.
const MAX_MESSAGES_TO_MASTRA = 12;

// ── In-memory rate limiter ─────────────────────────────────────────────────
// Replace with Upstash Redis for multi-instance deployments.
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(userId: string): boolean {
  const now    = Date.now();
  const record = rateLimitMap.get(userId);
  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (record.count >= RATE_LIMIT_REQUESTS) return false;
  record.count++;
  return true;
}

// ── Message trimmer ────────────────────────────────────────────────────────
function trimMessages(messages: UIMessage[]): UIMessage[] {
  return messages.slice(-MAX_MESSAGES_TO_MASTRA);
}

// ── SSE chunk sanitizer ───────────────────────────────────────────────────
// Drops `data: {...}` frames whose JSON payload has no `type` field, which
// is what Mastra's internal metadata events (scorer results, memory
// title-gen) look like. Everything else — including the `data: [DONE]`
// sentinel and non-JSON lines — passes through byte-for-byte.
function shouldDropSseLine(line: string): boolean {
  if (!line.startsWith("data:")) return false;
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") return false;
  // Fail closed: the AI SDK stream protocol only ever carries `[DONE]` or a
  // JSON OBJECT with a string `type`. Anything else — an object missing type,
  // a bare string/number/null payload, or unparseable JSON — crashes the
  // client accumulator with "Unsupported chunk type: undefined", so drop it.
  try {
    const parsed: unknown = JSON.parse(payload);
    return !(
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { type?: unknown }).type === "string"
    );
  } catch {
    return true;
  }
}

function sseTypeFilterTransform(requestStart?: number, reqId?: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      // Keep the last, possibly-incomplete line in the buffer for next time.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      const kept = lines.filter((line) => !shouldDropSseLine(line));
      if (kept.length > 0) controller.enqueue(encoder.encode(kept.join("\n") + "\n"));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0 && !shouldDropSseLine(buffer)) {
        controller.enqueue(encoder.encode(buffer));
      }
      // Companion to the ttft log: total time until the upstream stream closed.
      // total_ms − ttft_ms − tool timings (Mastra terminal) = time spent in
      // model calls + memory/title-gen — the part a model change would affect.
      if (requestStart !== undefined) {
        // req_id joins this line to its ttft line. Without it the two
        // distributions can be summarized but never correlated, so "which
        // requests were slow to FIRST token AND slow overall" is unanswerable.
        console.log(JSON.stringify({
          event:    "stream_complete",
          req_id:   reqId,
          total_ms: Date.now() - requestStart,
        }));
      }
    },
  });
}

// ── System prompt builder ─────────────────────────────────────────────────
function buildSystem(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ").trim();
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClientReadOnly();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  if (!checkRateLimit(user.id)) {
    return Response.json({ error: "Too many requests. Please slow down." }, { status: 429 });
  }

  const { messages, tools }: {
    messages: UIMessage[];
    tools?: Record<string, { description?: string; parameters: JSONSchema7 }>;
  } = await req.json();

  let role   = "prospective";
  let system = "";

  // Trusted session values — forwarded to Mastra as headers (never in the
  // prompt). The chat-security middleware in episteme-core injects them into
  // the tools' request context, out of the model's reach.
  let trustLevel                     = 1;
  let institutionId: string | null   = null;
  let userPublicId:  string | null   = null;
  let parentAllowlist: string[] | null = null;
  // Full verified role set (access is their union) + the platform-operator bit
  // that RETRIEVAL_ROLE's admin→staff alias would otherwise discard.
  let retrievalRoles: string[]       = ["prospective"];
  let platformAdmin                  = false;

  try {
    const [profileResult] = await Promise.all([
      supabase
        .from("users")
        .select("id, primary_role, roles, status, institution_id")
        .eq("auth_id", user.id)
        .maybeSingle(),
    ]);
    const profile = profileResult.data;

    // Reject suspended/deactivated/archived accounts at the chat boundary.
    // active is the only status that should reach the AI.
    if (profile?.status && profile.status !== "active") {
      return Response.json({ error: "Account is not active." }, { status: 403 });
    }

    const rawRoles: string[] = (profile?.roles as string[]) ?? [];
    const primaryRole = profile?.primary_role ?? role;
    role = resolveEffectiveRole(primaryRole, rawRoles);
    // Access is the union of every verified role; `role` above stays the single
    // highest-priority one for display and for deriveTrustLevel.
    retrievalRoles = resolveRetrievalRoles(primaryRole, rawRoles);
    platformAdmin  = isPlatformAdmin(primaryRole, rawRoles);
    const roles = rawRoles;
    const isParent = role === "parent" || role === "guardian"
      || roles.includes("parent") || roles.includes("guardian");

    // Fetch AI context and (if parent) student link in parallel
    const [aiCtxResult, parentLinkResult] = await Promise.all([
      profile?.id
        ? supabase
            .from("user_ai_context")
            .select("role, institution, programme, level, preferences, trust_level, verified")
            .eq("user_id", profile.id)
            .maybeSingle()
        : Promise.resolve({ data: null }),

      (profile?.id && isParent)
        ? supabase
            .from("parent_student_links")
            .select("can_view_academic, can_view_fees, student_user_id, users:student_user_id(first_name, last_name)")
            .eq("parent_user_id", profile.id)
            .eq("verification_status", "verified")
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const aiCtx = aiCtxResult.data;
    const link  = parentLinkResult.data;

    // ── Parent context + namespace allowlist ──────────────────────────────
    // The allowlist is sent as a trusted header, never via the prompt.
    let parentCtx: string | null = null;

    if (isParent) {
      if (link?.student_user_id) {
        const u = (Array.isArray(link.users) ? link.users[0] : link.users) as
          { first_name: string | null; last_name: string | null } | null;
        const name = [u?.first_name, u?.last_name].filter(Boolean).join(" ") || "linked student";
        const perms = [
          link.can_view_academic ? "academic" : null,
          link.can_view_fees     ? "fees"     : null,
        ].filter(Boolean).join("+");
        parentCtx = `linked_student=${name} permissions=${perms || "none"}`;

        const allowedNs: string[] = ["admissions", "general"];
        if (link.can_view_fees)     allowedNs.push("financial-aid");
        if (link.can_view_academic) allowedNs.push("academic-policy", "programmes");
        parentAllowlist = allowedNs;
      } else {
        parentAllowlist = ["admissions", "general"];
      }
    }

    // Trusted values → headers. Personalization-only values → system prompt.
    // Trust is derived from the VERIFIED role (elevated → 4), never from the
    // user-writable aiCtx.trust_level. Role likewise stays the verified value
    // from resolveEffectiveRole above — aiCtx.role is display-only and must
    // never override it, or a user could self-promote via their own row.
    trustLevel    = deriveTrustLevel(role, aiCtx?.trust_level);
    institutionId = profile?.institution_id ?? null;
    userPublicId  = profile?.id ?? null;

    if (aiCtx) {
      const prefs      = (aiCtx.preferences as Record<string, string>) ?? {};
      const verbosity  = prefs.verbosity  ?? "concise";
      const department = prefs.department ?? null;
      const staffTitle = prefs.staffTitle ?? null;

      system = buildSystem([
        `role=${role}`,
        aiCtx.institution ? `institution=${aiCtx.institution}` : null,
        aiCtx.programme   ? `programme=${aiCtx.programme}`     : null,
        aiCtx.level       ? `level=${aiCtx.level}`             : null,
        department        ? `dept=${department}`               : null,
        staffTitle        ? `title=${staffTitle}`              : null,
        parentCtx,
        verbosity === "detailed" ? "verbosity=detailed" : null,
      ]);
    } else {
      system = buildSystem([
        `role=${role}`,
        parentCtx,
      ]);
    }
  } catch {
    // Fail closed: public tier, no institution, no user identity.
    trustLevel      = 1;
    institutionId   = null;
    userPublicId    = null;
    parentAllowlist = null;
    retrievalRoles  = ["prospective"];
    platformAdmin   = false;
    system = `role=${role}`;
  }

  const trimmed       = trimMessages(messages);
  const mastraBaseUrl = process.env.MASTRA_BASE_URL ?? "http://localhost:4111";
  const mastraAgentId = process.env.MASTRA_AGENT_ID ?? "episteme-chat-agent";
  const upstreamUrl   = `${mastraBaseUrl.replace(/\/$/, "")}/chat/${encodeURIComponent(mastraAgentId)}`;

  const adminKey = process.env.MASTRA_ADMIN_KEY;
  if (!adminKey) {
    console.error("MASTRA_ADMIN_KEY is not set — cannot authenticate to the Mastra chat endpoint.");
    return Response.json({ error: "Chat service is not configured." }, { status: 503 });
  }

  // Trusted session context — consumed by the chat-security middleware in
  // episteme-core, which injects it into the tools' request context. These
  // values never pass through the model.
  const upstreamHeaders: Record<string, string> = {
    "Content-Type":            "application/json",
    "x-episteme-admin-key":    adminKey,
    "x-episteme-role":         RETRIEVAL_ROLE[role] ?? "prospective",
    "x-episteme-roles":        retrievalRoles.join(","),
    "x-episteme-trust-level":  String(trustLevel),
  };
  // Only ever sent as the literal "true"; core compares strictly, so an absent
  // header is false rather than falsy-but-present.
  if (platformAdmin) upstreamHeaders["x-episteme-platform-admin"] = "true";
  if (institutionId)   upstreamHeaders["x-episteme-institution-id"]      = institutionId;
  if (userPublicId)    upstreamHeaders["x-episteme-user-public-id"]      = userPublicId;
  if (parentAllowlist) upstreamHeaders["x-episteme-namespace-allowlist"] = parentAllowlist.join(",");

  const requestStart = Date.now();
  // Correlates the ttft and stream_complete lines for this request. Consumed by
  // lib/telemetry/latency.ts; see `pnpm latency:report`.
  const reqId = crypto.randomUUID();

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method:  "POST",
      headers: upstreamHeaders,
      body:    JSON.stringify({ messages: trimmed, system, tools }),
    });
  } catch (e) {
    console.warn("Failed to reach Mastra backend:", e);
    return Response.json({ error: "Mastra backend is unreachable" }, { status: 503 });
  }

  if (!upstreamResponse.ok) {
    const ct      = upstreamResponse.headers.get("content-type") ?? "";
    const errBody = ct.includes("application/json")
      ? await upstreamResponse.json().catch(() => null)
      : await upstreamResponse.text().catch(() => "");

    // Mirror only what the CLIENT caused (4xx). An upstream fault is a bad
    // gateway, not a fault of this route — echoing 500 as 500 made an
    // episteme-core outage read as an episteme-chat bug in the Vercel dashboard
    // and cost a full diagnostic pass on 2026-08-01.
    const status = upstreamResponse.status >= 400 && upstreamResponse.status < 500
      ? upstreamResponse.status
      : 502;

    console.error(JSON.stringify({
      event:           "mastra_upstream_error",
      upstream_status: upstreamResponse.status,
      // episteme-core stamps 500s with a correlation id — the join key between
      // this log line and the stack in the core deployment's logs.
      correlation_id:  (errBody as { correlationId?: string } | null)?.correlationId ?? null,
      details:         errBody,
    }));

    return Response.json(
      { error: "Mastra backend error", status: upstreamResponse.status, details: errBody },
      { status },
    );
  }

  let firstChunkLogged = false;
  const ttftTransform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        const ttftMs = Date.now() - requestStart;
        console.log(JSON.stringify({
          event:        "ttft",
          req_id:       reqId,
          ttft_ms:      ttftMs,
          role,
          meets_nfr101: ttftMs < 2000,
        }));
      }
      controller.enqueue(chunk);
    },
  });

  // Mastra's chatRoute() emits internal metadata events (scorer results,
  // memory title-gen callbacks) as SSE `data:` frames whose JSON has no
  // `type` field. assistant-ui's stream accumulator has no case for that and
  // throws "Unsupported chunk type: undefined" — sometimes as an uncaught
  // render-time error, not a promise rejection, so a client-side try/catch
  // can't reliably intercept it. Drop those frames here, at the one place
  // that already owns this stream, so malformed chunks never reach the
  // client parser at all.
  const sanitizeTransform = sseTypeFilterTransform(requestStart, reqId);

  const instrumentedBody = upstreamResponse.body
    ? upstreamResponse.body.pipeThrough(ttftTransform).pipeThrough(sanitizeTransform)
    : null;

  const headers = new Headers(upstreamResponse.headers);
  headers.set("x-episteme-proxy", "mastra");
  return new Response(instrumentedBody, { status: upstreamResponse.status, headers });
}
