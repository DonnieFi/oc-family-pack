<div align="center">

# OpenClaw Family Pack

**A calm, family-first home base for [OpenClaw](https://github.com/openclaw/openclaw): one shared calendar, the day's weather, and a chat with any of your agents, all in the Control UI.**

[![Version](https://img.shields.io/github/package-json/v/DonnieFi/oc-family-pack?label=version&color=e08a3a)](package.json)
[![Status](https://img.shields.io/badge/status-early%20development-orange)](#roadmap)
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

Family Pack is an OpenClaw **feature plugin** for households. It adds a **Family** page to the Control UI and family-aware tools to your agents, so everyone can see what's on, ask about it, and add to it from the Control UI or Discord.

It is built for the moments families actually ask about:

- *"What's on today?"*
- *"Do I have a class tomorrow?"*
- *"When is the dentist?"*
- *"Add soccer practice for Thursday at 5."*

Briefs stay short on purpose. Routine items fold into a single line so only the unusual things stand out.

## Features

| Feature | What you get | Status |
| --- | --- | --- |
| Family calendar page | Week view with a Today emphasis, a color per person, and filter chips that dim everyone else while shared events stay bright | In progress |
| Weather card | Current conditions, today's high and low, and upcoming periods from Environment Canada | In progress |
| Chat with any agent | Pick an agent and open the conversation docked beside the calendar | In progress |
| Add events by asking | Create an event from chat or the page, at any time | Planned |
| Today widget | Top highlights on the Control UI dashboard | Planned |
| Daily and weekly briefs | Exceptions-only summaries posted to your family channel | Planned |
| Event reminders | Per-person delivery by DM or channel, with quiet hours | Planned |
| Household briefs | After-school plan and a weekend preview | Planned |
| Chores | Parent-managed chores with kid check-off | Later |

## Requirements

| Requirement | Why |
| --- | --- |
| OpenClaw `2026.9.7` or newer | Feature plugin SDK (`feature-contract`, `feature-plugin`, `control-ui`). Tested on `2026.9.7`; see [Development](#development) for the post-update smoke. |
| Node.js `>=24.16.0 <25` or `>=26.1.0` | Matches the OpenClaw runtime |
| [`gog`](https://github.com/openclaw/gogcli) with Calendar access | Reads and writes Google Calendar using your existing sign-in |
| **Custom plugin UI** lab enabled | Required for native pages from non-bundled plugins |
| HTTPS, Tailscale Serve, or `127.0.0.1` | Native plugin pages need a secure origin |

Weather uses Environment Canada's public API, so it needs no key and covers Canadian locations.

## Install

```bash
openclaw plugins install git:https://github.com/DonnieFi/oc-family-pack.git --accept-capabilities
```

The repository ships its built `dist/`, so no build step is needed. `--accept-capabilities` confirms the plugin's native Control UI page, which runs with the signed-in operator's Gateway permissions.

To try it without calendars first, set `demo: true` (see below). Add your configuration, then enable the plugin:

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

Then open **Family** from the Control UI sidebar.

## Configuration

Family Pack reads `plugins.entries["oc-family-pack"].config`. Each `profileId` is that person's trusted-proxy username (the value your proxy sends in `X-Forwarded-User`), stored in lower case. When the header is an email, `profileId` is the part before `@`. It is not the Gateway's internal profile id. A calendar's owners are those same ids. A school calendar belongs to the student.

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

Set `demo: true` to preview the page with a sample week before connecting a calendar.

## How it fits into OpenClaw

Family Pack reuses what OpenClaw already owns instead of rebuilding it.

| Need | Owned by |
| --- | --- |
| Who someone is on the page | A plugin Gateway method on the signed-in client. `profileId` matches the proxy username |
| Who someone is in Discord | The roster Discord id matched to the sender |
| Sign-in for each family member | [Multi-user Gateway](https://docs.openclaw.ai/concepts/multi-user): Caddy basic auth on a trusted LAN, or Tailscale Serve / Cloudflare Access on the internet |
| Google Calendar access | `gog` |
| Chat surfaces | Control UI chat and the Discord channel |
| Scheduling | Plugin-owned automations |

Each family operation is defined once and shared by the page and the agent tools, so asking in chat and clicking in the UI behave the same way.

## Privacy

Everything runs on your own OpenClaw Gateway. Calendar data is read through your local `gog` sign-in, weather requests send only your coordinates to Environment Canada, and nothing is sent to a third-party service by this plugin.

The plugin keeps its own SQLite database on the Gateway host, under `plugins/oc-family-pack/` in the OpenClaw state directory. Uninstall removes the plugin config and the installed code, and leaves that database in place. To delete it after uninstall:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/plugins/oc-family-pack"
```

`openclaw plugins pack` builds a single-file archive. This plugin loads `dist/store-worker.js` from the same directory as the main file, and pack rejects that layout, so a pack artifact will not run. Git installs and npm installs keep the files side by side and are unaffected.

## Development

```bash
npm install
npm run build      # backend and Control UI bundle
npm run validate   # manifest, schema, and stale-build checks
npm test
npm run check      # everything above, plus the built dist/ staleness check
```

After browser-only changes, rebuild and use **Plugins → Advanced → Customize UI → Reload plugin UI**. Backend changes need a plugin reload.

OpenClaw plugin APIs are experimental, so this plugin tracks host releases rather than claiming to work everywhere. **Tested on OpenClaw `2026.9.7`.** After you run `openclaw update`, run the smoke to check this plugin against your new host:

```bash
npm run smoke
```

It boots a throwaway Gateway on a temp state dir and a free loopback port, never touching your running one, then checks the plugin loads, the manifest validates, a real `family.week` query matches the contract schema, the page registers, and the plugin's host-payload limits still agree with the host's own. A break fails with the name of the step that broke. It tests the OpenClaw build you actually run, not the pinned devDependency: it looks for an `openclaw` outside this repo's own `node_modules/.bin`, and fails by name if there is none. Set `OCFP_SMOKE_HOST_BIN` to point it at a specific binary, or `OCFP_SMOKE_KEEP=1` to keep the throwaway state for inspection. If your host is a different build than the one this repo was tested against, the smoke stops at the manifest step and tells you to rebuild `dist/` with that host.

## Roadmap

- [ ] Family page: calendar, weather, and chat dock
- [ ] Add events from chat and the page
- [ ] Today dashboard widget
- [ ] Daily and weekly briefs
- [ ] Reminders with quiet hours
- [ ] Household briefs
- [ ] Guided setup
- [ ] Chores

## FAQ

Common questions live in [FAQ.md](FAQ.md).

## License

[MIT](LICENSE)
