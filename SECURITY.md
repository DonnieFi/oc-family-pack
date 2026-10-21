# Security

oc-family-pack runs inside your OpenClaw Gateway with the Gateway's permissions. This page lists what it reaches over the network, what it trusts, and how to report a problem.

## What it talks to

| Where | When | Limits |
| --- | --- | --- |
| `api.weather.gc.ca` | When a location is set | HTTPS only. Redirects are refused (`redirect: "error"`). 10 second timeout. The body is read in chunks and dropped past a size cap. No key, no account. |
| Your city's collection calendar (`garbageIcsUrl`) | Only when you set it | http or https. Redirects are followed by hand: at most three, never https to http, and never to a local address unless the hop has the configured link's own origin. 8 second timeout and a body cap. |
| Discord, through the host's Discord bot | Briefs and reminders, when configured | The plugin has no bot token of its own. A delivery goes to a roster member or a configured channel by its key, never to a raw Discord id from a message. |
| Google Calendar, through `gog` on the Gateway host | When calendars are configured | `gog` uses your existing Google sign-in. The plugin never sees the token. |

The collection calendar check has one gap. Only literal addresses and localhost names are checked, so a public name that resolves to a private address is not caught. The link is set by the operator, so treat it like any other config value you trust.

## What it trusts

- **The operator's config.** `gogPath`, `garbageIcsUrl`, the roster, and the channel keys come from Gateway config. Whoever can edit that config can point `gogPath` at any binary, and the Gateway runs it. Protect the config file the same way you protect the Gateway.
- **The Gateway's sign-in.** In LAN mode the Family page matches the trusted-proxy username to a member's `profileId`. A member id sent by the browser is never treated as identity.
- **Discord sender ids.** In chat, who's asking comes from the host's verified Discord sender. Chat that isn't Discord can't say who's asking, so its calendar changes wait for a parent.

## Calendar changes and the approval stamp

Every calendar write from chat goes through one `before_tool_call` hook that runs first. When a change needs a parent, the hook holds it for the host's approval prompt. It then writes a stamp into a parameter the model never sees, and it overwrites that parameter on every call. The stamp is an HMAC over the decision, the tool, and the event version the hook read. The tool refuses a missing, forged, or mismatched stamp. The stamp is never hashed into a key, written to an event, or logged.

The four write tools, `set_reminder_mode`, and `family_contact` are optional tools. On a `full` tool profile, the agent can already see the calendar tools. What protects your calendar is the `writes` setting and the parent rule, not tool visibility. With no profile, or a narrower one, they appear only after the operator adds them with `tools.alsoAllow`.

`family_contact` is the one tool that returns an email. It answers only when the caller is the operator (`senderIsOwner`, or a direct operator session). A kid, a guest, and any other member are refused before the roster is read. It takes one member id and does not list the family. The refusal does not include an address. Nothing else in the plugin — the week, the page, briefs, widgets, or logs — includes an email.

## What it stores

One SQLite file under `$OPENCLAW_STATE_DIR/plugins/oc-family-pack/`. The Privacy section of [README.md](README.md) lists what it holds and how to delete it.

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's private reporting on [DonnieFi/oc-family-pack](https://github.com/DonnieFi/oc-family-pack/security/advisories/new). Say what you saw, the version or commit, and how to reproduce it.
