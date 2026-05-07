import { App, TFile, normalizePath } from "obsidian";
import type { CalEvent } from "./types";
import {
  busyCalUrl,
  eventStartLocal,
  findVideoLink,
  formatYmd,
  sanitizeTitle,
} from "./event-utils";

const MEETING_FOLDER = "Calendar/0. Meetings & Events";

export function noteExistsForEvent(app: App, event: CalEvent): boolean {
  return findExistingNote(app, event) !== null;
}

function findExistingNote(app: App, event: CalEvent): TFile | null {
  const path = expectedPath(event);
  const f = app.vault.getAbstractFileByPath(path);
  return f instanceof TFile ? f : null;
}

function expectedPath(event: CalEvent): string {
  const dateStr = formatYmd(eventStartLocal(event));
  const sanitized = sanitizeTitle(event.title || "Untitled Event");
  return normalizePath(`${MEETING_FOLDER}/${dateStr} • ${sanitized}.md`);
}

export async function openOrCreateNote(app: App, event: CalEvent): Promise<void> {
  const existing = findExistingNote(app, event);
  if (existing) {
    await app.workspace.getLeaf(false).openFile(existing);
    return;
  }

  await ensureFolder(app, MEETING_FOLDER);

  const path = expectedPath(event);
  const dateStr = formatYmd(eventStartLocal(event));
  const body = buildNoteBody(event, dateStr);
  const created = await app.vault.create(path, body);
  await app.workspace.getLeaf(false).openFile(created);
}

function buildNoteBody(event: CalEvent, dateStr: string): string {
  const busyUrl = busyCalUrl(event);
  const video = findVideoLink(event);

  return [
    "---",
    "aliases:",
    "read_only:",
    "musing:",
    "publish:",
    "claude_author:",
    "claude_edited:",
    "categories:",
    "linked:",
    `  - "[[${dateStr}]]"`,
    "people:",
    `url: ${video ? video.url : ""}`,
    `cal link: ${busyUrl}`,
    "tags:",
    "---",
    "",
  ].join("\n");
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
