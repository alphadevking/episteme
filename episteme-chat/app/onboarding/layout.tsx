// app/onboarding/layout.tsx
// Minimal layout — no sidebar, no nav. Clean canvas for onboarding.
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-muted/30">
      <header className="flex items-center px-6 py-4">
        <Logo width={32} height={32} />
      </header>
      {children}
    </div>
  );
}