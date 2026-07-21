export const NAMESPACE_OPTIONS = [
  { value: "admissions",      label: "Admissions" },
  { value: "academic-policy", label: "Academic Policy" },
  { value: "financial-aid",   label: "Financial Aid" },
  { value: "programmes",      label: "Programmes" },
  { value: "staff-internal",  label: "Staff Internal" },
  { value: "general",         label: "General" },
];

export const CATEGORY_OPTIONS = NAMESPACE_OPTIONS;

export const CONTENT_TYPE_OPTIONS = [
  { value: "general",      label: "General" },
  { value: "policy",       label: "Policy" },
  { value: "handbook",     label: "Handbook" },
  { value: "faq",          label: "FAQ" },
  { value: "announcement", label: "Announcement" },
  { value: "catalogue",    label: "Catalogue" },
  { value: "markdown",     label: "Markdown" },
];

export const ROLES = ["prospective", "student", "parent", "staff", "hod"];

export const ROLE_LABELS: Record<string, string> = {
  prospective: "Prospective",
  student:     "Student",
  parent:      "Parent",
  staff:       "Staff",
  hod:         "HOD",
};
