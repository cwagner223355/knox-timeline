export type ViewMode = "single" | "two-day";

export interface HiddenEvent {
  uid: string;
  title: string;
}

export interface KnoxTimelineSettings {
  caldavUsername: string;
  caldavPassword: string;
  enabledCalendarIds: string[];
  knownCalendarIds: string[];
  viewMode: ViewMode;
  hiddenEvents: HiddenEvent[];
  cachedSnapshot?: ScheduleSnapshot;
}

export const DEFAULT_SETTINGS: KnoxTimelineSettings = {
  caldavUsername: "",
  caldavPassword: "",
  enabledCalendarIds: [],
  knownCalendarIds: [],
  viewMode: "two-day",
  hiddenEvents: [],
};

export interface CalCalendar {
  id: string;
  name: string;
  color: string;
  href: string;
}

export interface CalParticipant {
  name?: string;
  email?: string;
}

export interface CalLocation {
  name?: string;
  description?: string;
}

export interface CalLink {
  href: string;
}

export interface CalEvent {
  id: string;
  uid: string;
  recurrenceId?: string;
  title?: string;
  start: string;
  duration?: string;
  timeZone?: string | null;
  showWithoutTime?: boolean;
  calendarIds: Record<string, boolean>;
  participants?: Record<string, CalParticipant>;
  locations?: Record<string, CalLocation>;
  links?: Record<string, CalLink>;
  description?: string;
}

export interface ScheduleSnapshot {
  fetchedAt: number;
  windowStart: number;
  windowEnd: number;
  events: CalEvent[];
  calendars: CalCalendar[];
}
