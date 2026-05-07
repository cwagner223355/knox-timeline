import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import {
  DEFAULT_SETTINGS,
  type CalCalendar,
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
import { TimelineView, TIMELINE_VIEW_TYPE } from "./view";
import { KnoxTimelineSettingTab } from "./settings";

const STALE_AFTER_MS = 5 * 60 * 1000;

export default class KnoxTimelinePlugin extends Plugin {
  settings!: KnoxTimelineSettings;
  lastKnownCalendars: CalCalendar[] = [];
  showHiddenEvents = false;
  private anchorDate: Date = startOfDay(new Date());
  private midnightTimer: number | null = null;
  private fetchInFlight: Promise<void> | null = null;

  async onload() {
    await this.loadSettings();
    this.lastKnownCalendars = this.settings.cachedSnapshot?.calendars ?? [];

    this.registerView(TIMELINE_VIEW_TYPE, (leaf) => new TimelineView(leaf, this));
    this.addSettingTab(new KnoxTimelineSettingTab(this.app, this));

    this.addCommand({
      id: "open-timeline-leaf",
      name: "Open Timeline",
      callback: () => this.activateView(),
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
    });
  }

  async onunload() {
    if (this.midnightTimer !== null) {
      window.clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
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

  setViewMode(mode: ViewMode): void {
    this.settings.viewMode = mode;
    void this.saveSettings();
    this.requestRefresh();
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(TIMELINE_VIEW_TYPE);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf: WorkspaceLeaf | null = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: TIMELINE_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
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
    const { caldavUsername, caldavPassword } = this.settings;

    if (!caldavUsername || !caldavPassword) {
      view?.applyState({
        kind: "error",
        message: "Fastmail credentials not configured.",
        openSettings: true,
      });
      return;
    }
    if (this.settings.enabledCalendarIds.length === 0 && this.settings.knownCalendarIds.length > 0) {
      view?.applyState({ kind: "empty-no-calendars" });
      return;
    }
    if (view && !this.settings.cachedSnapshot) {
      view.applyState({ kind: "loading" });
    }

    try {
      const calendars = await fetchCalendars(caldavUsername, caldavPassword);
      this.lastKnownCalendars = calendars;

      const knownIds = new Set(this.settings.knownCalendarIds);
      const enabled = new Set(this.settings.enabledCalendarIds);
      let added = false;
      for (const c of calendars) {
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
      if (this.settings.enabledCalendarIds.length === 0) {
        view?.applyState({ kind: "empty-no-calendars" });
        return;
      }

      const enabledCals = calendars.filter((c) => this.settings.enabledCalendarIds.includes(c.id));

      const days = this.daysInWindow();
      const windowStart = days[0];
      const windowEnd = new Date(
        days[days.length - 1].getFullYear(),
        days[days.length - 1].getMonth(),
        days[days.length - 1].getDate() + 1,
      );

      const events = await fetchEventsForCalendars(
        caldavUsername,
        caldavPassword,
        enabledCals,
        windowStart,
        windowEnd,
      );

      const snapshot: ScheduleSnapshot = {
        fetchedAt: Date.now(),
        windowStart: windowStart.getTime(),
        windowEnd: windowEnd.getTime(),
        events,
        calendars,
      };
      this.settings.cachedSnapshot = snapshot;
      await this.saveSettings();

      this.getActiveView()?.applyState({ kind: "ok", snapshot });
    } catch (e) {
      const cached = this.settings.cachedSnapshot;
      if (e instanceof CalDavAuthError) {
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
        const msg = e instanceof CalDavNetworkError ? e.message : `Couldn't reach Fastmail: ${(e as Error).message}`;
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
    }
  }

  private getActiveView(): TimelineView | null {
    const leaves = this.app.workspace.getLeavesOfType(TIMELINE_VIEW_TYPE);
    if (leaves.length === 0) return null;
    const v = leaves[0].view;
    return v instanceof TimelineView ? v : null;
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
