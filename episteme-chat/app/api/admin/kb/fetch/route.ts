// app/api/admin/kb/fetch/route.ts
// Phase 1 of a harvest: prove a URL resolves and survives cleaning, without
// spending an Unstructured call or writing anything.
//
// This is a thin proxy to core's POST /kb/fetch. It grants strictly less than
// POST /api/admin/kb, which already performs exactly this fetch behind exactly
// this admin gate — the only difference being that it ingests the result
// instead of measuring it. No new capability, only a cheaper shape of one.
//
// The URL allowlist, the Cloudflare proxy secret, the 15s timeout, and the 5MB
// cap all stay in core. Nothing here can widen any of them.

import { assertKbAdmin, kbAdminHeaders, mastraBaseUrl } from "@/lib/admin/kb-auth";
import { isThin, textLengthOf } from "@/lib/harvest/gate";

// One page through the Cloudflare proxy, with core's own 15s ceiling on it.
export const maxDuration = 60;

export async function POST(req: Request) {
  let body: { url?: unknown; scope?: { institutionId?: string | null } };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { error, institutionId } = await assertKbAdmin(body.scope?.institutionId);
  if (error) return error;

  const url = body.url;
  if (typeof url !== "string" || !url.trim()) {
    return Response.json({ error: "Missing required field: url" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${mastraBaseUrl()}/kb/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...kbAdminHeaders(institutionId) },
      body: JSON.stringify({ url }),
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 503 });
  }

  const data = (await res.json()) as { url?: string; contentHash?: string; html?: string; error?: string };
  if (!res.ok || typeof data.html !== "string") {
    return Response.json({ error: data.error ?? `Upstream returned HTTP ${res.status}` }, { status: res.status === 200 ? 502 : res.status });
  }

  // Measure here and drop the body. Validating a 26-page manifest would
  // otherwise ship megabytes of markup to a browser that only needs to know
  // whether cleaning left any prose behind.
  const textLength = textLengthOf(data.html);

  return Response.json({
    url: data.url ?? url,
    contentHash: data.contentHash ?? null,
    textLength,
    thin: isThin(textLength),
  });
}
