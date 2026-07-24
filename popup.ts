import type { CalCalendar, CalEvent } from "./types";
import {
  busyCalUrl,
  eventDurationMs,
  eventEndLocal,
  eventStartLocal,
  findVideoLink,
  formatTime,
} from "./event-utils";

const GRACE_MS = 150;

interface ActivePopup {
  el: HTMLElement;
  anchor: HTMLElement;
  controller: AbortController;
  closeTimer: number | null;
}

let active: ActivePopup | null = null;

export function openEventPopup(
  event: CalEvent,
  calendar: CalCalendar | undefined,
  anchor: HTMLElement,
): void {
  closePopup();

  const popup = renderPopup(event, calendar);
  activeDocument.body.appendChild(popup);
  positionPopup(popup, anchor);

  const controller = new AbortController();
  const state: ActivePopup = { el: popup, anchor, controller, closeTimer: null };
  active = state;

  const scheduleClose = () => {
    if (state.closeTimer !== null) window.clearTimeout(state.closeTimer);
    state.closeTimer = window.setTimeout(() => {
      if (active !== state) return;
      if (popup.matches(":hover") || anchor.matches(":hover")) return;
      closePopup();
    }, GRACE_MS);
  };
  const cancelClose = () => {
    if (state.closeTimer !== null) {
      window.clearTimeout(state.closeTimer);
      state.closeTimer = null;
    }
  };

  const opts = { signal: controller.signal };
  anchor.addEventListener("mouseleave", scheduleClose, opts);
  popup.addEventListener("mouseleave", scheduleClose, opts);
  anchor.addEventListener("mouseenter", cancelClose, opts);
  popup.addEventListener("mouseenter", cancelClose, opts);

  // Bind to the window that actually hosts the popup (handles popout windows).
  const win = anchor.ownerDocument.defaultView ?? activeWindow;
  win.addEventListener(
    "mousedown",
    (e) => {
      const tgt = e.target as Node | null;
      if (tgt && (popup.contains(tgt) || anchor.contains(tgt))) return;
      closePopup();
    },
    opts,
  );
  win.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") closePopup();
    },
    opts,
  );
}

export function closePopup(): void {
  if (!active) return;
  active.controller.abort();
  if (active.closeTimer !== null) window.clearTimeout(active.closeTimer);
  active.el.remove();
  active = null;
}

function renderPopup(event: CalEvent, calendar: CalCalendar | undefined): HTMLElement {
  const popup = activeDocument.createElement("div");
  popup.className = "knox-hover-popup";

  const color = calendar?.color || "#7d7d7d";

  const titleRow = popup.createDiv({ cls: "knox-hover-title-row" });
  const colorBar = titleRow.createDiv({ cls: "knox-hover-color-bar" });
  colorBar.style.backgroundColor = color;
  titleRow.createDiv({ cls: "knox-hover-title", text: event.title || "(untitled)" });

  if (calendar) {
    const cal = popup.createDiv({ cls: "knox-hover-meta" });
    cal.setText(calendar.name);
  }

  const time = popup.createDiv({ cls: "knox-hover-time" });
  if (event.showWithoutTime) {
    time.setText("All day");
  } else {
    const start = eventStartLocal(event);
    const end = eventEndLocal(event);
    const mins = Math.round(eventDurationMs(event) / 60000);
    time.setText(`${formatTime(start)} – ${formatTime(end)}  ·  ${formatDurationLabel(mins)}`);
  }

  if (event.locations && Object.keys(event.locations).length > 0) {
    const sec = popup.createDiv({ cls: "knox-hover-section" });
    sec.createDiv({ cls: "knox-hover-section-title", text: "Location" });
    for (const loc of Object.values(event.locations)) {
      const v = loc.name || loc.description;
      if (v) sec.createDiv({ cls: "knox-hover-section-body", text: v });
    }
  }

  const video = findVideoLink(event);
  if (video) {
    const sec = popup.createDiv({ cls: "knox-hover-section" });
    sec.createDiv({ cls: "knox-hover-section-title", text: video.label });
    const a = sec.createEl("a", { cls: "knox-hover-link", text: video.url, href: video.url });
    a.target = "_blank";
  }

  if (event.participants && Object.keys(event.participants).length > 0) {
    const sec = popup.createDiv({ cls: "knox-hover-section" });
    sec.createDiv({ cls: "knox-hover-section-title", text: "Attendees" });
    const list = sec.createDiv({ cls: "knox-hover-section-body" });
    const lines: string[] = [];
    for (const p of Object.values(event.participants)) {
      const label = p.name || p.email || "(unknown)";
      lines.push(label);
    }
    list.setText(lines.join(", "));
  }

  if (event.description) {
    const sec = popup.createDiv({ cls: "knox-hover-section" });
    sec.createDiv({ cls: "knox-hover-section-title", text: "Description" });
    sec.createDiv({ cls: "knox-hover-section-body knox-hover-description", text: event.description });
  }

  const footer = popup.createDiv({ cls: "knox-hover-footer" });
  const link = footer.createEl("a", { text: "Open in BusyCal", href: busyCalUrl(event) });
  link.addClass("knox-hover-link");

  return popup;
}

function positionPopup(popup: HTMLElement, anchor: HTMLElement): void {
  const win = anchor.ownerDocument.defaultView ?? activeWindow;
  const rect = anchor.getBoundingClientRect();
  const popupW = 320;
  const margin = 8;
  popup.style.width = `${popupW}px`;

  let left = rect.left - popupW - margin;
  if (left < margin) left = rect.right + margin;
  if (left + popupW > win.innerWidth - margin) left = win.innerWidth - popupW - margin;

  let top = rect.top;
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;

  const ph = popup.getBoundingClientRect().height;
  if (top + ph > win.innerHeight - margin) {
    top = Math.max(margin, win.innerHeight - ph - margin);
    popup.style.top = `${top}px`;
  }
}

function formatDurationLabel(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (m === 0) return `${h} hr`;
  return `${h}h ${m}m`;
}
