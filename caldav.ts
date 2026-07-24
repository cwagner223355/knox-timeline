import { requestUrl } from "obsidian";
import type { CalCalendar, CalEvent } from "./types";
import { parseICalEvents } from "./ical";

const FASTMAIL_DAV_HOST = "https://caldav.fastmail.com";

export class CalDavAuthError extends Error {}
export class CalDavNetworkError extends Error {}

const NS_DAV = "DAV:";
const NS_CALDAV = "urn:ietf:params:xml:ns:caldav";
const NS_APPLE = "http://apple.com/ns/ical/";

function basicAuth(username: string, password: string): string {
  // Desktop-only plugin, so btoa is always available (Electron renderer).
  // Encode as UTF-8 bytes first so non-ASCII characters survive base64.
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `Basic ${btoa(bin)}`;
}

function calendarHomeUrl(username: string): string {
  return `${FASTMAIL_DAV_HOST}/dav/calendars/user/${encodeURIComponent(username)}/`;
}

async function dav(
  url: string,
  method: string,
  username: string,
  password: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  let res;
  try {
    res = await requestUrl({
      url,
      method,
      headers: {
        Authorization: basicAuth(username, password),
        "Content-Type": "application/xml; charset=utf-8",
        ...headers,
      },
      body,
      throw: false,
    });
  } catch (e) {
    throw new CalDavNetworkError(`Network error: ${(e as Error).message}`);
  }
  if (res.status === 401) {
    throw new CalDavAuthError("Fastmail rejected the username or password.");
  }
  if (res.status === 403) {
    throw new CalDavAuthError("Fastmail forbade access (HTTP 403).");
  }
  if (res.status >= 400 && res.status !== 207) {
    throw new CalDavNetworkError(`HTTP ${res.status}: ${(res.text ?? "").slice(0, 200)}`);
  }
  return { status: res.status, text: res.text ?? "" };
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, "application/xml");
}

function getElementsByLocal(parent: ParentNode, ns: string, local: string): Element[] {
  const nodeType = (parent as Node).nodeType;
  if (nodeType === 9 /* DOCUMENT_NODE */ || nodeType === 1 /* ELEMENT_NODE */) {
    return Array.from(
      (parent as Document | Element).getElementsByTagNameNS(ns, local),
    );
  }
  return [];
}

export async function fetchCalendars(
  username: string,
  password: string,
): Promise<CalCalendar[]> {
  const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <ic:calendar-color/>
  </d:prop>
</d:propfind>`;
  const url = calendarHomeUrl(username);
  const { text } = await dav(url, "PROPFIND", username, password, body, { Depth: "1" });
  const doc = parseXml(text);
  const responses = getElementsByLocal(doc, NS_DAV, "response");
  const out: CalCalendar[] = [];
  for (const r of responses) {
    const resourceType = getElementsByLocal(r, NS_DAV, "resourcetype")[0];
    if (!resourceType) continue;
    const isCalendar =
      getElementsByLocal(resourceType, NS_CALDAV, "calendar").length > 0;
    if (!isCalendar) continue;
    const href = getElementsByLocal(r, NS_DAV, "href")[0]?.textContent?.trim();
    if (!href) continue;
    const displayname =
      getElementsByLocal(r, NS_DAV, "displayname")[0]?.textContent?.trim() ?? "Untitled";
    const color =
      getElementsByLocal(r, NS_APPLE, "calendar-color")[0]?.textContent?.trim() ?? "#7d7d7d";
    out.push({
      id: href,
      name: displayname,
      color: normalizeColor(color),
      href: absoluteUrl(href),
    });
  }
  return out;
}

function absoluteUrl(href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  return `${FASTMAIL_DAV_HOST}${href}`;
}

function normalizeColor(c: string): string {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c.trim());
  if (m) return `#${m[1]}`;
  return c;
}

function toCalDavUtc(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const da = d.getUTCDate().toString().padStart(2, "0");
  const h = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const s = d.getUTCSeconds().toString().padStart(2, "0");
  return `${y}${mo}${da}T${h}${mi}${s}Z`;
}

export async function fetchEventsForCalendar(
  username: string,
  password: string,
  calendar: CalCalendar,
  windowStart: Date,
  windowEnd: Date,
): Promise<CalEvent[]> {
  const startStr = toCalDavUtc(windowStart);
  const endStr = toCalDavUtc(windowEnd);
  const body = `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data>
      <c:expand start="${startStr}" end="${endStr}"/>
    </c:calendar-data>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${startStr}" end="${endStr}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

  const { text } = await dav(calendar.href, "REPORT", username, password, body, {
    Depth: "1",
  });
  const doc = parseXml(text);
  const responses = getElementsByLocal(doc, NS_DAV, "response");
  const events: CalEvent[] = [];
  for (const r of responses) {
    const calData = getElementsByLocal(r, NS_CALDAV, "calendar-data")[0]?.textContent;
    if (!calData) continue;
    events.push(...parseICalEvents(calData, calendar.id));
  }
  return events;
}

export async function fetchEventsForCalendars(
  username: string,
  password: string,
  calendars: CalCalendar[],
  windowStart: Date,
  windowEnd: Date,
): Promise<CalEvent[]> {
  const results = await Promise.allSettled(
    calendars.map((c) => fetchEventsForCalendar(username, password, c, windowStart, windowEnd)),
  );
  const events: CalEvent[] = [];
  const errors: unknown[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      events.push(...r.value);
    } else {
      errors.push(r.reason);
      console.warn(
        `Knox Timeline: failed to fetch calendar "${calendars[i].name}":`,
        r.reason,
      );
    }
  });
  // One failing calendar no longer aborts the rest. But if every calendar
  // failed, propagate the first error (preserving its CalDav* type) so the
  // caller treats it as a real Fastmail failure and keeps the cached snapshot.
  if (events.length === 0 && errors.length === calendars.length && errors.length > 0) {
    throw errors[0];
  }
  return events;
}
