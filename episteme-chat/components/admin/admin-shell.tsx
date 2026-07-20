"use client";

import { cn } from "@/lib/utils";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useState, useEffect, Suspense } from "react";
import {
  LayoutDashboardIcon,
  BookOpenIcon,
  BuildingIcon,
  GraduationCapIcon,
  UsersIcon,
  ClipboardListIcon,
  FileCheckIcon,
  DatabaseIcon,
  ShieldCheckIcon,
  LogOutIcon,
  LandmarkIcon,
  BadgeCheckIcon,
  MenuIcon,
  XIcon,
  UserCogIcon,
} from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useRouter } from "next/navigation";

type NavItem = { label: string; path: string; icon: React.ElementType };

const ADMIN_NAV: NavItem[] = [
  { label: "Dashboard",   path: "/admin",            icon: LayoutDashboardIcon },
  { label: "Faculties",   path: "/admin/faculties",  icon: BookOpenIcon },
  { label: "Departments", path: "/admin/departments", icon: BuildingIcon },
  { label: "Programs",    path: "/admin/programs",    icon: GraduationCapIcon },
  { label: "Users",       path: "/admin/users",       icon: UsersIcon },
  { label: "Students",    path: "/admin/students",    icon: BadgeCheckIcon },
  { label: "Staff",       path: "/admin/staff",       icon: UserCogIcon },
  { label: "Onboarding",  path: "/admin/onboarding",  icon: ClipboardListIcon },
  { label: "Claims",      path: "/admin/claims",      icon: FileCheckIcon },
];

const ADMIN_AI_NAV: NavItem[] = [
  { label: "Knowledge Base", path: "/admin/knowledge", icon: DatabaseIcon },
];

const SUPERADMIN_NAV: NavItem[] = [
  { label: "Dashboard",    path: "/superadmin",               icon: LayoutDashboardIcon },
  { label: "Institutions", path: "/superadmin/institutions",  icon: LandmarkIcon },
  { label: "Users",        path: "/superadmin/users",         icon: UsersIcon },
  { label: "Admins",       path: "/superadmin/admins",        icon: ShieldCheckIcon },
  { label: "Audit Logs",   path: "/superadmin/audit",         icon: ClipboardListIcon },
];

type Props = {
  tier:          "superadmin" | "admin";
  userName:      string;
  isSuperadmin?: boolean;
  children:      ReactNode;
};

function NavLink({ item, href, active }: { item: NavItem; href: string; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
        active
          ? "bg-primary text-primary-foreground font-medium"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      {item.label}
    </Link>
  );
}

// ── Nav skeleton shown while searchParams resolve ──────────────────────────
function NavSkeleton({ count }: { count: number }) {
  return (
    <div className="flex-1 space-y-0.5 p-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5 rounded-md px-3 py-2">
          <div className="size-3.5 rounded bg-muted animate-pulse shrink-0" />
          <div
            className="h-3 rounded bg-muted animate-pulse"
            style={{ width: `${50 + (i % 4) * 12}%` }}
          />
        </div>
      ))}
    </div>
  );
}

// ── Isolated component: only this needs useSearchParams ────────────────────
// By isolating it, Suspense catches only this piece — the sidebar shell
// (brand, footer, mobile bar) renders on first paint with no spinner.
function NavLinks({
  tier,
  nav,
  isActive,
  isSuperadmin,
}: {
  tier:         "superadmin" | "admin";
  nav:          NavItem[];
  isActive:     (path: string) => boolean;
  isSuperadmin: boolean;
}) {
  const searchParams  = useSearchParams();
  const institutionId = searchParams.get("institution");
  const instSuffix    = institutionId ? `?institution=${institutionId}` : "";

  return (
    <>
      {/* Institution badge (superadmin managing an institution via /admin) */}
      {tier === "admin" && isSuperadmin && institutionId && (
        <div className="mx-4 mb-1 flex items-center gap-1 rounded-md bg-accent/60 px-2 py-1.5">
          <span className="text-xs text-muted-foreground truncate">Managing institution</span>
        </div>
      )}

      <nav className="flex-1 space-y-0.5 p-2 overflow-y-auto">
        {nav.map((item) => {
          const href = tier === "admin" ? `${item.path}${instSuffix}` : item.path;
          return <NavLink key={item.path} item={item} href={href} active={isActive(item.path)} />;
        })}

        {/* AI section — admin tier only */}
        {tier === "admin" && (
          <>
            <div className="my-2 px-3">
              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-sidebar-border" />
                <span className="text-[9px] uppercase tracking-widest text-muted-foreground/60">AI</span>
                <div className="h-px flex-1 bg-sidebar-border" />
              </div>
            </div>
            {ADMIN_AI_NAV.map((item) => {
              const href = `${item.path}${instSuffix}`;
              return <NavLink key={item.path} item={item} href={href} active={isActive(item.path)} />;
            })}
          </>
        )}
      </nav>
    </>
  );
}

