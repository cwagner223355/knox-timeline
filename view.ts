import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import type KnoxTimelinePlugin from "./main";
import type { CalCalendar, CalEvent, ScheduleSnapshot, ViewMode } from "./types";
import {
  busyCalUrl,
  eventEndLocal,
  eventStartLocal,
  eventTouchesDay,
  findVideoLink,
  formatYmd,
  hexToRgba,
} from "./event-utils";
import { noteExistsForEvent, openOrCreateNote } from "./note-creator";
import { openEventPopup } from "./popup";

export const TIMELINE_VIEW_TYPE = "knox-timeline";

const HOUR_HEIGHT = 40;
const AXIS_START_HOUR = 6;
const AXIS_END_HOUR = 24;
const TOTAL_HOURS = AXIS_END_HOUR - AXIS_START_HOUR;
const TIMELINE_HEIGHT = TOTAL_HOURS * HOUR_HEIGHT;
const MIN_EVENT_HEIGHT_PX = 18;
const SHORT_EVENT_THRESHOLD_MS = 30 * 60 * 1000;

export type ViewState =
  | { kind: "loading" }
  | { kind: "ok"; snapshot: ScheduleSnapshot }
  | { kind: "error-cached"; message: string; snapshot: ScheduleSnapshot }
  | { kind: "error"; message: string; openSettings: boolean }
  | { kind: "empty-no-calendars" };

export class TimelineView extends ItemView {
  plugin: KnoxTimelinePlugin;
  state: ViewState = { kind: "loading" };
  private monthCursor: Date | null = null;
  private lastMonthVisible = false;

  constructor(leaf: WorkspaceLeaf, plugin: KnoxTimelinePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return TIMELINE_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Timeline";
  }
  getIcon(): string {
    return "calendar-clock";
  }

  async onOpen(): Promise<void> {
    this.render();
    this.plugin.onViewActivated(this);
  }
  async onClose(): Promise<void> {}

  applyState(state: ViewState): void {
    this.state = state;
    this.render();
  }

  tickNowLine(): void {
    const cols = this.containerEl.querySelectorAll(".knox-tl-day-col");
    if (cols.length === 0) return;
    const days = this.plugin.daysInWindow();
    cols.forEach((col, idx) => {
      if (idx >= days.length) return;
      col.querySelectorAll(".knox-tl-now-line").forEach((el) => el.remove());
      this.renderNowLine(col as HTMLElement, days[idx]);
    });
  }

  private render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("knox-tl-root");

    this.renderHeader(root);

    if (this.plugin.settings.monthCalendarVisible) {
      this.renderMonthCalendar(root);
    } else {
      this.lastMonthVisible = false;
    }

