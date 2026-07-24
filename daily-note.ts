import { App, TFile, normalizePath, moment } from "obsidian";

const DEFAULT_DAILY_FORMAT = "YYYY-MM-DD";

type MomentFn = (inp?: Date) => { format(fmt: string): string };

function formatDate(day: Date, fmt: string): string {
  return (moment as unknown as MomentFn)(day).format(fmt);
}

interface DailyNoteConfig {
  folder: string;
  format: string;
  template: string;
}

/**
 * Resolve the active daily-note settings. Prefer the Periodic Notes plugin's
 * daily config when its daily notes are enabled; otherwise fall back to the
 * core Daily Notes plugin. Honors "respect either" without caring which one
 * is currently driving daily notes.
 */
function getDailyNoteConfig(app: App): DailyNoteConfig {
  const periodicDaily = (
    app as unknown as {
      plugins?: {
        plugins?: Record<
          string,
          {
            settings?: {
              daily?: {
                enabled?: boolean;
                folder?: string;
                format?: string;
                template?: string;
              };
            };
          }
        >;
      };
    }
  ).plugins?.plugins?.["periodic-notes"]?.settings?.daily;

  if (periodicDaily?.enabled) {
    return normalizeConfig(periodicDaily);
  }

  const coreOptions = (
    app as unknown as {
      internalPlugins?: {
        getPluginById?: (id: string) =>
          | { instance?: { options?: { folder?: string; format?: string; template?: string } } }
          | null;
      };
    }
  ).internalPlugins?.getPluginById?.("daily-notes")?.instance?.options;

  return normalizeConfig(coreOptions ?? {});
}

function normalizeConfig(raw: { folder?: string; format?: string; template?: string }): DailyNoteConfig {
  return {
    folder: (raw.folder ?? "").trim(),
    format: (raw.format ?? "").trim() || DEFAULT_DAILY_FORMAT,
    template: (raw.template ?? "").trim(),
  };
}

/**
 * The basename (no extension) of the daily note for `day`, formatted with the
 * user's configured daily-note format. Lets meeting-note templates link the
 * correct daily note regardless of how the user names theirs.
 */
export function dailyNoteName(app: App, day: Date): string {
  const cfg = getDailyNoteConfig(app);
  return formatDate(day, cfg.format);
}

async function readTemplateBody(app: App, templatePath: string): Promise<string> {
  if (!templatePath) return "";
  const withExt = templatePath.endsWith(".md") ? templatePath : `${templatePath}.md`;
  const tpl = app.vault.getAbstractFileByPath(normalizePath(withExt));
  return tpl instanceof TFile ? app.vault.read(tpl) : "";
}

/**
 * Run Templater over a freshly created note so its <% %> commands resolve.
 * The file is already named <date>, so tp.file.title is correct. No-ops
 * silently if Templater isn't installed.
 */
async function applyTemplater(app: App, file: TFile): Promise<void> {
  const templaterPlugin = (
    app as unknown as { plugins?: { plugins?: Record<string, unknown> } }
  ).plugins?.plugins?.["templater-obsidian"];
  const fn = (
    templaterPlugin as
      | { templater?: { overwrite_file_commands?: (file: TFile, active?: boolean) => Promise<void> } }
      | undefined
  )?.templater?.overwrite_file_commands;
  if (typeof fn === "function") {
    await fn.call((templaterPlugin as { templater: unknown }).templater, file, false);
  }
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  const parts = folder.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    if (!app.vault.getAbstractFileByPath(cur)) {
      await app.vault.createFolder(cur);
    }
  }
}

/**
 * Open the daily note for the given day, creating it from the configured
 * daily-note template (Templater-processed) if it does not yet exist.
 */
export async function openOrCreateDailyNote(app: App, day: Date): Promise<void> {
  const cfg = getDailyNoteConfig(app);
  const filename = formatDate(day, cfg.format);
  const path = normalizePath(cfg.folder ? `${cfg.folder}/${filename}.md` : `${filename}.md`);

  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.workspace.getLeaf(false).openFile(existing);
    return;
  }

  const parent = path.substring(0, path.lastIndexOf("/"));
  if (parent) await ensureFolder(app, parent);

  const body = await readTemplateBody(app, cfg.template);
  const created = await app.vault.create(path, body);
  await applyTemplater(app, created);

  await app.workspace.getLeaf(false).openFile(created);
}
