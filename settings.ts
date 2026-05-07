import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type KnoxTimelinePlugin from "./main";
import { CalDavAuthError, fetchCalendars } from "./caldav";

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
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("xxxx-xxxx-xxxx-xxxx")
          .setValue(this.plugin.settings.caldavPassword)
          .onChange(async (v) => {
            this.plugin.settings.caldavPassword = v.trim();
            await this.plugin.saveSettings();
          });
      });

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

    if (this.plugin.settings.hiddenEvents.length > 0) {
      containerEl.createEl("h3", { text: "Hidden events" });
      for (const h of [...this.plugin.settings.hiddenEvents]) {
        new Setting(containerEl).setName(h.title).setDesc(h.uid).addButton((b) =>
          b.setButtonText("Unhide").onClick(async () => {
            this.plugin.unhideEvent(h.uid);
            await this.display();
          }),
        );
      }
    }

    containerEl.createEl("h3", { text: "Notes" });
    const notes = containerEl.createEl("p");
    notes.setText(
      "Plugin data lives at .obsidian/plugins/knox-timeline/data.json and includes your app password. If your vault syncs to the cloud, this file syncs with it. Add the folder to your sync exclusions if that's a concern.",
    );
    const sec = containerEl.createEl("p");
    sec.setText(
      "Network traffic to caldav.fastmail.com is HTTPS only, so credentials are encrypted in transit.",
    );
  }

  private async refreshCalendarList(): Promise<void> {
    const { caldavUsername, caldavPassword } = this.plugin.settings;
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
