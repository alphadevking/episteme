// app/api/account/avatar/route.ts
// POST   — upload a new avatar
// DELETE — remove the current one
//
// The upload goes through this route rather than straight from the browser so
// the bytes can be inspected before they land. Storage enforces the size and
// MIME limits too (set on the bucket), so a client that bypasses this route is
// still constrained — but `Content-Type` on a multipart part is chosen by the
// caller, so it is checked against the file's actual magic bytes here.
//
// The object path is always `<auth uid>/…`, which is what the bucket's RLS
// policies key on: a user can only ever write inside their own folder.
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

const MAX_BYTES = 2 * 1024 * 1024; // keep in step with the bucket's file_size_limit

type ImageKind = { mime: string; ext: string };

/**
 * Identify an image from its leading bytes.
 *
 * Returns null for anything unrecognised, which is what makes this a whitelist
 * rather than a filter: a renamed .svg or .html — the usual vector for stored
 * XSS through an avatar — matches nothing and is rejected.
 */
function sniffImage(bytes: Uint8Array): ImageKind | null {
  const startsWith = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);

  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return { mime: "image/png", ext: "png" };
  }
  if (startsWith(0xff, 0xd8, 0xff)) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  // RIFF....WEBP
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

/** Best-effort removal of the caller's other avatar objects. */
async function pruneOldAvatars(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  authId: string,
  keep: string | null,
) {
  const { data: existing } = await supabase.storage.from("avatars").list(authId);
  const stale = (existing ?? [])
    .map((o) => `${authId}/${o.name}`)
    .filter((path) => path !== keep);

  if (stale.length > 0) {
    await supabase.storage.from("avatars").remove(stale);
  }
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart upload." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Images must be 2 MB or smaller." }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind  = sniffImage(bytes);
  if (!kind) {
    return NextResponse.json(
      { error: "That doesn't look like a PNG, JPEG or WebP image." },
      { status: 415 },
    );
  }

  // Unique name so a cached CDN copy of the previous avatar is never served in
  // place of the new one. The old objects are pruned below.
  const path = `${user.id}/${crypto.randomUUID()}.${kind.ext}`;

  const { error: uploadError } = await supabase.storage
    .from("avatars")
    .upload(path, bytes, { contentType: kind.mime, upsert: false });

  if (uploadError) {
    console.error("[account/avatar] upload failed:", uploadError.message);
    return NextResponse.json({ error: "Could not upload that image." }, { status: 500 });
  }

  const { data: { publicUrl } } = supabase.storage.from("avatars").getPublicUrl(path);

  // fn_set_my_avatar re-validates that the URL points into this bucket, so a
  // forged value cannot reach the column even if it skipped this route.
  const { error: rpcError } = await supabase.rpc("fn_set_my_avatar", { p_url: publicUrl });

  if (rpcError) {
    console.error("[account/avatar] set failed:", rpcError.message);
    // Don't leave an orphan behind if the column write failed.
    await supabase.storage.from("avatars").remove([path]);
    return NextResponse.json({ error: "Could not save that image." }, { status: 500 });
  }

  await pruneOldAvatars(supabase, user.id, path);

  return NextResponse.json({ ok: true, avatarUrl: publicUrl });
}

export async function DELETE() {
  const supabase = await createSupabaseServerClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Clear the column first: an orphaned object is harmless, a URL pointing at a
  // deleted object renders as a broken image.
  const { error } = await supabase.rpc("fn_set_my_avatar", {
    p_url: null as unknown as string,
  });

  if (error) {
    console.error("[account/avatar] clear failed:", error.message);
    return NextResponse.json({ error: "Could not remove the image." }, { status: 500 });
  }

  await pruneOldAvatars(supabase, user.id, null);

  return NextResponse.json({ ok: true, avatarUrl: null });
}
