// components/hod/hod-shell.tsx
// HOD sidebar shell — mirrors AdminShell pattern exactly.
// Tier label: "HOD" instead of "Admin" / "Superadmin".
"use client";

import { cn } from "@/lib/utils";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useState, useEffect } from "react";
import {
  LayoutDashboardIcon,
  FileCheckIcon,
  UsersIcon,
  LogOutIcon,
  MenuIcon,
  XIcon,
} from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useRouter } from "next/navigation";

type NavItem = { label: string; path: string; icon: React.ElementType };

const HOD_NAV: NavItem[] = [
  { label: "Overview",  path: "/hod",          icon: LayoutDashboardIcon },
  { label: "Claims",    path: "/hod/claims",    icon: FileCheckIcon },
  { label: "Students",  path: "/hod/students",  icon: UsersIcon },
];

type Props = {
  departmentName: string;
  userName:       string;
  children:       ReactNode;
};

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.path}
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

function SidebarContents({
  departmentName,
  userName,
  isActive,
  onClose,
  signOut,
}: {
  departmentName: string;
  userName:       string;
  isActive:       (path: string) => boolean;
  onClose:        () => void;
  signOut:        () => void;
}) {
  return (
    <>
      {/* Brand */}
      <div className="border-b border-sidebar-border px-4 py-4">
        <div className="flex items-center gap-2.5">
          <Logo width={28} height={28} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight">Episteme</p>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground leading-tight">
              HOD
            </p>
          </div>
          <button
            onClick={onClose}
            className="md:hidden -mr-1 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            aria-label="Close navigation"
          >
            <XIcon className="size-4" />
          </button>
        </div>
        {/* Department badge */}
        <div className="mt-3 rounded-md bg-accent/50 px-2.5 py-1.5">
          <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Department
          </p>
          <p className="text-xs font-semibold text-foreground truncate mt-0.5">
            {departmentName}
          </p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 p-2 overflow-y-auto">
        {HOD_NAV.map((item) => (
          <NavLink key={item.path} item={item} active={isActive(item.path)} />
        ))}
      </nav>

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

export function HodShell({ departmentName, userName, children }: Props) {
  const pathname = usePathname();
  const router   = useRouter();
  const supabase = createSupabaseBrowserClient();

  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => { setSidebarOpen(false); }, [pathname]);

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

  const isActive = (path: string) =>
    path === "/hod" ? pathname === path : pathname.startsWith(path);

  const signOut = async () => {
    // Constrained, non-forgeable auth logger (actor derived server-side).
    void (supabase as unknown as {
      rpc(fn: "fn_log_auth_event", args: { p_action: string }): Promise<unknown>;
    }).rpc("fn_log_auth_event", { p_action: "user_sign_out" });
    await supabase.auth.signOut();
    router.push("/sign-in");
  };

  const sidebarProps = { departmentName, userName, isActive, onClose: () => setSidebarOpen(false), signOut };

  return (
    <div className="flex h-dvh w-full bg-background">

      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col border-r bg-sidebar">
        <SidebarContents {...sidebarProps} />
      </aside>

      {/* Mobile drawer */}
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

      {/* Main */}
      <main className="flex flex-1 flex-col overflow-hidden">
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
