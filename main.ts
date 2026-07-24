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
import { TimelineView, TIMELINE_VIEW_TYPE, type ViewState } from "./view";
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
  private refreshQueued = false;

  async onload() {
    await this.loadSettings();
    this.lastKnownCalendars = this.settings.cachedSnapshot?.calendars ?? [];

    this.registerView(TIMELINE_VIEW_TYPE, (leaf) => new TimelineView(leaf, this));
    this.addSettingTab(new KnoxTimelineSettingTab(this.app, this));

    this.addCommand({
      id: "open-timeline-leaf",
      name: "Open panel",
      callback: () => { void this.activateView(); },
    });
    this.addCommand({
      id: "refresh-timeline",
      name: "Refresh",
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
      // Only force the panel open on first install. On later launches Obsidian
      // restores the leaf if the user had it open; if they closed it, respect that.
      if (!this.settings.hasAutoOpened) {
        this.settings.hasAutoOpened = true;
        void this.saveSettings();
        void this.activateView();
      }
      this.requestRefresh();
      this.scheduleMidnightTimer();
      this.scheduleNowLineTimer();
    });
  }

  onunload() {
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
    this.settings = Object.assign(structuredClone(DEFAULT_SETTINGS), data);

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
    // Fall back to the default secret id: the settings component is seeded with
    // it, so a first-time user can store a password before the id is persisted
    // into settings, and we should still find it.
    const id = this.settings.caldavPasswordSecretId || DEFAULT_FASTMAIL_SECRET_ID;
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
    this.onAnchorChanged();
  }

  jumpToToday(): void {
    this.anchorDate = startOfDay(new Date());
    this.onAnchorChanged();
  }

  setAnchor(d: Date): void {
    this.anchorDate = startOfDay(d);
    this.onAnchorChanged();
  }

  /**
   * Re-render the visible window from cache immediately so the header and day
   * columns track the new anchor even while the fresh fetch is still running,
   * then kick off (or queue) that fetch.
   */
  private onAnchorChanged(): void {
    this.rerenderView();
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
    this.applyToAllViews({ kind: "ok", snapshot: cache });
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
      this.requestRefresh();
    }
  }

  requestRefresh(): void {
    // Coalesce refreshes: if a fetch is already running, remember that another
    // was asked for and run exactly one more once it settles. Without this,
    // rapid day navigation drops requests and the view keeps the old window.
    if (this.fetchInFlight) {
      this.refreshQueued = true;
      return;
    }
    this.startFetch();
  }

  private startFetch(): void {
    this.fetchInFlight = this.runFetch().finally(() => {
      this.fetchInFlight = null;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        this.startFetch();
      }
    });
  }

  private allViews(): TimelineView[] {
    return this.app.workspace
      .getLeavesOfType(TIMELINE_VIEW_TYPE)
      .map((l) => l.view)
      .filter((v): v is TimelineView => v instanceof TimelineView);
  }

  private applyToAllViews(state: ViewState): void {
    for (const v of this.allViews()) v.applyState(state);
  }

  private async runFetch(): Promise<void> {
    const { caldavUsername } = this.settings;
    const caldavPassword = this.fastmailPassword();
    const hasFastmailCreds = !!(caldavUsername && caldavPassword);
    const enabledIcalUrls = (this.settings.icalUrls ?? []).filter((c) => c.enabled);

    if (!hasFastmailCreds && enabledIcalUrls.length === 0) {
      this.applyToAllViews({
        kind: "error",
        message: "No calendars configured.",
        openSettings: true,
      });
      return;
    }
    if (!this.settings.cachedSnapshot) {
      this.applyToAllViews({ kind: "loading" });
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
    let icalFailureCount = 0;
    for (let i = 0; i < icalResults.length; i++) {
      const r = icalResults[i];
      if (r.status === "fulfilled") {
        icalEvents.push(...r.value);
      } else {
        icalFailureCount++;
        console.warn(
          `Knox Timeline: iCal fetch failed for "${enabledIcalUrls[i].name}":`,
          r.reason,
        );
      }
    }

    const fastmailFailed = hasFastmailCreds && !!fmError;
    const icalAllFailed =
      enabledIcalUrls.length > 0 && icalFailureCount === enabledIcalUrls.length;

    // No usable data this round: either the primary source (Fastmail) failed, or
    // Fastmail isn't configured and every iCal feed failed. Keep the last good
    // cache and show a banner. Never overwrite it with a partial or empty
    // snapshot, which would silently blank out the user's meetings.
    if (fastmailFailed || (!hasFastmailCreds && icalAllFailed)) {
      const cached = this.settings.cachedSnapshot;
      const isAuth = fmError instanceof CalDavAuthError;
      if (fastmailFailed) {
        new Notice(
          isAuth
            ? "Knox Timeline: Fastmail rejected the credentials."
            : "Knox Timeline: couldn't reach Fastmail.",
        );
      }
      if (cached) {
        const shortMsg = fastmailFailed
          ? isAuth
            ? "Invalid Fastmail credentials · Open Settings"
            : "Couldn't reach Fastmail"
          : "Couldn't refresh calendars";
        this.applyToAllViews({ kind: "error-cached", message: shortMsg, snapshot: cached });
      } else if (fastmailFailed) {
        const msg = isAuth
          ? "Invalid Fastmail credentials"
          : fmError instanceof CalDavNetworkError
            ? fmError.message
            : `Couldn't reach Fastmail: ${fmError?.message ?? "unknown error"}`;
        this.applyToAllViews({ kind: "error", message: msg, openSettings: isAuth });
      } else {
        this.applyToAllViews({
          kind: "error",
          message: "Couldn't reach any calendar feed.",
          openSettings: false,
        });
      }
      return;
    }

    // Fastmail is configured and healthy but no calendars are enabled, and there
    // are no iCal URLs to fall back on.
    if (
      hasFastmailCreds &&
      !fmError &&
      this.settings.knownCalendarIds.length > 0 &&
      this.settings.enabledCalendarIds.length === 0 &&
      icalCalendars.length === 0
    ) {
      this.applyToAllViews({ kind: "empty-no-calendars" });
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

    // Primary source succeeded. If some (but not all) iCal feeds failed, show the
    // fresh data with a non-blocking retry banner rather than hiding the failure.
    if (icalFailureCount > 0) {
      this.applyToAllViews({
        kind: "error-cached",
        message: "Some calendar feeds couldn't be refreshed",
        snapshot,
      });
    } else {
      this.applyToAllViews({ kind: "ok", snapshot });
    }
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
      for (const v of this.allViews()) v.tickNowLine();
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
      // The day just rolled over. If the user was still looking at the day that
      // just ended (i.e. hadn't navigated away), advance the anchor to the new
      // today; otherwise just re-fetch and relabel wherever they are.
      const newToday = startOfDay(new Date());
      const justEnded = new Date(
        newToday.getFullYear(),
        newToday.getMonth(),
        newToday.getDate() - 1,
      );
      if (this.anchorDate.getTime() === justEnded.getTime()) {
        this.jumpToToday();
      } else {
        this.rerenderView();
        this.requestRefresh();
      }
      this.scheduleMidnightTimer();
    }, delay);
  }
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
