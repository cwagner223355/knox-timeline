import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type KnoxTimelinePlugin from "./main";
import { CalDavAuthError, fetchCalendars } from "./caldav";
import { IcalUrlModal } from "./ical-url-modal";
import { DEFAULT_FASTMAIL_SECRET_ID, type IcalUrlConfig } from "./types";

export class KnoxTimelineSettingTab extends PluginSettingTab {
  plugin: KnoxTimelinePlugin;

  constructor(app: App, plugin: KnoxTimelinePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Fastmail username")
      .setDesc("Your full Fastmail email address (e.g. you@fastmail.com).")
      .addText((t) =>
        t
          .setPlaceholder("you@fastmail.com")
          .setValue(this.plugin.settings.caldavUsername)
          .onChange(async (v) => {
            this.plugin.settings.caldavUsername = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Fastmail app password")
      .setDesc(
        "Generate at Fastmail → Settings → Privacy & Security → App passwords. Give it Calendars (CalDAV) access only.",
      )
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(
            this.plugin.settings.caldavPasswordSecretId || DEFAULT_FASTMAIL_SECRET_ID,
          )
          .onChange(async (v) => {
            this.plugin.settings.caldavPasswordSecretId = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Default view")
      .setDesc("Single day or today + tomorrow side-by-side.")
      .addDropdown((d) =>
        d
          .addOption("single", "Single day")
          .addOption("two-day", "Today and Tomorrow")
          .setValue(this.plugin.settings.viewMode)
          .onChange(async (v) => {
            this.plugin.settings.viewMode = v as "single" | "two-day";
            await this.plugin.saveSettings();
            this.plugin.requestRefresh();
          }),
      );

    new Setting(containerEl)
      .setName("First day of week")
      .setDesc("Sets the leftmost column in the month calendar.")
      .addDropdown((d) =>
        d
          .addOption("0", "Sunday")
          .addOption("1", "Monday")
          .setValue(String(this.plugin.settings.weekStartsOn))
          .onChange(async (v) => {
            this.plugin.settings.weekStartsOn = v === "1" ? 1 : 0;
            await this.plugin.saveSettings();
            this.plugin.requestRefresh();
          }),
      );

    new Setting(containerEl)
      .setName("NOW Indicator Refresh")
      .setDesc("How often the red current-time line repositions itself, in minutes. 0 disables auto-refresh. Default 10.")
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.min = "0";
        t.inputEl.step = "1";
        t.setValue(String(this.plugin.settings.nowLineRefreshMinutes))
          .onChange(async (v) => {
            const parsed = parseInt(v, 10);
            const next = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
            this.plugin.settings.nowLineRefreshMinutes = next;
            await this.plugin.saveSettings();
            this.plugin.scheduleNowLineTimer();
          });
      });

    new Setting(containerEl)
      .setName("Refresh calendar list")
      .setDesc("Re-fetch the list of calendars from Fastmail. Run after entering credentials or after creating a new calendar.")
      .addButton((b) =>
        b.setButtonText("Refresh").onClick(async () => {
          await this.refreshCalendarList();
          await this.display();
        }),
      );

    containerEl.createEl("h3", { text: "Enabled calendars" });

    const known = this.plugin.lastKnownCalendars;
    if (known.length === 0) {
      containerEl.createEl("p", {
        text: "No calendars discovered yet. Enter credentials, then click Refresh above.",
      });
    } else {
      for (const cal of known) {
        new Setting(containerEl)
          .setName(cal.name)
          .setDesc(cal.color)
          .addToggle((tog) =>
            tog
              .setValue(this.plugin.settings.enabledCalendarIds.includes(cal.id))
              .onChange(async (on) => {
                const set = new Set(this.plugin.settings.enabledCalendarIds);
                if (on) set.add(cal.id);
                else set.delete(cal.id);
                this.plugin.settings.enabledCalendarIds = [...set];
                await this.plugin.saveSettings();
                this.plugin.requestRefresh();
              }),
          );
      }
    }

    containerEl.createEl("h3", { text: "External iCal URLs" });
    const icalDesc = containerEl.createEl("p");
    icalDesc.setText(
      "Add read-only iCal feeds (Google Calendar secret URL, iCloud public calendar, Outlook published calendar, etc.). Events appear in the timeline alongside Fastmail events.",
    );

    const icalUrls = this.plugin.settings.icalUrls ?? [];
    if (icalUrls.length === 0) {
      const empty = containerEl.createEl("p");
      empty.setText("No iCal URLs added yet.");
      empty.style.color = "var(--text-muted)";
      empty.style.fontStyle = "italic";
    } else {
      for (const cfg of [...icalUrls]) {
        new Setting(containerEl)
          .setName(cfg.name)
          .setDesc(truncateForDesc(cfg.url))
          .addToggle((tog) =>
            tog.setValue(cfg.enabled).onChange(async (on) => {
              this.updateIcalUrl({ ...cfg, enabled: on });
              await this.plugin.saveSettings();
              this.plugin.requestRefresh();
            }),
          )
          .addExtraButton((b) =>
            b
              .setIcon("pencil")
              .setTooltip("Edit")
              .onClick(() => this.openIcalUrlModal(cfg)),
          )
          .addExtraButton((b) =>
            b
              .setIcon("trash-2")
              .setTooltip("Remove")
              .onClick(async () => {
                this.plugin.settings.icalUrls = (this.plugin.settings.icalUrls ?? []).filter(
                  (c) => c.id !== cfg.id,
                );
                await this.plugin.saveSettings();
                this.plugin.requestRefresh();
                await this.display();
              }),
          );
      }
    }

    new Setting(containerEl)
      .setName("Add iCal URL")
      .setDesc("Paste a public or secret .ics URL.")
      .addButton((b) =>
        b
          .setButtonText("Add")
          .setCta()
          .onClick(() => this.openIcalUrlModal(null)),
      );

    containerEl.createEl("h3", { text: "Notes" });
    const notes = containerEl.createEl("p");
    notes.setText(
      "Your Fastmail app password is stored in Obsidian's secret storage and stays on this device — it does not sync with your vault.",
    );
    const sec = containerEl.createEl("p");
    sec.setText(
      "Network traffic to caldav.fastmail.com is HTTPS only, so credentials are encrypted in transit.",
    );
  }

  private openIcalUrlModal(initial: IcalUrlConfig | null): void {
    new IcalUrlModal(this.app, initial, async (cfg) => {
      this.updateIcalUrl(cfg);
      await this.plugin.saveSettings();
      this.plugin.requestRefresh();
      await this.display();
    }).open();
  }

  private updateIcalUrl(cfg: IcalUrlConfig): void {
    const list = [...(this.plugin.settings.icalUrls ?? [])];
    const idx = list.findIndex((c) => c.id === cfg.id);
    if (idx >= 0) list[idx] = cfg;
    else list.push(cfg);
    this.plugin.settings.icalUrls = list;
  }

  private async refreshCalendarList(): Promise<void> {
    const { caldavUsername } = this.plugin.settings;
    const caldavPassword = this.plugin.fastmailPassword();
    if (!caldavUsername || !caldavPassword) {
      new Notice("Knox Timeline: enter username and app password first.");
      return;
    }
    try {
      const cals = await fetchCalendars(caldavUsername, caldavPassword);
      const knownIds = new Set(this.plugin.settings.knownCalendarIds);
      const enabled = new Set(this.plugin.settings.enabledCalendarIds);
      for (const c of cals) {
        if (!knownIds.has(c.id)) {
          enabled.add(c.id);
          knownIds.add(c.id);
        }
      }
      this.plugin.settings.knownCalendarIds = [...knownIds];
      this.plugin.settings.enabledCalendarIds = [...enabled];
      this.plugin.lastKnownCalendars = cals;
      await this.plugin.saveSettings();
      new Notice(`Knox Timeline: ${cals.length} calendar(s) discovered.`);
      this.plugin.requestRefresh();
    } catch (e) {
      if (e instanceof CalDavAuthError) {
        new Notice("Knox Timeline: Fastmail rejected the credentials.");
      } else {
        new Notice(`Knox Timeline: ${(e as Error).message}`);
      }
    }
  }
}

function truncateForDesc(s: string): string {
  if (s.length <= 60) return s;
  return s.slice(0, 30) + "…" + s.slice(-25);
}
