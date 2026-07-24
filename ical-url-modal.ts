import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type { IcalUrlConfig } from "./types";
import { normalizeIcalUrl } from "./ical-url";

const DEFAULT_COLOR = "#7d7d7d";

export class IcalUrlModal extends Modal {
  private name: string;
  private url: string;
  private color: string;
  private enabled: boolean;
  private readonly initialId: string | null;
  private readonly onSubmit: (cfg: IcalUrlConfig) => void | Promise<void>;

  constructor(
    app: App,
    initial: IcalUrlConfig | null,
    onSubmit: (cfg: IcalUrlConfig) => void | Promise<void>,
  ) {
    super(app);
    this.name = initial?.name ?? "";
    this.url = initial?.url ?? "";
    this.color = initial?.color ?? DEFAULT_COLOR;
    this.enabled = initial?.enabled ?? true;
    this.initialId = initial?.id ?? null;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.initialId ? "Edit iCal URL" : "Add iCal URL");

    new Setting(contentEl)
      .setName("Name")
      .setDesc("Shown in the calendar list and on event pills.")
      .addText((t) =>
        t
          .setPlaceholder("e.g. Google – Personal")
          .setValue(this.name)
          .onChange((v) => {
            this.name = v;
          }),
      );

    new Setting(contentEl)
      .setName("URL")
      .setDesc("Public or secret .ics URL. webcal:// links are accepted.")
      .addText((t) =>
        t
          .setPlaceholder("https://calendar.google.com/calendar/ical/.../basic.ics")
          .setValue(this.url)
          .onChange((v) => {
            this.url = v;
          }),
      );

    new Setting(contentEl)
      .setName("Color")
      .setDesc("Used for events from this calendar.")
      .addColorPicker((cp) =>
        cp.setValue(this.color).onChange((v) => {
          this.color = v;
        }),
      );

    new Setting(contentEl)
      .setName("Enabled")
      .setDesc("Include events from this URL in the timeline.")
      .addToggle((tog) =>
        tog.setValue(this.enabled).onChange((v) => {
          this.enabled = v;
        }),
      );

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
    new ButtonComponent(buttons)
      .setButtonText(this.initialId ? "Save" : "Add")
      .setCta()
      .onClick(() => this.submit());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    const name = this.name.trim();
    const url = normalizeIcalUrl(this.url);
    if (!name) {
      new Notice("Knox Timeline: name is required.");
      return;
    }
    if (!/^https:\/\//i.test(url)) {
      new Notice("Knox Timeline: URL must start with https:// (or webcal://).");
      return;
    }
    const id = this.initialId ?? generateId();
    void this.onSubmit({
      id,
      name,
      url,
      color: this.color,
      enabled: this.enabled,
    });
    this.close();
  }
}

function generateId(): string {
  // Use crypto.randomUUID when available; fall back to a simple base-36 timestamp+random.
  const c = (window as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
