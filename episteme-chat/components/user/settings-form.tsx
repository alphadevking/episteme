// components/user/settings-form.tsx
// Shared type for the settings page. All rendering is in settings-shell.tsx.

export type SettingsInitial = {
  firstName:    string;
  lastName:     string;
  phone:        string;
  primaryRole:  string;
  programme:    string;
  level:        string;
  department:   string;
  staffTitle:   string;
  verbosity:    "concise" | "detailed";
  programmes:   { id: string; name: string; code: string }[];
  departments:  { id: string; name: string; code: string }[];
};
