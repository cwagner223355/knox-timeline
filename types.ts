export type ViewMode = "single" | "two-day";

/** 0 = Sunday, 1 = Monday */
export type WeekStart = 0 | 1;

export interface HiddenEvent {
  uid: string;
  title: string;
}

export interface IcalUrlConfig {
  /** Stable random id (used to namespace events from this URL). */
  id: string;
  /** Display name shown in settings and (potentially) on event pills. */
  name: string;
  /** HTTPS URL pointing to an `.ics` feed. `webcal://` is normalized to `https://` on save. */
  url: string;
  /** Hex color (e.g. "#7d7d7d") used for events from this calendar. */
  color: string;
  enabled: boolean;
}

export interface KnoxTimelineSettings {
  caldavUsername: string;
  /**
   * The id of the Fastmail app password stored in Obsidian's SecretStorage.
   * Empty string means no password is configured.
   * The actual secret value lives in `app.secretStorage`, never in `data.json`.
   */
  caldavPasswordSecretId: string;
  enabledCalendarIds: string[];
  knownCalendarIds: string[];
  viewMode: ViewMode;
  hiddenEvents: HiddenEvent[];
  monthCalendarVisible: boolean;
  weekStartsOn: WeekStart;
  icalUrls: IcalUrlConfig[];
  cachedSnapshot?: ScheduleSnapshot;
}

/** Stable secret id used by the migration and as the default for new installs. */
export const DEFAULT_FASTMAIL_SECRET_ID = "knox-timeline-fastmail-password";

export const DEFAULT_SETTINGS: KnoxTimelineSettings = {
  caldavUsername: "",
  caldavPasswordSecretId: "",
  enabledCalendarIds: [],
  knownCalendarIds: [],
  viewMode: "two-day",
  hiddenEvents: [],
  monthCalendarVisible: false,
  weekStartsOn: 0,
  icalUrls: [],
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
