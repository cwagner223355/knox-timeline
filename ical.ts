import type { CalEvent } from "./types";

interface RawProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

export function unfoldLines(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if (line.length === 0) continue;
    if ((line[0] === " " || line[0] === "\t") && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseProperty(line: string): RawProperty | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const semi = left.indexOf(";");
  const name = (semi < 0 ? left : left.slice(0, semi)).toUpperCase();
  const params: Record<string, string> = {};
  if (semi >= 0) {
    const paramStr = left.slice(semi + 1);
    let i = 0;
    while (i < paramStr.length) {
      const eq = paramStr.indexOf("=", i);
      if (eq < 0) break;
      const pname = paramStr.slice(i, eq).toUpperCase();
      let pval: string;
      let next: number;
      if (paramStr[eq + 1] === '"') {
        const close = paramStr.indexOf('"', eq + 2);
        if (close < 0) {
          pval = paramStr.slice(eq + 2);
          next = paramStr.length;
        } else {
          pval = paramStr.slice(eq + 2, close);
          next = close + 1;
          if (paramStr[next] === ";") next++;
        }
      } else {
        const sep = paramStr.indexOf(";", eq + 1);
        if (sep < 0) {
          pval = paramStr.slice(eq + 1);
          next = paramStr.length;
        } else {
          pval = paramStr.slice(eq + 1, sep);
          next = sep + 1;
        }
      }
      params[pname] = pval;
      i = next;
    }
  }
  return { name, params, value };
}

function unescapeText(s: string): string {
  return s
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseDateTime(value: string, params: Record<string, string>): {
  start: string;
  timeZone: string | null;
  allDay: boolean;
} {
  if (params.VALUE === "DATE" || /^\d{8}$/.test(value)) {
    const y = value.slice(0, 4);
    const m = value.slice(4, 6);
    const d = value.slice(6, 8);
    return { start: `${y}-${m}-${d}T00:00:00`, timeZone: null, allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) {
    return { start: value, timeZone: params.TZID ?? null, allDay: false };
  }
  const [, yr, mo, d, h, mi, s, z] = m;
  const start = `${yr}-${mo}-${d}T${h}:${mi}:${s}`;
  if (z === "Z") return { start, timeZone: "UTC", allDay: false };
  return { start, timeZone: params.TZID ?? null, allDay: false };
}

function diffDurationIso(startIso: string, endIso: string): string {
  const sd = parseLocalIso(startIso);
  const ed = parseLocalIso(endIso);
  if (!sd || !ed) return "PT0S";
  let ms = ed.getTime() - sd.getTime();
  if (ms < 0) ms = 0;
  const totalSec = Math.round(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const rem = totalSec - days * 86400;
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const s = rem % 60;
  let out = "P";
  if (days > 0) out += `${days}D`;
  if (h > 0 || m > 0 || s > 0 || days === 0) {
    out += "T";
    if (h > 0) out += `${h}H`;
    if (m > 0) out += `${m}M`;
    if (s > 0 || (h === 0 && m === 0)) out += `${s}S`;
  }
  return out;
}

function parseLocalIso(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, sc] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +sc);
}

export function parseICalEvents(text: string, calendarId: string): CalEvent[] {
  const lines = unfoldLines(text);
  const events: CalEvent[] = [];
  let stack: string[] = [];
  let cur: {
    uid?: string;
    title?: string;
    description?: string;
    start?: string;
    timeZone?: string | null;
    allDay?: boolean;
    end?: string;
    duration?: string;
    recurrenceId?: string;
    attendees: { name?: string; email?: string }[];
    locations: string[];
    links: string[];
  } | null = null;

  for (const line of lines) {
    if (line.startsWith("BEGIN:")) {
      const comp = line.slice(6).toUpperCase();
      stack.push(comp);
      if (comp === "VEVENT" && stack.length === 2) {
        cur = { attendees: [], locations: [], links: [] };
      }
      continue;
    }
    if (line.startsWith("END:")) {
      const comp = line.slice(4).toUpperCase();
      if (comp === "VEVENT" && cur && cur.uid && cur.start) {
        events.push(buildEvent(cur, calendarId));
      }
      if (comp === "VEVENT") cur = null;
      stack.pop();
      continue;
    }
    if (!cur || stack[stack.length - 1] !== "VEVENT") continue;

    const p = parseProperty(line);
    if (!p) continue;

    switch (p.name) {
      case "UID":
        cur.uid = p.value;
        break;
      case "SUMMARY":
        cur.title = unescapeText(p.value);
        break;
      case "DESCRIPTION":
        cur.description = unescapeText(p.value);
        break;
      case "LOCATION":
        cur.locations.push(unescapeText(p.value));
        break;
      case "URL":
        cur.links.push(p.value);
        break;
      case "X-APPLE-STRUCTURED-LOCATION":
        if (p.value) cur.locations.push(p.value);
        break;
      case "DTSTART": {
        const d = parseDateTime(p.value, p.params);
        cur.start = d.start;
        cur.timeZone = d.timeZone;
        cur.allDay = d.allDay;
        break;
      }
      case "DTEND": {
        const d = parseDateTime(p.value, p.params);
        cur.end = d.start;
        break;
      }
      case "DURATION":
        cur.duration = p.value;
        break;
      case "RECURRENCE-ID": {
        const d = parseDateTime(p.value, p.params);
        cur.recurrenceId = d.start;
        break;
      }
      case "ATTENDEE": {
        const email = p.value.replace(/^mailto:/i, "").trim();
        const name = p.params.CN ? unescapeText(p.params.CN).trim() : undefined;
        cur.attendees.push({ name: name || undefined, email: email || undefined });
        break;
      }
    }
  }
  return events;
}

function buildEvent(
  cur: {
    uid?: string;
    title?: string;
    description?: string;
    start?: string;
    timeZone?: string | null;
    allDay?: boolean;
    end?: string;
    duration?: string;
    recurrenceId?: string;
    attendees: { name?: string; email?: string }[];
    locations: string[];
    links: string[];
  },
  calendarId: string,
): CalEvent {
  let duration = cur.duration;
  if (!duration && cur.end && cur.start) {
    duration = diffDurationIso(cur.start, cur.end);
  }
  if (!duration && cur.allDay) {
    duration = "P1D";
  }

  const id = cur.recurrenceId ? `${cur.uid}@${cur.recurrenceId}` : cur.uid!;

  const participants: Record<string, { name?: string; email?: string }> = {};
  cur.attendees.forEach((a, i) => (participants[`a${i}`] = { name: a.name, email: a.email }));

  const locations: Record<string, { description?: string }> = {};
  cur.locations.forEach((loc, i) => (locations[`l${i}`] = { description: loc }));

  const links: Record<string, { href: string }> = {};
  cur.links.forEach((href, i) => (links[`k${i}`] = { href }));

  return {
    id,
    uid: cur.uid!,
    recurrenceId: cur.recurrenceId,
    title: cur.title,
    start: cur.start!,
    duration,
    timeZone: cur.timeZone ?? null,
    showWithoutTime: cur.allDay,
    calendarIds: { [calendarId]: true },
    participants: cur.attendees.length > 0 ? participants : undefined,
    locations: cur.locations.length > 0 ? locations : undefined,
    links: cur.links.length > 0 ? links : undefined,
    description: cur.description,
  };
}
