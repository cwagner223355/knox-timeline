import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import {
  DEFAULT_FASTMAIL_SECRET_ID,
  DEFAULT_SETTINGS,
  type CalCalendar,
  type CalEvent,
  type KnoxTimelineSettings,
  type ScheduleSnapshot,
  type ViewMode,
} from "./types";
import {
  CalDavAuthError,
  CalDavNetworkError,
  fetchCalendars,
  fetchEventsForCalendars,
} from "./caldav";
import { fetchIcalUrlEvents, icalCalendar } from "./ical-url";
import { TimelineView, TIMELINE_VIEW_TYPE } from "./view";
import { KnoxTimelineSettingTab } from "./settings";

const STALE_AFTER_MS = 5 * 60 * 1000;

export default class KnoxTimelinePlugin extends Plugin {
  settings!: KnoxTimelineSettings;
  lastKnownCalendars: CalCalendar[] = [];
  showHiddenEvents = false;
  private anchorDate: Date = startOfDay(new Date());
  private midnightTimer: number | null = null;
  private nowLineTimer: number | null = null;
  private fetchInFlight: Promise<void> | null = null;

  async onload() {
    await this.loadSettings();
    this.lastKnownCalendars = this.settings.cachedSnapshot?.calendars ?? [];

    this.registerView(TIMELINE_VIEW_TYPE, (leaf) => new TimelineView(leaf, this));
    this.addSettingTab(new KnoxTimelineSettingTab(this.app, this));

    this.addCommand({
      id: "open-timeline-leaf",
      name: "Open Timeline",
      callback: () => { void this.activateView(); },
    });
    this.addCommand({
      id: "refresh-timeline",
      name: "Refresh Timeline",
      callback: () => this.requestRefresh(),
    });
    this.addCommand({
      id: "timeline-prev-day",
      name: "Previous day",
      callback: () => this.shiftAnchor(-1),
    });
    this.addCommand({
      id: "timeline-next-day",
      name: "Next day",
      callback: () => this.shiftAnchor(1),
    });
    this.addCommand({
      id: "timeline-today",
      name: "Jump to today",
      callback: () => this.jumpToToday(),
    });

    this.app.workspace.onLayoutReady(() => {
      void this.activateView();
      void this.requestRefresh();
      this.scheduleMidnightTimer();
      this.scheduleNowLineTimer();
    });
  }