// ── SidebarContents: renders immediately, suspends only the nav links ──────
type SidebarContentsProps = {
  tier:         "superadmin" | "admin";
  userName:     string;
  isSuperadmin: boolean;
  nav:          NavItem[];
  isActive:     (path: string) => boolean;
  onClose:      () => void;
  signOut:      () => void;
};

function SidebarContents({
  tier,
  userName,
  isSuperadmin,
  nav,
  isActive,
  onClose,
  signOut,
}: SidebarContentsProps) {
  return (
    <>
      {/* Brand */}
      <div className="border-b border-sidebar-border px-4 py-4">
        <div className="flex items-center gap-2.5">
          <Logo width={28} height={28} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight">Episteme</p>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground leading-tight">
              {tier === "superadmin" ? "Superadmin" : "Admin"}
            </p>
          </div>
          {/* Close button — mobile only */}
          <button
            onClick={onClose}
            className="md:hidden -mr-1 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            aria-label="Close navigation"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      </div>

      {/* Nav — only this section suspends while searchParams resolve */}
      <Suspense fallback={<NavSkeleton count={nav.length} />}>
        <NavLinks tier={tier} nav={nav} isActive={isActive} isSuperadmin={isSuperadmin} />
      </Suspense>

      {/* Footer */}
      <div className="border-t border-sidebar-border p-3 space-y-1">
        <p className="truncate px-2 text-xs font-medium text-foreground">{userName}</p>
        <button
          onClick={signOut}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <LogOutIcon className="size-3.5" />
          Sign out
        </button>
      </div>
    </>
  );
}

// ── Shell — no longer uses useSearchParams, renders on first paint ─────────
function AdminShellInner({ tier, userName, isSuperadmin = false, children }: Props) {
  const pathname = usePathname();
  const router   = useRouter();
  const supabase = createSupabaseBrowserClient();

  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close drawer on route change
  useEffect(() => { setSidebarOpen(false); }, [pathname]);

  // Lock body scroll + Escape key when mobile drawer is open
  useEffect(() => {
    if (!sidebarOpen) return;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSidebarOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
    };
  }, [sidebarOpen]);

  const nav = tier === "superadmin" ? SUPERADMIN_NAV : ADMIN_NAV;

  const isActive = (path: string) => {
    const isRoot = path === "/admin" || path === "/superadmin";
    return isRoot ? pathname === path : pathname.startsWith(path);
  };

  const signOut = async () => {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("episteme:thread-list:"))
      .forEach((k) => localStorage.removeItem(k));
    // Constrained, non-forgeable auth logger (actor derived server-side).
    void (supabase as unknown as {
      rpc(fn: "fn_log_auth_event", args: { p_action: string }): Promise<unknown>;
    }).rpc("fn_log_auth_event", { p_action: "user_sign_out" });
    await supabase.auth.signOut();
    router.push("/sign-in");
  };

  const sidebarProps: SidebarContentsProps = {
    tier,
    userName,
    isSuperadmin,
    nav,
    isActive,
    onClose: () => setSidebarOpen(false),
    signOut,
  };

  return (
    <div className="flex h-dvh w-full bg-background">

      {/* ── Sidebar — desktop ── */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col border-r bg-sidebar">
        <SidebarContents {...sidebarProps} />
      </aside>

      {/* ── Sidebar — mobile drawer ── */}
      {sidebarOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-sidebar border-r shadow-xl md:hidden"
          >
            <SidebarContents {...sidebarProps} />
          </aside>
        </>
      )}

      {/* ── Main ── */}
      <main className="flex flex-1 flex-col overflow-hidden">

        {/* Mobile top bar */}
        <div className="flex items-center gap-3 border-b bg-background px-4 py-3 md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            aria-label="Open navigation"
            aria-expanded={sidebarOpen}
          >
            <MenuIcon className="size-4" />
          </button>
          <div className="flex items-center gap-2">
            <Logo width={24} height={24} />
            <span className="text-sm font-semibold">Episteme</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 md:p-6">{children}</div>
      </main>
    </div>
  );
}

// No top-level Suspense needed — the shell renders immediately.
// Only NavLinks (inside SidebarContents) suspends while searchParams resolve.
export function AdminShell(props: Props) {
  return <AdminShellInner {...props} />;
}
