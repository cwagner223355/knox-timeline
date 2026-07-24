import type { CalEvent } from "./types";

const VIDEO_HOSTS: { host: string; label: string }[] = [
  { host: "zoom.us", label: "Zoom" },
  { host: "meet.google.com", label: "Google Meet" },
  { host: "teams.microsoft.com", label: "Teams" },
  { host: "teams.live.com", label: "Teams" },
];

export function eventStartLocal(event: CalEvent): Date {
  const m = event.start.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (!m) return new Date(NaN);
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = m;
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tz = event.timeZone;
  if (event.showWithoutTime || !tz || tz === localTz) {
    return new Date(+y, +mo - 1, +d, +h, +mi, +s);
  }
  try {
    const utcGuess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
    const offsetMs = tzOffsetAt(utcGuess, tz);
    return new Date(utcGuess - offsetMs);
  } catch {
    // Non-IANA TZID (e.g. Windows zone names like "Eastern Standard Time" from
    // Outlook feeds) makes Intl throw. Fall back to floating local time rather
    // than letting one bad zone reject the whole feed.
    return new Date(+y, +mo - 1, +d, +h, +mi, +s);
  }
}

function tzOffsetAt(utcMs: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(utcMs));
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  const hour = m.hour === "24" ? "0" : m.hour;
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +hour, +m.minute, +m.second);
  return asUtc - utcMs;
}

export function eventDurationMs(event: CalEvent): number {
  if (!event.duration) return event.showWithoutTime ? 24 * 60 * 60 * 1000 : 0;
  return parseIso8601Duration(event.duration);
}

function parseIso8601Duration(s: string): number {
  const m = s.match(
    /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const weeks = +(m[2] ?? 0);
  const days = +(m[3] ?? 0);
  const hours = +(m[4] ?? 0);
  const mins = +(m[5] ?? 0);
  const secs = parseFloat(m[6] ?? "0");
  const totalDays = weeks * 7 + days;
  return sign * ((((totalDays * 24 + hours) * 60 + mins) * 60 + secs) * 1000);
}

export function eventEndLocal(event: CalEvent): Date {
  return new Date(eventStartLocal(event).getTime() + eventDurationMs(event));
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
}

export function eventTouchesDay(event: CalEvent, day: Date): boolean {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = endOfDay(day).getTime();
  const eventStart = eventStartLocal(event).getTime();
  const eventEnd = Math.max(eventStart + 1, eventEndLocal(event).getTime());
  return eventStart < dayEnd && eventEnd > dayStart;
}

export function formatTime(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  const mm = m.toString().padStart(2, "0");
  return `${h}:${mm} ${ampm}`;
}

export function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function sanitizeTitle(t: string): string {
  const cleaned = t
    .replace(/[/\\:?*<>"|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Untitled Event";
}

export function uniqueEventId(event: CalEvent): string {
  return event.recurrenceId ? `${event.uid}@${event.recurrenceId}` : event.uid;
}

export function busyCalUrl(event: CalEvent): string {
  const title = encodeURIComponent(event.title || "Untitled Event");
  const utc = eventStartLocal(event).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `busycalevent://find//${title}/${utc}`;
}

export function findVideoLink(event: CalEvent): { label: string; url: string } | null {
  const candidates: string[] = [];
  if (event.description) candidates.push(event.description);
  if (event.locations) {
    for (const loc of Object.values(event.locations)) {
      if (loc.name) candidates.push(loc.name);
      if (loc.description) candidates.push(loc.description);
    }
  }
  if (event.links) {
    for (const link of Object.values(event.links)) {
      if (link.href) candidates.push(link.href);
    }
  }
  const text = candidates.join(" ");
  const urls = text.match(/https?:\/\/[^\s<>"')]+/g) ?? [];
  for (const raw of urls) {
    const url = raw.replace(/[.,;:!?)\]]+$/, "");
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    for (const v of VIDEO_HOSTS) {
      // Match the host exactly or a subdomain of it, so a decoy path or
      // look-alike domain (e.g. "https://zoom.us.evil.tld") can't spoof it.
      if (host === v.host || host.endsWith("." + v.host)) {
        return { label: v.label, url };
      }
    }
  }
  return null;
}

export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
