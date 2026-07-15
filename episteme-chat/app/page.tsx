// app/page.tsx
// Full marketing landing page — Tailwind only, no inline styles.
// Authenticated users see a "Go to Chat" CTA; unauthenticated see sign-up flow.

import { createSupabaseServerClientReadOnly } from "@/lib/supabase/server";
import Link from "next/link";
import { Sparkles, MessageSquare } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Logo } from "@/components/logo";

async function resolveAuthCta(): Promise<{ href: string; label: string }> {
  const supabase = await createSupabaseServerClientReadOnly();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { href: "/sign-in", label: "Start for free" };

  const { data: profile } = await supabase
    .from("users")
    .select("is_superadmin, roles")
    .eq("auth_id", user.id)
    .maybeSingle();

  const roles = (profile?.roles as string[]) ?? [];
  // if (profile?.is_superadmin) return { href: "/superadmin", label: "Go to Dashboard" };
  if (roles.includes("admin"))  return { href: "/chat",      label: "Start Chat" };
  if (roles.includes("hod"))    return { href: "/hod",        label: "Go to Dashboard" };
  return { href: "/chat", label: "Go to Chat" };
}

export default async function LandingPage() {
  const { href: ctaHref, label: ctaLabel } = await resolveAuthCta();
  const heroCta2Href = "#features";
  const heroCta2Label = "See how it works";

  return (
    <div className="min-h-dvh bg-background text-foreground overflow-x-hidden">

      {/* ── Nav ── */}
      <nav className="fixed top-0 inset-x-0 z-50 flex items-center justify-between px-6 md:px-10 h-14 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <Logo width={32} height={32} />
          <span className="font-serif text-xl font-medium tracking-wide">Episteme</span>
        </div>
        <div className="flex items-center gap-4 md:gap-6">
          <a href="#features" className="hidden md:block text-xs tracking-wide text-muted-foreground hover:text-foreground transition-colors">Features</a>
          <a href="#who" className="hidden md:block text-xs tracking-wide text-muted-foreground hover:text-foreground transition-colors">Who it&apos;s for</a>
          <ThemeToggle />

          {ctaHref !== "/sign-in" ? (
            /* Authenticated nav */
            <Link href={'/chat'} className="inline-flex items-center gap-1.5 text-xs font-medium px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
              <MessageSquare className="size-3.5" />
              {ctaLabel}
            </Link>
          ) : (
            /* Unauthenticated nav */
            <>
              <Link href="/sign-in" className="hidden sm:block text-xs tracking-wide text-muted-foreground hover:text-foreground transition-colors">Sign in</Link>
              <Link href="/sign-in" className="text-xs font-medium px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                Get started
              </Link>
            </>
          )}
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="relative flex min-h-dvh flex-col items-center justify-center text-center px-6 pt-20 pb-16 overflow-hidden">
        {/* Glow */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[600px] bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,var(--primary),transparent)] opacity-15" />

        <div className="relative z-10 flex flex-col items-center">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-4 py-1.5">
            <span className="size-1.5 rounded-full bg-primary" />
            <span className="text-[11px] font-medium tracking-widest uppercase text-primary">University AI Platform</span>
          </div>

          <h1 className="font-serif text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-light leading-[1.05] tracking-tight max-w-[16ch] text-foreground mb-6">
            The intelligence layer for{" "}
            <em className="italic text-primary font-light">higher education</em>
          </h1>

          <p className="max-w-[48ch] text-base font-light leading-relaxed text-muted-foreground mb-8">
            Episteme connects students, staff, parents, and administrators
            through a context-aware AI assistant that understands your
            institution — and your role within it.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href={ctaHref} className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
              <Sparkles className="size-4" />
              {ctaLabel}
            </Link>
            <Link href={heroCta2Href} className="inline-flex items-center px-6 py-3 rounded-lg border border-primary/30 text-primary text-sm font-medium hover:bg-primary/10 transition-colors">
              {heroCta2Label}
            </Link>
          </div>
        </div>

        {/* Scroll indicator */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 text-muted-foreground/50">
          <div className="h-10 w-px bg-gradient-to-b from-muted-foreground/50 to-transparent animate-pulse" />
          <span className="text-[10px] tracking-widest uppercase">Scroll</span>
        </div>
      </section>

      <div className="mx-6 h-px bg-gradient-to-r from-transparent via-border to-transparent" />

      {/* ── Features ── */}
      <section id="features" className="mx-auto max-w-5xl px-6 py-24">
        <p className="mb-3 text-[11px] font-medium tracking-widest uppercase text-primary">Platform Features</p>
        <h2 className="font-serif text-4xl md:text-5xl font-light text-foreground mb-4 leading-tight max-w-[28ch]">
          Built for the full university ecosystem
        </h2>
        <p className="max-w-[50ch] text-sm font-light leading-relaxed text-muted-foreground mb-14">
          Every interaction is shaped by who you are. A student asking about
          transcripts gets a different — and more useful — answer than an
          administrator asking the same question.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-border border border-border rounded-2xl overflow-hidden">
          {[
            { num: "01", title: "Role-Aware Responses", body: "The assistant adapts its knowledge and tone to your role — prospective student, student, parent, staff, or admin. Context shapes everything." },
            { num: "02", title: "Persistent Chat History", body: "Conversations are saved and resumable. Start on one device, continue on another. Every thread is preserved and searchable." },
            { num: "03", title: "Multi-Tenant Architecture", body: "Built to support multiple institutions simultaneously. Each university's data, policies, and users are fully isolated." },
            { num: "04", title: "Academic Hierarchy", body: "Faculty, departments, and programs are modelled structurally. The AI understands your institution's organisational structure." },
            { num: "05", title: "Verification Claims", body: "Students can request transcripts, enrollment letters, and degree certificates directly through the platform with a full admin review workflow." },
            { num: "06", title: "Parent & Guardian Access", body: "Verified parent-student relationships give guardians controlled, permission-based visibility into fees, attendance, and academic progress." },
          ].map((f, i) => (
            <div key={f.num} className={`group p-8 bg-card hover:bg-secondary/50 transition-colors ${i >= 3 ? "md:border-t border-border" : ""}`}>
              <div className="font-serif text-4xl font-light text-primary/30 mb-5">{f.num}</div>
              <div className="text-sm font-medium text-foreground mb-2">{f.title}</div>
              <div className="text-sm font-light leading-relaxed text-muted-foreground">{f.body}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="mx-6 h-px bg-gradient-to-r from-transparent via-border to-transparent" />

      {/* ── Who it's for ── */}
      <section id="who" className="mx-auto max-w-5xl px-6 py-24">
        <p className="mb-3 text-[11px] font-medium tracking-widest uppercase text-primary">Who It&apos;s For</p>
        <h2 className="font-serif text-4xl md:text-5xl font-light text-foreground mb-4 leading-tight max-w-[24ch]">
          Every role, one platform
        </h2>
        <p className="max-w-[48ch] text-sm font-light leading-relaxed text-muted-foreground mb-14">
          Episteme isn&apos;t a generic chatbot. It&apos;s purpose-built for
          the distinct needs of everyone in a university community.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            { icon: "🎓", title: "Prospective Students", body: "Explore programs, understand entry requirements, and navigate the application process with guided AI support." },
            { icon: "📚", title: "Student Students", body: "Request transcripts, prepare for exams, manage course registrations, and access academic support — all in one place." },
            { icon: "👨‍👩‍👧", title: "Parents & Guardians", body: "Stay informed about fees, academic progress, and campus safety through a verified, permission-based connection." },
            { icon: "🧑‍💼", title: "Staff & Faculty", body: "Access student records, institutional policies, and departmental tools without switching between disparate systems." },
            { icon: "🏛️", title: "Administrators", body: "Review verification claims, manage users, and oversee institutional data through a purpose-built admin panel." }
          ].map((w) => (
            <div key={w.title} className="rounded-xl border border-border bg-card p-6 hover:border-primary/30 hover:bg-primary/5 transition-colors">
              <div className="text-2xl mb-4">{w.icon}</div>
              <div className="text-sm font-medium text-foreground mb-2">{w.title}</div>
              <div className="text-sm font-light leading-relaxed text-muted-foreground">{w.body}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA Banner ── */}
      <div className="mx-6 mb-24">
        <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-primary/5 px-6 py-16 text-center">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_60%_at_50%_50%,var(--primary),transparent)] opacity-10" />
          <div className="relative z-10">
            <h2 className="font-serif text-4xl md:text-5xl font-light text-foreground mb-4 leading-tight max-w-[28ch] mx-auto">
              Ready to bring AI to your institution?
            </h2>
            <p className="text-sm font-light leading-relaxed text-muted-foreground max-w-[44ch] mx-auto mb-8">
              Join universities already using Episteme to connect their
              communities through intelligent, role-aware assistance.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link href={ctaHref} className="inline-flex items-center gap-2 px-7 py-3 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
                <Sparkles className="size-4" />
                {ctaLabel}
              </Link>
              <a href="mailto:hello@episteme.ai" className="inline-flex items-center px-7 py-3 rounded-lg border border-primary/30 text-primary text-sm font-medium hover:bg-primary/10 transition-colors">
                Talk to the team
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <footer className="border-t border-border px-6 md:px-10 py-6 flex flex-wrap items-center justify-between gap-4">
        <span className="text-xs font-light text-muted-foreground">
          © {new Date().getFullYear()} Episteme. All rights reserved.
        </span>
        <div className="flex gap-5">
          {["Privacy", "Terms", "Security"].map(l => (
            <a key={l} href="#" className="text-xs font-light text-muted-foreground hover:text-foreground transition-colors">{l}</a>
          ))}
          <a href="mailto:hello@episteme.ai" className="text-xs font-light text-muted-foreground hover:text-foreground transition-colors">Contact</a>
        </div>
      </footer>

    </div>
  );
}