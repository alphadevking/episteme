import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/types/database";

type CookieMode = "read-only" | "read-write";

async function createClientWithCookieMode(mode: CookieMode) {
  const cookieStore = await cookies();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  }

  if (!supabaseAnonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  // The <Database> generic is load-bearing: it is what makes server-side
  // `.from()` and `.rpc()` type-checked. Without it a typo'd column or function
  // name compiles cleanly and fails only at runtime — which is exactly how a
  // now-deleted /api/threads route came to read and write a `parts` column that
  // has never existed on `thread_messages`, unnoticed because nothing called it.
  // Keep the generic. The browser client (lib/supabase/browser.ts) has always
  // carried it; this one had drifted.
  return createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        if (mode === "read-only") return;

        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options);
        }
      },
    },
  });
}

export async function createSupabaseServerClientReadOnly() {
  return createClientWithCookieMode("read-only");
}

export async function createSupabaseServerClient() {
  return createClientWithCookieMode("read-write");
}
