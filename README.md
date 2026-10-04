<div align="center">

# OpenClaw Family Pack

**The household week in the [OpenClaw](https://github.com/openclaw/openclaw) Control UI: calendars, the day's weather, and a chat with any of your agents.**

Version 0.2.0.

[![Version](https://img.shields.io/github/package-json/v/DonnieFi/oc-family-pack?label=version&color=e08a3a)](package.json)
[![Status](https://img.shields.io/badge/status-0.2.0-orange)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/github/license/DonnieFi/oc-family-pack?color=4ea674)](LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-%E2%89%A5%202026.9.7-ff5c5c)](https://docs.openclaw.ai/plugins/feature-plugins)
[![Plugin type](https://img.shields.io/badge/plugin-feature-14b8a6)](https://docs.openclaw.ai/plugins/feature-plugins)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2024.16-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)

[![Google Calendar](https://img.shields.io/badge/calendar-Google%20via%20gog-4285f4?logo=googlecalendar&logoColor=white)](https://github.com/openclaw/gogcli)
[![Weather](https://img.shields.io/badge/weather-Environment%20Canada-d52b1e)](https://api.weather.gc.ca/)
[![Discord](https://img.shields.io/badge/chat-Discord%20%7C%20Control%20UI-5865f2?logo=discord&logoColor=white)](https://docs.openclaw.ai/channels/discord)
[![Last commit](https://img.shields.io/github/last-commit/DonnieFi/oc-family-pack)](https://github.com/DonnieFi/oc-family-pack/commits/main)

</div>

---

## What it is

Family Pack is an OpenClaw **feature plugin** (`oc-family-pack`) for a household. It adds a **Family** page to the Control UI, a **Today** widget on the dashboard, and family tools for your agents. You see the week you are allowed to see, ask what is on, and change a calendar when the rules below allow it.

The Family page does not need Discord. This version uses Discord for briefs, reminders, and for knowing who "me" is in chat. Control UI chat works as well. You do not pick another messaging service here.

It is built for the questions a household actually asks:

- *"What's on today?"*
- *"Do I have a class tomorrow?"*
- *"When is the dentist?"*
- *"Add soccer practice for Thursday at 5."*

Daily and weekly briefs stay short. Routine items fold into a single line so the unusual things stand out.

## Features

| Feature | What you get | Status |
| --- | --- | --- |
| Family page | Monday–Sunday week, a color per person, chips that dim events, Environment Canada weather, and a chat strip | Available |
| Today widget | Up to three highlight lines on the Control UI dashboard. Separate from the Today jump on the week grid | Available |
| Calendar changes | One write path from the page and from chat. A parent approves anything a kid cannot change alone. No undo | Available |
| Daily and weekly briefs | 07:00 daily and Sunday 20:00 weekly, posted to the Discord summary channel you configure | Available |
| Reminders | A lead time, quiet hours, and a per-person mode: direct message, summary channel, or off | Available |
| Household briefs | Optional weekday morning DM to parents, weekday after-school post, and a weekend preview | Available |
| Garbage day | Optional city calendar link. The `garbage_schedule` tool answers pickup questions | Available |
| Family skill | `skills/family/SKILL.md` teaches agents `family_today`, `family_schedule`, and `garbage_schedule` | Available |
| Chores | Parent-managed chores with kid check-off | Later |

## Requirements

| Requirement | Why |
| --- | --- |
| OpenClaw `2026.9.7` or newer | Feature plugin SDK (`feature-contract`, `feature-plugin`, `control-ui`). Tested on `2026.9.7`; see [Development](#development) for the post-update smoke. |
| Node.js `>=24.16.0 <25` or `>=26.1.0` | Matches the OpenClaw runtime |
| [`gog`](https://github.com/openclaw/gogcli) with Calendar access | Reads and writes Google Calendar using your existing sign-in. `gog` runs on the Gateway host |
| **Custom plugin UI** lab enabled | Required for native pages from non-bundled plugins |
| HTTPS or `127.0.0.1` | Native plugin pages need a secure origin |

Weather uses Environment Canada's public API, so it needs no key and covers Canadian locations only.

## Install

```bash
openclaw plugins install git:https://github.com/DonnieFi/oc-family-pack.git --accept-capabilities
```

The repository ships its built `dist/`, so a git install does not build. A different host build than the one this repo was tested against must rebuild `dist/` with that host. `--accept-capabilities` confirms the plugin's native Control UI page, which runs with the signed-in operator's Gateway permissions.

Calendar sign-in is `gog`, including on a headless Gateway. Run `openclaw family gog` and follow what it prints. A headless host takes two `gog auth add` commands: the first prints a URL, and the second exchanges the browser redirect (`openclaw family gog --auth-url '…'`). Repeat until it tells you to list calendars, then put those ids in the config below. The commands never pass `--readonly`. On a machine with a browser, `openclaw family gog --desktop` prints that sign-in instead of the two remote steps. If the Gateway service cannot see `gog` on `PATH`, set `gogPath` to the full path of the binary.

`openclaw family setup` shows what is left: access mode, time zone, location, members, and calendars, each marked Done or To do, then the next step. Add people with `--parent`, `--kid`, or `--guest`. It never writes config. It prints a members patch. Check it with `openclaw config patch --stdin --dry-run`, then run the same command without `--dry-run` to apply it. People already in the config are kept as they are. `--discord alex=ID` adds someone's Discord user id the same way. In LAN mode, setup also prints the `users.linkChannelIdentity` command that ties that id to the person's Gateway profile.

To try the page before you connect a calendar, set `demo: true` (see below). Add your configuration, then enable the plugin:

```bash
openclaw plugins enable oc-family-pack
```

Turn on native plugin pages in **Settings → Labs → Custom plugin UI**, or in config:

```json5
{
  gateway: {
    controlUi: {
      experimental: { customPlugins: true },
    },
  },
}
```

Then open **Family** from the Control UI sidebar. The page is `/plugin?plugin=oc-family-pack&id=family` on your Control UI origin.

## Configuration

Family Pack reads `plugins.entries["oc-family-pack"].config`. Each `profileId` is that person's trusted-proxy username (the value your proxy sends in `X-Forwarded-User`), stored in lower case. Family Pack matches it exactly, so it must be the same name the Gateway signs that person in as. It is not the Gateway's internal profile id. A member id sent by the browser is not identity. A calendar's owners are those same ids. A school calendar belongs to the student.

```json5
{
  plugins: {
    entries: {
      "oc-family-pack": {
        enabled: true,
        config: {
          timezone: "America/Toronto",
          location: { lat: 45.42, lon: -75.7, label: "Home" },
          members: [
            { profileId: "alex", displayName: "Alex", role: "parent" },
            { profileId: "sam", displayName: "Sam", role: "parent" },
            { profileId: "riley", displayName: "Riley", role: "kid" },
          ],
          calendars: [
            { id: "family@group.calendar.google.com", label: "Family", kind: "shared", owners: [] },
            { id: "alex@example.com", label: "Alex", kind: "personal", owners: ["alex"] },
            { id: "school-feed@group.calendar.google.com", label: "School", kind: "school", owners: ["riley"] },
          ],
        },
      },
    },
  },
}
```

Set `demo: true` to show a synthetic week before you connect a calendar. Demo does not invent a delivery row. Briefs still post only when `summaryChannel` is set, so leave that unset while you are only previewing the page.

Set `garbageIcsUrl` to your city's waste collection calendar, an `.ics` link such as a ReCollect feed (for a `webcal://` link, use `https://` instead). This is optional. The `garbage_schedule` tool then lists curbside pickups for today through the next 14 days. The feed is read at most once a week. If it is down, the last copy is used until the Gateway restarts.

Briefs and reminders use a channel you name. Each key in `channels` is a short name you choose. The value is that Discord channel's id. `summaryChannel` must be one of those keys. Daily and weekly briefs post only when it is set.

`reminderLeadMinutes` defaults to `[15]`. `quietHours` defaults to 22:00–07:00 (`startHour` 22, `endHour` 7) in the household time zone.

`morningTime`, `afterSchoolTime`, and `weekendPreviewTime` are optional clock times, `HH:MM` in 24-hour form. Leave a time unset to skip that household brief. `weekendPreviewWeekday` defaults to Friday (`5`). `0` is Sunday and `6` is Saturday.

`writes` defaults to `on`. Set it to `confirm` to hold every calendar change for a parent, or `off` to refuse calendar changes.

## The Family page

The week runs Monday through Sunday, in the household time zone. Each person has a color. The chips dim events in the view. They do not decide who you are, and they do not hide a calendar you are allowed to see.

The weather card shows current conditions, today's high and low, and the next forecast periods. It only works in Canada. Elsewhere the card says so.

The chat strip is labeled "Chat with". It opens any agent that signed-in person can already open. It does not grant a new agent.

The week grid has its own **Today** jump. That is not the dashboard widget. The widget id is `family-today`. It sits on the Control UI dashboard and shows up to three highlight lines. When the day is quiet it says "Looks like a quiet day — nothing urgent." When the read fails it says "Couldn't load today." Without read access it says "You need read access to see today." The week page, without read access, says "You need read access to see the family week."

The page also shows the latest delivery as one sentence, for example "Daily brief sent to Alex." or "No brief has been sent yet." It does not show a channel id or a clock time.

## Calendar changes

The page and chat share one write path. From the page, a change needs `operator.write`. In solo mode the shared owner has it. In LAN mode the parent role has it and the kid role does not. Without it the page says "This page is view-only for you, so I didn't change anything."

In Discord, a kid can change their own personal calendar. A change to a shared calendar, a school calendar, or someone else's calendar waits for a parent. Chat that is not Discord does not know which person is asking, so a change from there waits for a parent too. You can still ask what is on from Control UI chat.

Undo is not available. A change that already went through is not undone from the page or from chat.

## Briefs, reminders, and garbage

The daily brief posts at 07:00 in the household time zone. The send window runs until noon. If the Gateway is down at 07:00 and back before noon, that brief still goes out once. After noon it does not. The weekly brief posts Sunday at 20:00 (8:00 PM) for the coming week, and the window runs until Monday noon. Both post to the Discord summary channel, and only when `summaryChannel` is set.

Reminders use the lead times you set, 15 minutes if you set none. Quiet hours default to 22:00–07:00. A reminder that comes due during quiet hours waits, and is sent in the hour after quiet hours end. All-day events are not reminders.

Each person has a mode: `dm`, `channel`, or `off`. The default is `dm`. Ask in chat with `set_reminder_mode`. `dm` is a Discord direct message. `channel` mentions them in the summary channel, so that channel has to be set. `off` sends nothing. You can change your own mode. Changing someone else's needs a parent. The shared-token owner can change anyone's mode.

Household briefs are separate, and each one runs only when its clock time is set:

- `morningTime` — weekday morning direct message to parents
- `afterSchoolTime` — weekday after-school post to the summary channel
- `weekendPreviewTime` — weekend preview to the summary channel, on Friday unless you set `weekendPreviewWeekday`

Garbage day is not required. With `garbageIcsUrl` set, `garbage_schedule` answers which bins go out. The daily brief can add a garbage line when tomorrow has a pickup. Without the link, the today tools still work and simply omit that line.

## Asking an agent

Point agents at the `family` skill, [skills/family/SKILL.md](skills/family/SKILL.md). It teaches `family_today`, `family_schedule`, and `garbage_schedule`. Follow that file. This README does not repeat its rules.

On Discord, "me" is the roster person with that Discord account. Off Discord, the owner flag is the shared owner and does not name a person.

## How it fits into OpenClaw

Family Pack reuses what OpenClaw already owns instead of rebuilding it.

| Need | Owned by |
| --- | --- |
| Who someone is on the page | The Gateway's trusted-proxy sign-in. The `family.week` Gateway method matches that username exactly to `profileId`. A member id from the browser is not used |
| Who someone is in Discord | The roster `discordId`, set with `openclaw family setup --discord NAME=ID`. In LAN mode, setup also prints the `users.linkChannelIdentity` command that ties it to the person's Gateway profile |
| Sign-in for each family member | [Multi-user Gateway](https://docs.openclaw.ai/concepts/multi-user). See [Household access](#household-access) |
| Google Calendar access | `gog`, on the Gateway host |
| Chat surfaces | Control UI chat and Discord |
| Briefs and reminders | This plugin. Discord is the delivery this version uses |

Each family operation is defined once and shared by the page and the agent tools, so asking in chat and using the page follow the same calendar rules.

## Household access

Family Pack is local only. `openclaw family access` says which mode the Gateway is in and what's left to set up. It changes nothing.

- **Solo.** Everyone who opens the Control UI is the owner. Family members use Discord, where the bot knows who's talking. Nothing extra to install.
- **LAN.** Needs a proxy on the Gateway machine that serves HTTPS and signs each person in. Caddy is the worked example, and any proxy that follows the printed rules works. Each person signs in with their own username and password. `openclaw family access lan --parent alex --kid riley` prints the Caddyfile, the Gateway config, the roles and the `users.setRole` steps. Passwords are never asked for or stored. [HOUSEHOLD-LAN.md](HOUSEHOLD-LAN.md) walks through the switch in order, including how to undo it.

In LAN mode there's no sign-out and no way to switch accounts. A browser stays signed in as whoever used it first, until you clear its saved data for this site. On a shared laptop, give each person their own browser profile. If you want a sign-in page, sign-out or passkeys, upgrade to Authelia.

## Privacy

Everything runs on your own OpenClaw Gateway. `gog` runs locally. This plugin stores no Google credentials of its own.

A weather request sends a search box around the coordinates in your config to Environment Canada. It does not send a street address. If you set `garbageIcsUrl`, the plugin fetches that collection calendar. Those are the outside reads. Briefs and reminders go out through the Discord bot OpenClaw already runs.

The Gateway decides who sees which calendar before the week is sent to the page. Parents see every calendar. So does the shared-token owner. Everyone sees shared calendars. A school or personal calendar also goes to its owners when that person is a member, not a guest. Guests, and anyone signed in who is not on the roster, see shared calendars only. The chips only dim events.

The plugin keeps a SQLite file on the Gateway host:

`$OPENCLAW_STATE_DIR/plugins/oc-family-pack/oc-family-pack.sqlite`

When `OPENCLAW_STATE_DIR` is unset, that path is under `~/.openclaw`. The file holds:

- schema migrations
- an append-only write log of calendar write outcomes
- an append-only delivery log of brief and reminder attempts (the page shows one sentence, not the stored target)
- reminder-mode history, where the latest row per person wins: `dm`, `channel`, or `off`

Uninstall removes the plugin config and the installed code, and leaves that database in place. To delete it after uninstall:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/plugins/oc-family-pack"
```

`openclaw plugins pack` builds a single-file archive. This plugin loads `dist/store-worker.js` from the same directory as the main file, and pack rejects that layout, so a pack artifact will not run. Git installs and npm installs keep the files side by side and are unaffected.

## Development

```bash
npm install
npm run build      # backend and Control UI bundle
npm run validate   # manifest and schema
npm test
npm run check      # typecheck, script typecheck, tests, validate, build --check, dist staleness, and the store-worker check
```

After browser-only changes, rebuild and use **Plugins → Advanced → Customize UI → Reload plugin UI**. Backend changes need a plugin reload.

OpenClaw plugin APIs are experimental, so this plugin tracks host releases rather than claiming to work everywhere. **Tested on OpenClaw `2026.9.7`.** After you run `openclaw update`, run the smoke to check this plugin against your new host:

```bash
npm run smoke
```

It boots a throwaway Gateway on a temp state dir and a free loopback port, never touching your running one. The checks include: the plugin loads, the manifest validates, a real `family.week` call matches the contract schema, a signed-in kid sees shared calendars and the calendars they own, the page registers, and the plugin's host-payload limits still agree with the host's own. A break fails with the name of the step that broke. It tests the OpenClaw build you actually run, not the pinned devDependency: it looks for an `openclaw` outside this repo's own `node_modules/.bin`, and fails by name if there is none. Set `OCFP_SMOKE_HOST_BIN` to point it at a specific binary, or `OCFP_SMOKE_KEEP=1` to keep the throwaway state for inspection. If your host is a different build than the one this repo was tested against, the smoke stops at the manifest step and tells you to rebuild `dist/` with that host.

## Roadmap

Shipped work is checked. Chores are still later. This version has no undo, no messaging-service picker, no Home Assistant, no RSVP, and no appearance themes.

- [x] Family page: Monday–Sunday week, weather, and chat strip
- [x] Add and change events from chat and the page
- [x] Today dashboard widget
- [x] Daily and weekly briefs
- [x] Reminders with quiet hours
- [x] Household briefs
- [x] Guided setup (`family setup`, `family gog`, `family access`)
- [x] Garbage day, when you set a city calendar link
- [x] Family skill
- [ ] Chores

## FAQ

Common questions live in [FAQ.md](FAQ.md).

## License

[MIT](LICENSE)
