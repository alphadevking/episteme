import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

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

  return createServerClient(supabaseUrl, supabaseAnonKey, {
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
