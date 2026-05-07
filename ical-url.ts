import { requestUrl } from "obsidian";
import type { CalCalendar, CalEvent, IcalUrlConfig } from "./types";
import { parseICalEvents } from "./ical";
import { eventEndLocal, eventStartLocal } from "./event-utils";

export class IcalUrlFetchError extends Error {}

/** Build the synthetic calendar id used to namespace events from this iCal URL. */
export function icalCalendarId(cfg: IcalUrlConfig): string {
  return `ical:${cfg.id}`;
}

/** Synthesize a CalCalendar entry for an iCal URL config so it slots into the same data model. */
export function icalCalendar(cfg: IcalUrlConfig): CalCalendar {
  return {
    id: icalCalendarId(cfg),
    name: cfg.name,
    color: cfg.color,
    href: cfg.url,
  };
}

/** Normalize a user-entered URL: convert webcal:// to https://, trim whitespace. */
export function normalizeIcalUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^webcal:\/\//i.test(trimmed)) {
    return "https://" + trimmed.slice("webcal://".length);
  }
  return trimmed;
}

/** Fetch the iCal feed and return events that touch the [windowStart, windowEnd) window. */
export async function fetchIcalUrlEvents(
  cfg: IcalUrlConfig,
  windowStart: Date,
  windowEnd: Date,
): Promise<CalEvent[]> {
  let res;
  try {
    res = await requestUrl({
      url: cfg.url,
      method: "GET",
      throw: false,
    });
  } catch (e) {
    throw new IcalUrlFetchError(`Network error: ${(e as Error).message}`);
  }
  if (res.status >= 400) {
    throw new IcalUrlFetchError(`HTTP ${res.status}`);
  }

  const text = res.text ?? "";
  const allEvents = parseICalEvents(text, icalCalendarId(cfg));

  const windowStartMs = windowStart.getTime();
  const windowEndMs = windowEnd.getTime();
  return allEvents.filter((e) => {
    const start = eventStartLocal(e).getTime();
    const end = eventEndLocal(e).getTime();
    // Event touches the window if [start, end) overlaps [windowStart, windowEnd).
    return start < windowEndMs && end > windowStartMs;
  });
}
