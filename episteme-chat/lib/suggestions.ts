// lib/suggestions.ts
// Hardcoded role-based chat suggestions.
// TODO: replace with DB-driven suggestions per institution (configurable).

export type Suggestion = {
  label: string;
  prompt: string;
};

const SUGGESTIONS: Record<string, Suggestion[]> = {
  prospective: [
    { label: "Explore programs", prompt: "What undergraduate programs are available and what are the entry requirements?" },
    { label: "Application process", prompt: "Walk me through the application process step by step." },
    { label: "Scholarships & funding", prompt: "What scholarships and bursaries are available for new students?" },
    { label: "Campus life", prompt: "What is student life like on campus? Accommodation, clubs, support services?" },
  ],
  student: [
    { label: "Transcript request", prompt: "How do I request an official transcript?" },
    { label: "Exam preparation", prompt: "Give me a study plan and tips for upcoming exams." },
    { label: "Course registration", prompt: "How do I register for next semester's courses and what are the deadlines?" },
    { label: "Academic support", prompt: "What academic support services are available to me as a student?" },
  ],
  parent: [
    { label: "Fee payment", prompt: "How do I view and pay my child's outstanding fees?" },
    { label: "Academic progress", prompt: "How can I check my child's academic progress and results?" },
    { label: "Campus safety", prompt: "What safety and security measures are in place on campus?" },
    { label: "Communication channels", prompt: "How do I communicate with faculty or the institution on my child's behalf?" },
  ],
  guardian: [
    { label: "Fee payment", prompt: "How do I view and pay outstanding fees for the student I support?" },
    { label: "Academic progress", prompt: "How can I check the student's academic progress and results?" },
    { label: "Campus safety", prompt: "What safety and security measures are in place on campus?" },
    { label: "Communication channels", prompt: "How do I communicate with faculty or the institution?" },
  ],
  staff: [
    { label: "Student records", prompt: "How do I access and update student records in the system?" },
    { label: "Policy & procedures", prompt: "Summarise the key institutional policies I need to be aware of." },
    { label: "Claim review workflow", prompt: "Walk me through the process for reviewing and approving verification claims." },
    { label: "Department reporting", prompt: "What reports can I generate for my department and how?" },
  ],
  hod: [
    { label: "Department overview", prompt: "Give me a summary of my department's current status, staff, and programs." },
    { label: "Staff management", prompt: "What tools do I have for managing staff assignments and workloads?" },
    { label: "Program accreditation", prompt: "What are the accreditation requirements for our degree programs?" },
    { label: "Budget & resources", prompt: "How do I submit a budget request or resource allocation for my department?" },
  ],
  admin: [
    { label: "Pending claims", prompt: "Show me a summary of all pending verification claims that need review." },
    { label: "User onboarding", prompt: "How do I onboard new staff members and set their access levels?" },
    { label: "Institution settings", prompt: "Walk me through the institution configuration settings I can manage." },
    { label: "Compliance report", prompt: "What compliance reports do I need to generate and when are they due?" },
  ],
  // superadmin: [
  //   { label: "Platform overview", prompt: "Give me a high-level overview of all institutions on the platform." },
  //   { label: "New institution setup", prompt: "Walk me through setting up a new institution from scratch." },
  //   { label: "Audit & compliance", prompt: "Summarise recent platform-wide audit log activity." },
  //   { label: "Admin provisioning", prompt: "How do I provision a new institution admin and what access do they get?" },
  // ],
};

// Fallback for unknown roles
const DEFAULT_SUGGESTIONS: Suggestion[] = [
  { label: "Get started", prompt: "What can you help me with on this platform?" },
  { label: "Platform features", prompt: "What features are available to me?" },
  { label: "Support", prompt: "How do I get help or contact support?" },
  { label: "Account settings", prompt: "How do I update my profile and account settings?" },
];

export function getSuggestions(role?: string | null): Suggestion[] {
  if (!role) return DEFAULT_SUGGESTIONS;
  return SUGGESTIONS[role] ?? DEFAULT_SUGGESTIONS;
}