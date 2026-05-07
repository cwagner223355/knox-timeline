# Knox Timeline

A BusyCal-style timeline view of your Fastmail calendar in an Obsidian sidebar leaf, with one-click meeting note creation.

![Knox Timeline panel](assets/Knox%20Timeline%20Screenshot.png)

## Why this exists

I rely on BusyCal's two-day timeline view for daily planning, but I do most of my note-taking in Obsidian. Existing Obsidian calendar plugins lean toward month grids or to-do lists, neither of which answer "what does my day actually look like." Knox Timeline brings the timeline format into Obsidian's right sidebar, sourced from Fastmail via CalDAV, and lets me turn any event into a meeting note with one click.

## Features

- Single-day or two-day (today + tomorrow) timeline views
- All-day events shown in a strip above the timed grid
- Multi-calendar support with per-calendar enable/disable
- One-click meeting note creation from any event
- Hide noisy events (recurring blockers, declined invites) with the ability to unhide later
- Auto-refresh at midnight and on stale data
- Commands for previous/next day, jump to today, and refresh

## Install

### Via BRAT (recommended for now)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from the Community plugins directory.
2. In Obsidian: Settings → BRAT → **Add Beta plugin**.
3. Paste: `cwagner223355/knox-timeline`
4. Enable **Knox Timeline** in Community plugins.

Knox Timeline is not yet in the Community plugins directory.

## Setup

1. Generate a Fastmail app password: Fastmail → Settings → Privacy & Security → **App passwords**. Give it Calendars (CalDAV) access only.
2. Open Knox Timeline settings: enter your Fastmail email and app password.
3. Click **Refresh calendar list** to discover your calendars.
4. Toggle which calendars to include in the timeline.

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| Fastmail username | text | empty | Your full Fastmail email address. |
| Fastmail app password | password | empty | App password with Calendars (CalDAV) access. Stored in `data.json`; see security notes below. |
| Default view | dropdown | Single day | Single day or today + tomorrow side-by-side. |
| Enabled calendars | toggle list | all discovered | Which calendars to include in the timeline. |

## Commands

| Command | What it does |
|---|---|
| Open Timeline | Open the timeline panel in the right sidebar. |
| Refresh Timeline | Re-fetch events from Fastmail. |
| Previous day | Shift the timeline anchor back one day. |
| Next day | Shift the timeline anchor forward one day. |
| Jump to today | Reset the anchor to today. |

## Security notes

The Fastmail app password is currently stored in `.obsidian/plugins/knox-timeline/data.json` as plain text. If your vault syncs to the cloud (Obsidian Sync, iCloud, Dropbox, etc.), this file syncs with it. Two ways to handle this:

- **Use a scoped app password** (recommended): the password gives access to Calendars (CalDAV) only, not your full Fastmail account. Revoke at any time from Fastmail settings.
- **Exclude the plugin folder from sync** if you'd rather the password not leave the device.

A future release will migrate credential storage to Obsidian's `SecretStorage` API, which keeps secrets out of `data.json`.

Network traffic to `caldav.fastmail.com` is HTTPS only, so credentials are encrypted in transit.

## Known limitations

- Read-only: events cannot be created or edited from the timeline.
- Fastmail CalDAV only at present. Read-only iCal URL support (Google, iCloud, Outlook published calendars) is planned.
- Desktop only. Mobile support is not planned for v1.

## License

MIT — see [LICENSE](LICENSE).
