import { App, TFile, normalizePath } from "obsidian";
import type { CalEvent } from "./types";
import {
  busyCalUrl,
  eventEndLocal,
  eventStartLocal,
  findVideoLink,
  formatTime,
  formatYmd,
  sanitizeTitle,
} from "./event-utils";
import { dailyNoteName } from "./daily-note";

/** How many "(2)", "(3)"… variants to probe before giving up on collision resolution. */
const MAX_SUFFIX = 20;

/**
 * Default meeting-note body used when the user hasn't set their own template.
 * Deliberately generic (no vault-specific frontmatter). `event_uid` is what lets
 * the plugin recognize an event's note again, so keep it if you customize this.
 *
 * Supported placeholders: {{title}} {{date}} {{start_time}} {{end_time}}
 * {{video_url}} {{busycal_url}} {{uid}} {{daily_note}}.
 */
export const DEFAULT_MEETING_TEMPLATE = [
  "---",
  'event_uid: "{{uid}}"',
  "date: {{date}}",
  "start: {{start_time}}",
  "end: {{end_time}}",
  "url: {{video_url}}",
  "---",
  "",
  "# {{title}}",
  "",
].join("\n");

export interface MeetingNoteOptions {
  folder: string;
  template: string;
}

export function noteExistsForEvent(app: App, event: CalEvent, folder: string): boolean {
  return findNoteForEvent(app, event, folder) !== null;
}

/**
 * Find an existing note for this event by walking the deterministic candidate
 * paths (base, then "(2)", "(3)"…) and matching on the `event_uid` frontmatter.
 * A note with no `event_uid` at the base path is treated as a match for
 * backward compatibility with notes created before uid stamping.
 */
function findNoteForEvent(app: App, event: CalEvent, folder: string): TFile | null {
  const dateStr = formatYmd(eventStartLocal(event));
  const sanitized = sanitizeTitle(event.title || "Untitled Event");
  for (let i = 1; i <= MAX_SUFFIX; i++) {
    const f = app.vault.getAbstractFileByPath(candidatePath(folder, dateStr, sanitized, i));
    if (!(f instanceof TFile)) continue;
    const uid = app.metadataCache.getFileCache(f)?.frontmatter?.event_uid;
    if (uid == null || String(uid) === event.uid) return f;
  }
  return null;
}

/** First candidate path not currently occupied by any file. */
function firstFreePath(app: App, folder: string, dateStr: string, sanitized: string): string {
  for (let i = 1; i <= MAX_SUFFIX; i++) {
    const path = candidatePath(folder, dateStr, sanitized, i);
    if (!app.vault.getAbstractFileByPath(path)) return path;
  }
  return candidatePath(folder, dateStr, sanitized, MAX_SUFFIX);
}

function candidatePath(folder: string, dateStr: string, sanitized: string, n: number): string {
  const suffix = n > 1 ? ` (${n})` : "";
  return normalizePath(`${folder}/${dateStr} • ${sanitized}${suffix}.md`);
}

export async function openOrCreateNote(
  app: App,
  event: CalEvent,
  opts: MeetingNoteOptions,
): Promise<void> {
  const existing = findNoteForEvent(app, event, opts.folder);
  if (existing) {
    await app.workspace.getLeaf(false).openFile(existing);
    return;
  }

  await ensureFolder(app, opts.folder);

  const dateStr = formatYmd(eventStartLocal(event));
  const sanitized = sanitizeTitle(event.title || "Untitled Event");
  const path = firstFreePath(app, opts.folder, dateStr, sanitized);
  const body = renderTemplate(templateOrDefault(opts.template), app, event, dateStr);

  let created: TFile;
  try {
    created = await app.vault.create(path, body);
  } catch (e) {
    // Lost a create race (e.g. a double-click firing two creates). Re-resolve
    // the path and open whatever landed there instead of surfacing the error.
    const again = app.vault.getAbstractFileByPath(path);
    if (again instanceof TFile) {
      await app.workspace.getLeaf(false).openFile(again);
      return;
    }
    throw e;
  }
  await app.workspace.getLeaf(false).openFile(created);
}

function templateOrDefault(template: string): string {
  return template.trim() ? template : DEFAULT_MEETING_TEMPLATE;
}

function renderTemplate(tpl: string, app: App, event: CalEvent, dateStr: string): string {
  const start = eventStartLocal(event);
  const end = eventEndLocal(event);
  const video = findVideoLink(event);
  const values: Record<string, string> = {
    title: event.title || "Untitled Event",
    date: dateStr,
    start_time: event.showWithoutTime ? "" : formatTime(start),
    end_time: event.showWithoutTime ? "" : formatTime(end),
    video_url: video?.url ?? "",
    busycal_url: busyCalUrl(event),
    uid: event.uid,
    daily_note: dailyNoteName(app, start),
  };
  return tpl.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
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
