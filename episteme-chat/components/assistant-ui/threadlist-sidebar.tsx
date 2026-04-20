import * as React from "react";
import { SquarePen } from "lucide-react";
import Link from "next/link";
import { Logo } from "@/components/logo";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";
import { ThreadList } from "@/components/assistant-ui/thread-list";
import { UserBadge } from "@/components/user/user-badge";
import { ParentClaimBanner } from "@/components/user/parent-claim-banner";
import { StudentApprovalBanner } from "@/components/user/student-approval-banner";
import { VerificationStatusBanner } from "@/components/user/verification-status-banner";
import { ClaimsNavLink } from "@/components/user/claims-nav-link";

export function ThreadListSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar {...props}>
      {/* ── Brand Header ── */}
      <SidebarHeader className="px-4 pt-5 pb-4 border-b border-sidebar-border/50">
        <div className="flex items-center gap-3">
          {/* Logo mark */}
          <Logo width={36} height={36} />

          {/* Brand text */}
          <div className="flex flex-col min-w-0 flex-1 gap-0.5">
            <span className="font-bold text-[17px] leading-tight tracking-tight text-foreground">
              Episteme
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.25em] text-primary/60 leading-none mt-0.5">
              Intelligence
            </span>
          </div>

          {/* New chat */}
          <Link
            href="/chat"
            title="New conversation"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground/60 transition-all duration-150 hover:bg-sidebar-accent hover:text-foreground active:scale-95"
          >
            <SquarePen className="size-4" />
          </Link>
        </div>
      </SidebarHeader>

      {/* ── Thread List ── */}
      <SidebarContent className="px-2 py-2 overflow-hidden">
        <ThreadList />
      </SidebarContent>

      <SidebarRail />

      {/* ── User Footer ── */}
      <SidebarFooter className="border-t border-sidebar-border/50 px-2 py-2 space-y-2">
        <VerificationStatusBanner />
        <StudentApprovalBanner />
        <ParentClaimBanner />
        <ClaimsNavLink />
        <UserBadge />
      </SidebarFooter>
    </Sidebar>
  );
}