    switch (this.state.kind) {
      case "loading":
        root.createDiv({ cls: "knox-tl-loading", text: "Loading…" });
        break;
      case "ok":
        this.renderTimeline(root, this.state.snapshot, null);
        break;
      case "error-cached":
        this.renderTimeline(root, this.state.snapshot, this.state.message);
        break;
      case "error":
        this.renderError(root, this.state.message, this.state.openSettings);
        break;
      case "empty-no-calendars":
        this.renderNoCalendars(root);
        break;
    }
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "knox-tl-header" });

    const back = header.createEl("button", { cls: "knox-tl-icon-btn" });
    setIcon(back, "chevron-left");
    back.setAttr("aria-label", "Previous day");
    back.onclick = () => this.plugin.shiftAnchor(-1);

    const mode = this.plugin.settings.viewMode;
    const modeBtn = header.createEl("button", { cls: "knox-tl-mode-btn" });
    modeBtn.setText(mode === "two-day" ? "2 days" : "1 day");
    modeBtn.setAttr("aria-label", `Toggle view (currently ${mode === "two-day" ? "2 days" : "1 day"})`);
    modeBtn.onclick = () => {
      const next: ViewMode = mode === "two-day" ? "single" : "two-day";
      this.plugin.setViewMode(next);
    };

    const today = header.createEl("button", { cls: "knox-tl-today-btn", text: "Today" });
    today.setAttr("aria-label", "Jump to today");
    today.onclick = () => this.plugin.jumpToToday();

    const fwd = header.createEl("button", { cls: "knox-tl-icon-btn" });
    setIcon(fwd, "chevron-right");
    fwd.setAttr("aria-label", "Next day");
    fwd.onclick = () => this.plugin.shiftAnchor(1);

    header.createDiv({ cls: "knox-tl-header-spacer" });

    const monthOn = this.plugin.settings.monthCalendarVisible;
    const monthBtn = header.createEl("button", {
      cls: "knox-tl-icon-btn" + (monthOn ? " is-active" : ""),
    });
    setIcon(monthBtn, "calendar-days");
    monthBtn.setAttr("aria-label", monthOn ? "Hide month calendar" : "Show month calendar");
    monthBtn.onclick = () => this.plugin.toggleMonthCalendar();

    const showing = this.plugin.showHiddenEvents;
    const eyeBtn = header.createEl("button", { cls: "knox-tl-icon-btn" });
    setIcon(eyeBtn, showing ? "eye" : "eye-off");
    eyeBtn.setAttr("aria-label", showing ? "Hide hidden events" : "Show hidden events");
    eyeBtn.onclick = () => this.plugin.toggleShowHidden();

    const settingsBtn = header.createEl("button", { cls: "knox-tl-icon-btn" });
    setIcon(settingsBtn, "settings");
    settingsBtn.setAttr("aria-label", "Open Knox Timeline settings");
    settingsBtn.onclick = () => this.plugin.openSettings();

    const refreshBtn = header.createEl("button", { cls: "knox-tl-icon-btn" });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.setAttr("aria-label", "Refresh");
    refreshBtn.onclick = () => this.plugin.requestRefresh();
  }

  private renderError(root: HTMLElement, message: string, openSettings: boolean): void {
    const banner = root.createDiv({ cls: "knox-tl-banner-error" });
    banner.createSpan({ text: message });
    if (openSettings) {
      const link = banner.createEl("a", { text: "Open Settings", cls: "knox-tl-banner-link" });
      link.onclick = (e) => {
        e.preventDefault();
        this.plugin.openSettings();
      };
    } else {
      const retry = banner.createEl("button", { text: "Retry", cls: "knox-tl-banner-link" });
      retry.onclick = () => this.plugin.requestRefresh();
    }
  }

  private renderMonthCalendar(root: HTMLElement): void {
    const anchor = this.plugin.daysInWindow()[0];
    const today = new Date();
    const weekStart = this.plugin.settings.weekStartsOn ?? 0;

    // Reset cursor to anchor's month when calendar is freshly opened.
    // After that, prev/next navigation moves freely without auto-resetting.
    if (!this.lastMonthVisible || !this.monthCursor) {
      this.monthCursor = startOfMonth(anchor);
    }
    this.lastMonthVisible = true;
    const cursor = this.monthCursor;

    const wrap = root.createDiv({ cls: "knox-tl-month" });

    const head = wrap.createDiv({ cls: "knox-tl-month-head" });
    const prev = head.createEl("button", { cls: "knox-tl-icon-btn" });
    setIcon(prev, "chevron-left");
    prev.setAttr("aria-label", "Previous month");
    prev.onclick = () => {
      this.monthCursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1);
      this.render();
    };

    const label = head.createDiv({ cls: "knox-tl-month-label" });
    label.setText(formatMonthYear(cursor));

    const next = head.createEl("button", { cls: "knox-tl-icon-btn" });
    setIcon(next, "chevron-right");
    next.setAttr("aria-label", "Next month");
    next.onclick = () => {
      this.monthCursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      this.render();
    };

    const grid = wrap.createDiv({ cls: "knox-tl-month-grid" });

    const dowLabels =
      weekStart === 1
        ? ["M", "T", "W", "T", "F", "S", "S"]
        : ["S", "M", "T", "W", "T", "F", "S"];
    for (const dow of dowLabels) {
      grid.createDiv({ cls: "knox-tl-month-dow", text: dow });
    }

    const firstOfMonth = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const offsetFromWeekStart =
      weekStart === 1
        ? (firstOfMonth.getDay() + 6) % 7
        : firstOfMonth.getDay();
    const gridStart = new Date(
      firstOfMonth.getFullYear(),
      firstOfMonth.getMonth(),
      1 - offsetFromWeekStart,
    );

    for (let i = 0; i < 42; i++) {
      const d = new Date(
        gridStart.getFullYear(),
        gridStart.getMonth(),
        gridStart.getDate() + i,
      );
      const cell = grid.createDiv({ cls: "knox-tl-month-day" });
      cell.setText(String(d.getDate()));
      if (d.getMonth() !== cursor.getMonth()) cell.addClass("is-other-month");
      if (sameDay(d, today)) cell.addClass("is-today");
      if (sameDay(d, anchor)) cell.addClass("is-selected");
      cell.onclick = () => this.plugin.setAnchor(d);
    }
  }

  private renderNoCalendars(root: HTMLElement): void {
    const banner = root.createDiv({ cls: "knox-tl-empty" });
    banner.createSpan({ text: "No calendars enabled · " });
    const link = banner.createEl("a", { text: "Open Settings", cls: "knox-tl-banner-link" });
    link.onclick = (e) => {
      e.preventDefault();
      this.plugin.openSettings();
    };
  }

  private renderTimeline(
    root: HTMLElement,
    snapshot: ScheduleSnapshot,
    errorMsg: string | null,
  ): void {
    if (errorMsg) {
      const banner = root.createDiv({ cls: "knox-tl-banner-error" });
      banner.createSpan({ text: errorMsg + " · " });
      const retry = banner.createEl("button", { text: "Retry", cls: "knox-tl-banner-link" });
      retry.onclick = () => this.plugin.requestRefresh();
    }

    const calendarMap = new Map<string, CalCalendar>();
    for (const c of snapshot.calendars) calendarMap.set(c.id, c);

    const days = this.plugin.daysInWindow();

    const scroll = root.createDiv({ cls: "knox-tl-scroll" });
    if (days.length > 1) scroll.addClass("is-multi-day");
    const stickyHead = scroll.createDiv({ cls: "knox-tl-sticky-head" });

    const headers = stickyHead.createDiv({ cls: "knox-tl-day-headers" });
    headers.createDiv({ cls: "knox-tl-axis-cell" });
    for (let i = 0; i < days.length; i++) {
      const cell = headers.createDiv({ cls: "knox-tl-day-header knox-tl-day-header-clickable" });
      cell.setText(this.dayLabel(days[i]));
      const day = days[i];
      cell.setAttr("aria-label", "Open this day in BusyCal");
      cell.onclick = () => {
        const ymd = formatYmd(day);
        const url = `busycalevent://date/${ymd}T12:00:00`;
        window.open(url);
      };
    }

    const strip = stickyHead.createDiv({ cls: "knox-tl-all-day-strip" });
    strip.createDiv({ cls: "knox-tl-axis-cell knox-tl-all-day-axis", text: "all-day" });
    for (const day of days) {
      const cell = strip.createDiv({ cls: "knox-tl-all-day-cell" });
      const allDay = snapshot.events
        .filter((e) => e.showWithoutTime && eventTouchesDay(e, day))
        .filter((e) => this.plugin.showHiddenEvents || !this.plugin.isHidden(e.uid));
      for (const e of allDay) this.renderAllDayPill(cell, e, calendarMap);
    }

    const tl = scroll.createDiv({ cls: "knox-tl-grid" });
    tl.style.height = `${TIMELINE_HEIGHT}px`;

    const axis = tl.createDiv({ cls: "knox-tl-axis" });
    for (let h = AXIS_START_HOUR; h < AXIS_END_HOUR; h++) {
      const lbl = axis.createDiv({ cls: "knox-tl-hour-label" });
      lbl.style.top = `${(h - AXIS_START_HOUR) * HOUR_HEIGHT}px`;
      lbl.setText(formatHour(h));
    }

    for (const day of days) {
      const col = tl.createDiv({ cls: "knox-tl-day-col" });

      for (let h = 0; h < TOTAL_HOURS; h++) {
        const line = col.createDiv({ cls: "knox-tl-hour-line" });
        line.style.top = `${h * HOUR_HEIGHT}px`;
      }

      this.renderNowLine(col, day);

      this.attachEmptyAreaContextMenu(col, day);

      const dayEvents = snapshot.events
        .filter((e) => !e.showWithoutTime && eventTouchesDay(e, day))
        .filter((e) => this.plugin.showHiddenEvents || !this.plugin.isHidden(e.uid))
        .sort((a, b) => eventStartLocal(a).getTime() - eventStartLocal(b).getTime());

      const layouts = layoutWithLanes(dayEvents, day);
      for (const l of layouts) {
        this.renderEventBlock(col, l.event, day, calendarMap, l.lane, l.totalLanes);
      }
    }
  }

  private renderNowLine(col: HTMLElement, day: Date): void {
    const now = new Date();
    if (
      now.getFullYear() !== day.getFullYear() ||
      now.getMonth() !== day.getMonth() ||
      now.getDate() !== day.getDate()
    ) {
      return;
    }
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0);
    const hoursFromMidnight = (now.getTime() - dayStart.getTime()) / 3600000;
    const top = (hoursFromMidnight - AXIS_START_HOUR) * HOUR_HEIGHT;
    if (top < 0 || top > TIMELINE_HEIGHT) return;
    const line = col.createDiv({ cls: "knox-tl-now-line" });
    line.style.top = `${top}px`;
  }

  private renderEventBlock(
    col: HTMLElement,
    event: CalEvent,
    day: Date,
    calendarMap: Map<string, CalCalendar>,
    lane: number,
    totalLanes: number,
  ): void {
    const calId = Object.keys(event.calendarIds || {})[0];
    const cal = calId ? calendarMap.get(calId) : undefined;
    const color = cal?.color || "#7d7d7d";

    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600000);

    const realStart = eventStartLocal(event);
    const realEnd = eventEndLocal(event);
    const effStart = realStart < dayStart ? dayStart : realStart;
    const effEnd = realEnd > dayEnd ? dayEnd : realEnd;
    const durMs = effEnd.getTime() - effStart.getTime();
    if (durMs <= 0) return;

    const startHrFromMidnight = (effStart.getTime() - dayStart.getTime()) / 3600000;
    const naturalTop = (startHrFromMidnight - AXIS_START_HOUR) * HOUR_HEIGHT;
    const naturalHeight = (durMs / 3600000) * HOUR_HEIGHT;
    const naturalBottom = naturalTop + naturalHeight;

    // Clip the block to the visible axis range
    const renderTop = Math.max(0, naturalTop);
    const renderBottom = Math.min(TIMELINE_HEIGHT, naturalBottom);
    const visibleHeight = renderBottom - renderTop;
    if (visibleHeight <= 0) return;

    const renderHeight = Math.max(MIN_EVENT_HEIGHT_PX, visibleHeight);

    const block = col.createDiv({ cls: "knox-tl-event" });
    block.style.top = `${renderTop}px`;
    block.style.height = `${renderHeight}px`;
    block.style.backgroundColor = hexToRgba(color, 0.14);

    // Lane width and offset for overlapping events
    if (totalLanes > 1) {
      const lanePct = 100 / totalLanes;
      block.style.left = `calc(${lane * lanePct}% + 4px)`;
      block.style.width = `calc(${lanePct}% - 6px)`;
      block.addClass("knox-tl-event--lane-positioned");
    }

    if (this.plugin.isHidden(event.uid)) block.addClass("knox-event-hidden");
    if (durMs <= SHORT_EVENT_THRESHOLD_MS) block.addClass("knox-tl-event--short");

    const barHit = block.createDiv({ cls: "knox-tl-event-bar-hit" });
    const bar = barHit.createDiv({ cls: "knox-tl-event-bar" });
    bar.style.backgroundColor = color;
    barHit.onclick = (e) => {
      e.stopPropagation();
      openEventPopup(event, cal, barHit);
    };

    const body = block.createDiv({ cls: "knox-tl-event-body" });

    // Line 1: title + actions (icons)
    const line1 = body.createDiv({ cls: "knox-tl-event-line1" });
    const titleEl = line1.createDiv({ cls: "knox-tl-event-title" });
    titleEl.setText(event.title || "(untitled)");
    if (noteExistsForEvent(this.app, event)) {
      titleEl.addClass("knox-tl-has-note");
    } else {
      titleEl.addClass("knox-tl-pending");
    }

    const actions = line1.createDiv({ cls: "knox-tl-event-actions" });
    const video = findVideoLink(event);
    if (video) {
      const linkBtn = actions.createEl("button", { cls: "knox-tl-icon-mini" });
      linkBtn.style.color = color;
      setIcon(linkBtn, "link");
      linkBtn.setAttr("aria-label", `Join ${video.label}`);
      linkBtn.onclick = (e) => {
        e.stopPropagation();
        window.open(video.url);
      };
    }
    const calBtn = actions.createEl("button", { cls: "knox-tl-icon-mini" });
    calBtn.style.color = color;
    setIcon(calBtn, "calendar");
    calBtn.setAttr("aria-label", "Open in BusyCal");
    calBtn.onclick = (e) => {
      e.stopPropagation();
      window.open(busyCalUrl(event));
    };

    body.onclick = async () => {
      await openOrCreateNote(this.app, event);
      this.plugin.rerenderView();
    };

    this.attachHideMenu(block, event);
  }

  private renderAllDayPill(
    parent: HTMLElement,
    event: CalEvent,
    calendarMap: Map<string, CalCalendar>,
  ): void {
    const calId = Object.keys(event.calendarIds || {})[0];
    const cal = calId ? calendarMap.get(calId) : undefined;
    const color = cal?.color || "#7d7d7d";

    const pill = parent.createDiv({ cls: "knox-tl-all-day-pill" });
    pill.style.backgroundColor = hexToRgba(color, 0.18);
    pill.style.color = color;
    pill.setText(event.title || "(untitled)");
    if (this.plugin.isHidden(event.uid)) pill.addClass("knox-event-hidden");
    pill.onclick = async () => {
      await openOrCreateNote(this.app, event);
      this.plugin.rerenderView();
    };
    this.attachHideMenu(pill, event);
  }

  private attachEmptyAreaContextMenu(col: HTMLElement, day: Date): void {
    col.addEventListener("contextmenu", (evt) => {
      // Only fire on empty space — event blocks have their own handler that stopPropagation()s
      const inEvent = (evt.target as HTMLElement | null)?.closest(".knox-tl-event");
      if (inEvent) return;

      evt.preventDefault();
      const rect = col.getBoundingClientRect();
      const yInCol = evt.clientY - rect.top;
      const totalHour = AXIS_START_HOUR + yInCol / HOUR_HEIGHT;
      const hour = Math.max(0, Math.min(23, Math.floor(totalHour)));
      const rawMin = (totalHour - hour) * 60;
      const minute = Math.max(0, Math.min(30, Math.round(rawMin / 30) * 30));

      const clickDate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0);
      const timeLabel = formatClickTime(hour, minute);
      const monthName = clickDate.toLocaleDateString("en-US", { month: "long" });
      const dayNum = clickDate.getDate();
      const year = clickDate.getFullYear();
      const description = `New Event ${monthName} ${dayNum} ${year} at ${timeLabel}`;

      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle(`Add to calendar at ${timeLabel}`)
          .setIcon("plus")
          .onClick(() => {
            const url = `busycalevent://new/${encodeURIComponent(description)}`;
            window.open(url);
          }),
      );
      menu.showAtMouseEvent(evt);
    });
  }

  private attachHideMenu(el: HTMLElement, event: CalEvent): void {
    el.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const menu = new Menu();
      const hidden = this.plugin.isHidden(event.uid);
      if (hidden) {
        menu.addItem((item) =>
          item
            .setTitle("Unhide event")
            .setIcon("eye")
            .onClick(() => this.plugin.unhideEvent(event.uid)),
        );
      } else {
        menu.addItem((item) =>
          item
            .setTitle("Hide event")
            .setIcon("eye-off")
            .onClick(() => this.plugin.hideEvent(event.uid, event.title || "(untitled)")),
        );
      }
      menu.showAtMouseEvent(evt);
    });
  }

  private dayLabel(day: Date): string {
    const today = new Date();
    const isToday = sameDay(day, today);
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const isTomorrow = sameDay(day, tomorrow);
    const weekday = day.toLocaleDateString("en-US", { weekday: "short" });
    const dayNum = day.getDate();
    const ymd = formatYmd(day);

    if (this.plugin.settings.viewMode === "single") {
      if (isToday) return `Today · ${weekday} ${dayNum} (${ymd})`;
      if (isTomorrow) return `Tomorrow · ${weekday} ${dayNum} (${ymd})`;
      const longWeekday = day.toLocaleDateString("en-US", { weekday: "long" });
      return `${longWeekday} (${ymd})`;
    }
    if (isToday) return `Today (${weekday} ${dayNum})`;
    if (isTomorrow) return `Tomorrow (${weekday} ${dayNum})`;
    return `${weekday} ${dayNum}`;
  }
}

