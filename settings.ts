import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type KnoxTimelinePlugin from "./main";
import { CalDavAuthError, fetchCalendars } from "./caldav";
import { FolderSuggest } from "./folder-suggest";
import { IcalUrlModal } from "./ical-url-modal";
import { DEFAULT_FASTMAIL_SECRET_ID, DEFAULT_SETTINGS, type IcalUrlConfig } from "./types";

export class KnoxTimelineSettingTab extends PluginSettingTab {
  plugin: KnoxTimelinePlugin;

  constructor(app: App, plugin: KnoxTimelinePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
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
      .setName("Now indicator refresh")
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
          this.display();
        }),
      );

    new Setting(containerEl).setName("Enabled calendars").setHeading();

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

    new Setting(containerEl).setName("External iCal URLs").setHeading();
    const icalDesc = containerEl.createEl("p");
    icalDesc.setText(
      "Add read-only iCal feeds (Google Calendar secret URL, iCloud public calendar, Outlook published calendar, etc.). Events appear in the timeline alongside Fastmail events.",
    );

    const icalUrls = this.plugin.settings.icalUrls ?? [];
    if (icalUrls.length === 0) {
      const empty = containerEl.createEl("p", { cls: "knox-tl-empty-note" });
      empty.setText("No iCal URLs added yet.");
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
                this.display();
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

    new Setting(containerEl).setName("Meeting notes").setHeading();

    new Setting(containerEl)
      .setName("Meeting note folder")
      .setDesc("Vault folder where notes created from an event are saved.")
      .addText((t) => {
        t
          .setPlaceholder(DEFAULT_SETTINGS.meetingNoteFolder)
          .setValue(this.plugin.settings.meetingNoteFolder)
          .onChange(async (v) => {
            this.plugin.settings.meetingNoteFolder =
              v.trim() || DEFAULT_SETTINGS.meetingNoteFolder;
            await this.plugin.saveSettings();
          });
        new FolderSuggest(this.app, t.inputEl).onSelect(async (folder) => {
          t.setValue(folder.path);
          this.plugin.settings.meetingNoteFolder = folder.path;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Meeting note template")
      .setDesc(
        "Body for new meeting notes. Leave blank to create an empty note (handy if another plugin fills in frontmatter). The variables below can be used anywhere in the template.",
      )
      .addTextArea((t) => {
        t.inputEl.rows = 8;
        t.inputEl.addClass("knox-tl-template-input");
        t
          .setPlaceholder("Leave blank for an empty note")
          .setValue(this.plugin.settings.meetingNoteTemplate)
          .onChange(async (v) => {
            this.plugin.settings.meetingNoteTemplate = v;
            await this.plugin.saveSettings();
          });
      });

    this.renderTemplateVariableHelp(containerEl);

    new Setting(containerEl).setName("Notes").setHeading();
    const notes = containerEl.createEl("p");
    notes.setText(
      "Your Fastmail app password is stored in Obsidian's secret storage and stays on this device — it does not sync with your vault.",
    );
    const cacheNote = containerEl.createEl("p");
    cacheNote.setText(
      "For offline display, the most recently fetched events (titles, times, attendees) are cached in this plugin's data.json. Unlike the password, that file does sync if your vault syncs.",
    );
    const sec = containerEl.createEl("p");
    sec.setText(
      "Network traffic to caldav.fastmail.com is HTTPS only, so credentials are encrypted in transit.",
    );
  }

  private renderTemplateVariableHelp(containerEl: HTMLElement): void {
    const wrap = containerEl.createDiv({ cls: "knox-tl-template-vars" });
    wrap.createEl("p", { cls: "knox-tl-template-vars-intro", text: "Template variables:" });
    const list = wrap.createEl("ul", { cls: "knox-tl-template-vars-list" });
    const vars: [string, string][] = [
      ["{{title}}", "Event title."],
      ["{{date}}", "Event date, as YYYY-MM-DD."],
      ["{{start_time}}", "Start time, e.g. 9:30 AM. Blank for all-day events."],
      ["{{end_time}}", "End time, e.g. 10:00 AM. Blank for all-day events."],
      ["{{video_url}}", "Detected Zoom / Google Meet / Teams link, or blank."],
      ["{{busycal_url}}", "busycalevent:// deep link that opens the event in BusyCal."],
      [
        "{{uid}}",
        "The event's unique id. Store it as event_uid to let the plugin re-open the right note and avoid duplicates.",
      ],
      ["{{daily_note}}", "Basename of that day's daily note, for a [[wikilink]]."],
    ];
    for (const [name, desc] of vars) {
      const li = list.createEl("li");
      li.createEl("code", { text: name });
      li.createSpan({ text: `: ${desc}` });
    }
  }

  private openIcalUrlModal(initial: IcalUrlConfig | null): void {
    new IcalUrlModal(this.app, initial, async (cfg) => {
      this.updateIcalUrl(cfg);
      await this.plugin.saveSettings();
      this.plugin.requestRefresh();
      this.display();
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