  async onunload() {
    if (this.midnightTimer !== null) {
      window.clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
    if (this.nowLineTimer !== null) {
      window.clearInterval(this.nowLineTimer);
      this.nowLineTimer = null;
    }
  }

  async loadSettings() {
    const data = (await this.loadData()) as
      | (KnoxTimelineSettings & { caldavPassword?: string })
      | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    // Migrate: legacy plaintext `caldavPassword` field → SecretStorage entry.
    // Runs once per install; after migration the plaintext field is dropped from data.json.
    const legacyPlaintext = data && (data as { caldavPassword?: string }).caldavPassword;
    if (legacyPlaintext && !this.settings.caldavPasswordSecretId) {
      try {
        this.app.secretStorage.setSecret(DEFAULT_FASTMAIL_SECRET_ID, legacyPlaintext);
        this.settings.caldavPasswordSecretId = DEFAULT_FASTMAIL_SECRET_ID;
        delete (this.settings as Partial<KnoxTimelineSettings & { caldavPassword?: string }>)
          .caldavPassword;
        await this.saveSettings();
        new Notice(
          "Knox Timeline: your Fastmail password was moved to Obsidian's secret storage.",
        );
      } catch (e) {
        console.warn("Knox Timeline: failed to migrate legacy password to SecretStorage:", e);
      }
    }
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Returns the resolved Fastmail password from SecretStorage, or empty string if unset. */
  fastmailPassword(): string {
    const id = this.settings.caldavPasswordSecretId;
    if (!id) return "";
    return this.app.secretStorage.getSecret(id) ?? "";
  }

  daysInWindow(): Date[] {
    const count = this.settings.viewMode === "two-day" ? 2 : 1;
    const out: Date[] = [];
    for (let i = 0; i < count; i++) {
      out.push(
        new Date(
          this.anchorDate.getFullYear(),
          this.anchorDate.getMonth(),
          this.anchorDate.getDate() + i,
        ),
      );
    }
    return out;
  }

  shiftAnchor(deltaDays: number): void {
    this.anchorDate = new Date(
      this.anchorDate.getFullYear(),
      this.anchorDate.getMonth(),
      this.anchorDate.getDate() + deltaDays,
    );
    this.requestRefresh();
  }

  jumpToToday(): void {
    this.anchorDate = startOfDay(new Date());
    this.requestRefresh();
  }

  setAnchor(d: Date): void {
    this.anchorDate = startOfDay(d);
    this.requestRefresh();
  }

  toggleMonthCalendar(): void {
    this.settings.monthCalendarVisible = !this.settings.monthCalendarVisible;
    void this.saveSettings();
    this.rerenderView();
  }

  setViewMode(mode: ViewMode): void {
    this.settings.viewMode = mode;
    void this.saveSettings();
    this.requestRefresh();
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(TIMELINE_VIEW_TYPE);
    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf: WorkspaceLeaf | null = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: TIMELINE_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }

  hideEvent(uid: string, title: string): void {
    if (!uid) return;
    if (this.settings.hiddenEvents.some((h) => h.uid === uid)) return;
    this.settings.hiddenEvents.push({ uid, title });
    this.rerenderView();
    void this.saveSettings();
  }
  unhideEvent(uid: string): void {
    this.settings.hiddenEvents = this.settings.hiddenEvents.filter((h) => h.uid !== uid);
    this.rerenderView();
    void this.saveSettings();
  }
  isHidden(uid: string): boolean {
    return this.settings.hiddenEvents.some((h) => h.uid === uid);
  }

  rerenderView(): void {
    const cache = this.settings.cachedSnapshot;
    if (!cache) return;
    this.getActiveView()?.applyState({ kind: "ok", snapshot: cache });
  }
  toggleShowHidden(): void {
    this.showHiddenEvents = !this.showHiddenEvents;
    this.rerenderView();
  }

  openSettings(): void {
    const setting = (this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } })
      .setting;
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  onViewActivated(view: TimelineView): void {
    const cache = this.settings.cachedSnapshot;
    if (cache) {
      view.applyState({ kind: "ok", snapshot: cache });
    }
    if (!cache || Date.now() - cache.fetchedAt > STALE_AFTER_MS) {
      void this.requestRefresh();
    }
  }

  requestRefresh(): void {
    if (this.fetchInFlight) return;
    this.fetchInFlight = this.runFetch().finally(() => {
      this.fetchInFlight = null;
    });
  }

  private async runFetch(): Promise<void> {
    const view = this.getActiveView();
    const { caldavUsername } = this.settings;
    const caldavPassword = this.fastmailPassword();
    const hasFastmailCreds = !!(caldavUsername && caldavPassword);
    const enabledIcalUrls = (this.settings.icalUrls ?? []).filter((c) => c.enabled);

    if (!hasFastmailCreds && enabledIcalUrls.length === 0) {
      view?.applyState({
        kind: "error",
        message: "No calendars configured.",
        openSettings: true,
      });
      return;
    }
    if (view && !this.settings.cachedSnapshot) {
      view.applyState({ kind: "loading" });
    }

    const days = this.daysInWindow();
    const windowStart = days[0];
    const windowEnd = new Date(
      days[days.length - 1].getFullYear(),
      days[days.length - 1].getMonth(),
      days[days.length - 1].getDate() + 1,
    );

    let fmCalendars: CalCalendar[] = [];
    let fmEvents: CalEvent[] = [];
    let fmError: Error | null = null;

    if (hasFastmailCreds) {
      try {
        fmCalendars = await fetchCalendars(caldavUsername, caldavPassword);
        this.lastKnownCalendars = fmCalendars;

        const knownIds = new Set(this.settings.knownCalendarIds);
        const enabled = new Set(this.settings.enabledCalendarIds);
        let added = false;
        for (const c of fmCalendars) {
          if (!knownIds.has(c.id)) {
            enabled.add(c.id);
            knownIds.add(c.id);
            added = true;
          }
        }
        if (added) {
          this.settings.knownCalendarIds = [...knownIds];
          this.settings.enabledCalendarIds = [...enabled];
        }

        const enabledCals = fmCalendars.filter((c) =>
          this.settings.enabledCalendarIds.includes(c.id),
        );
        if (enabledCals.length > 0) {
          fmEvents = await fetchEventsForCalendars(
            caldavUsername,
            caldavPassword,
            enabledCals,
            windowStart,
            windowEnd,
          );
        }
      } catch (e) {
        fmError = e as Error;
      }
    }

    // iCal URL fetches: parallel, individual failures don't block the rest.
    const icalResults = await Promise.allSettled(
      enabledIcalUrls.map((c) => fetchIcalUrlEvents(c, windowStart, windowEnd)),
    );
    const icalCalendars = enabledIcalUrls.map((c) => icalCalendar(c));
    const icalEvents: CalEvent[] = [];
    for (let i = 0; i < icalResults.length; i++) {
      const r = icalResults[i];
      if (r.status === "fulfilled") {
        icalEvents.push(...r.value);
      } else {
        console.warn(
          `Knox Timeline: iCal fetch failed for "${enabledIcalUrls[i].name}":`,
          r.reason,
        );
      }
    }

    // If Fastmail failed and that's the user's only configured source, surface the Fastmail error.
    if (fmError && enabledIcalUrls.length === 0) {
      const cached = this.settings.cachedSnapshot;
      if (fmError instanceof CalDavAuthError) {
        if (cached) {
          this.getActiveView()?.applyState({
            kind: "error-cached",
            message: "Invalid Fastmail credentials · Open Settings",
            snapshot: cached,
          });
        } else {
          this.getActiveView()?.applyState({
            kind: "error",
            message: "Invalid Fastmail credentials",
            openSettings: true,
          });
        }
        new Notice("Knox Timeline: Fastmail rejected the credentials.");
      } else {
        const msg =
          fmError instanceof CalDavNetworkError
            ? fmError.message
            : `Couldn't reach Fastmail: ${fmError.message}`;
        if (cached) {
          this.getActiveView()?.applyState({
            kind: "error-cached",
            message: "Couldn't reach Fastmail",
            snapshot: cached,
          });
        } else {
          this.getActiveView()?.applyState({
            kind: "error",
            message: msg,
            openSettings: false,
          });
        }
      }
      return;
    }

    // Fastmail is configured but no calendars are enabled, and there are no iCal URLs to fall back on.
    if (
      hasFastmailCreds &&
      !fmError &&
      this.settings.knownCalendarIds.length > 0 &&
      this.settings.enabledCalendarIds.length === 0 &&
      icalCalendars.length === 0
    ) {
      view?.applyState({ kind: "empty-no-calendars" });
      return;
    }

    const snapshot: ScheduleSnapshot = {
      fetchedAt: Date.now(),
      windowStart: windowStart.getTime(),
      windowEnd: windowEnd.getTime(),
      events: [...fmEvents, ...icalEvents],
      calendars: [...fmCalendars, ...icalCalendars],
    };
    this.settings.cachedSnapshot = snapshot;
    await this.saveSettings();

    this.getActiveView()?.applyState({ kind: "ok", snapshot });
  }

  private getActiveView(): TimelineView | null {
    const leaves = this.app.workspace.getLeavesOfType(TIMELINE_VIEW_TYPE);
    if (leaves.length === 0) return null;
    const v = leaves[0].view;
    return v instanceof TimelineView ? v : null;
  }

  scheduleNowLineTimer(): void {
    if (this.nowLineTimer !== null) {
      window.clearInterval(this.nowLineTimer);
      this.nowLineTimer = null;
    }
    const minutes = this.settings.nowLineRefreshMinutes;
    if (!minutes || minutes <= 0) return;
    const intervalMs = minutes * 60 * 1000;
    this.nowLineTimer = window.setInterval(() => {
      this.getActiveView()?.tickNowLine();
    }, intervalMs);
  }

  private scheduleMidnightTimer(): void {
    if (this.midnightTimer !== null) {
      window.clearTimeout(this.midnightTimer);
    }
    const now = new Date();
    const nextMidnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0,
      0,
      30,
      0,
    );
    const delay = nextMidnight.getTime() - now.getTime();
    this.midnightTimer = window.setTimeout(() => {
      this.requestRefresh();
      this.scheduleMidnightTimer();
    }, delay);
  }
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
