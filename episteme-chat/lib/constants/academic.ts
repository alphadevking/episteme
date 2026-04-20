export const LEVEL_OPTIONS = [
  "100L", "200L", "300L", "400L", "500L", "600L", "MSc", "PhD", "PGD",
] as const;

export type AcademicLevel = (typeof LEVEL_OPTIONS)[number];
