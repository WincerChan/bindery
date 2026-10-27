import { statSync } from "node:fs";
import type { LibraryStorage } from "../storage";
import { loadRuleTemplates, loadThemeTemplates } from "../templates";
import { lexTraceSettingsView } from "../vocabulary/settings";

export function settingsSummary(library: LibraryStorage) {
  library.ensure();
  const rules = loadRuleTemplates(), themes = loadThemeTemplates();
  // Keep loader order as a deterministic tie-breaker for equal mtimes.
  const recent = rules.map(rule => ({ rule, mtime: statSync(rule.file_path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.rule;
  // Ingest selects "default" (features/ingest/page.tsx and ingest/processor.ts); getTheme falls
  // back to the first loaded template if that ID is unavailable.
  const theme = themes.find(t => t.theme_id === "default") ?? themes[0];
  const lexitrace = lexTraceSettingsView(library.db);
  return {
    rules: { count: rules.length, recently_modified: recent ? { id: recent.rule_id, name: recent.name } : null },
    themes: { count: themes.length, ingest_default: theme ? { id: theme.theme_id, name: theme.name, version: theme.version } : null },
    security: library.db.passkeySummary(),
    // Configured is not a live connection check; never return credentials.
    lexitrace: { configured: Boolean(lexitrace.baseUrl && lexitrace.hasToken), enabled: lexitrace.enabled },
  };
}
export type SettingsSummary = ReturnType<typeof settingsSummary>;
