// proxy.ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const isDev = process.env.NODE_ENV === "development";

// ── CSP builder ───────────────────────────────────────────────────────────
// In production a per-request nonce replaces unsafe-inline for scripts.
// Next.js App Router automatically applies the nonce to its own inline
// hydration scripts when it finds x-nonce on the forwarded request headers.
function buildCsp(nonce?: string): string {
  const scriptSrc = nonce
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
    : isDev
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'";

  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://lh3.googleusercontent.com",
    "worker-src 'self' blob:",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    !isDev ? "upgrade-insecure-requests" : "",
  ].filter(Boolean).join("; ");
}

export async function proxy(request: NextRequest) {
  // Generate a per-request nonce in production only.
  // Dev skips nonces so HMR / Fast Refresh continue to work.
  const nonce = !isDev
    ? Buffer.from(crypto.randomUUID()).toString("base64")
    : undefined;

  // Forward x-nonce to Server Components via request headers.
  // Next.js reads this and applies it to its own inline scripts automatically.
  const requestHeaders = new Headers(request.headers);
  if (nonce) requestHeaders.set("x-nonce", nonce);

  let supabaseResponse = NextResponse.next({
    request: { headers: requestHeaders },
  });

  const supabaseUrl     = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl)     throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  if (!supabaseAnonKey) throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Write updated cookies back to the request so Server Components see them.
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        // Recreate the response — must re-pass requestHeaders to preserve x-nonce.
        supabaseResponse = NextResponse.next({ request: { headers: requestHeaders } });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // Triggers session token refresh if stale — must not be removed.
  const { data: { user } } = await supabase.auth.getUser();

  // ── Fast redirect for unauthenticated users on protected routes ──────────
  // Layout-level guards are the authoritative access control.
  // This is an early-exit optimisation only — it avoids a full RSC render
  // for clearly unauthenticated requests on routes that always require auth.
  const { pathname } = request.nextUrl;
  const PROTECTED_PREFIXES = ["/chat", "/claims", "/admin", "/superadmin", "/onboarding", "/settings"];
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
  if (!user && isProtected) {
    const signIn = request.nextUrl.clone();
    signIn.pathname = "/sign-in";
    const redirectResponse = NextResponse.redirect(signIn);
    // Propagate CSP even on redirects
    redirectResponse.headers.set("content-security-policy", buildCsp(nonce));
    return redirectResponse;
  }

  // Attach the CSP to the final response.
  supabaseResponse.headers.set("content-security-policy", buildCsp(nonce));

  return supabaseResponse;
}

export const config = {
  matcher: [
    // Run on all routes except static files and Next.js internals.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
