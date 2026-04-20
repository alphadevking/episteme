"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/types/database";

// Typed singleton — gives us full query + Realtime type inference everywhere.
let cachedBrowserClient: ReturnType<typeof createBrowserClient<Database>> | null = null;

export function createSupabaseBrowserClient() {
  if (cachedBrowserClient) return cachedBrowserClient;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl)    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  if (!supabaseAnonKey) throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");

  cachedBrowserClient = createBrowserClient<Database>(supabaseUrl, supabaseAnonKey);
  return cachedBrowserClient;
}