function formatHour(h: number): string {
  const ampm = h >= 12 ? "PM" : "AM";
  let hr = h % 12;
  if (hr === 0) hr = 12;
  return `${hr} ${ampm}`;
}

function formatClickTime(hour: number, minute: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  let h12 = hour % 12;
  if (h12 === 0) h12 = 12;
  const mm = String(minute).padStart(2, "0");
  return `${h12}:${mm} ${ampm}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function formatMonthYear(d: Date): string {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

interface EventLayout {
  event: CalEvent;
  lane: number;
  totalLanes: number;
}

/**
 * Assign each event a lane index within its overlap cluster.
 * Events that overlap in time share lanes; non-overlapping events stack vertically (lane 0).
 * Returns one entry per input event.
 */
function layoutWithLanes(events: CalEvent[], day: Date): EventLayout[] {
  if (events.length === 0) return [];
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEnd = dayStart + 24 * 3600000;

  // Compute the effective time window of each event clipped to this day
  const items = events.map((ev) => {
    const realStart = eventStartLocal(ev).getTime();
    const realEnd = eventEndLocal(ev).getTime();
    const effStart = Math.max(realStart, dayStart);
    const effEnd = Math.min(realEnd, dayEnd);
    return { event: ev, start: effStart, end: effEnd };
  });

  // Walk in start order, grouping into clusters of mutually overlapping events
  const layouts: EventLayout[] = [];
  let cluster: typeof items = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    // Greedy lane assignment within cluster
    const laneEnd: number[] = [];
    const laneOf = new Map<string, number>();
    for (const it of cluster) {
      let assigned = -1;
      for (let i = 0; i < laneEnd.length; i++) {
        if (laneEnd[i] <= it.start) {
          assigned = i;
          laneEnd[i] = it.end;
          break;
        }
      }
      if (assigned === -1) {
        laneEnd.push(it.end);
        assigned = laneEnd.length - 1;
      }
      laneOf.set(it.event.id, assigned);
    }
    const total = laneEnd.length;
    for (const it of cluster) {
      layouts.push({
        event: it.event,
        lane: laneOf.get(it.event.id) ?? 0,
        totalLanes: total,
      });
    }
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const it of items) {
    if (it.start >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();

  return layouts;
}
