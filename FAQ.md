# FAQ

## Why does weather only work in Canada?

Weather comes from the Environment Canada city page API
(`api.weather.gc.ca`). It needs no API key and gives both current conditions
and a written forecast. It only covers Canadian locations. Elsewhere the card
says so instead of showing stale or wrong data. Other providers may come later.

## Why gog for calendars?

[gog](https://github.com/openclaw/gogcli) already handles Google OAuth, token
refresh, and multiple accounts on the Gateway host. Reusing it means the plugin
stores no Google credentials of its own. The plugin runs
`gog calendar events <id> --from ... --to ... --json` once per configured
calendar, with a 20 second timeout and no shell.

If gog is missing or not signed in, the Family tab shows the setup steps. If
the Gateway runs as a service without your shell `PATH`, set `gogPath` to the
full path of the binary.

## Why doesn't the Family tab appear, or stay blank?

External plugin tabs run in a sandboxed frame. They get access through a short
cookie grant, and browsers only allow that cookie in a secure context. Use one
of these:

- HTTPS, for example `tailscale serve` in front of the Gateway.
- `http://127.0.0.1` or `http://localhost` on the Gateway host.

Plain HTTP over a LAN address will not load the tab. Browsers that block all
third-party cookies will not load it either. The page still works directly at
`/plugins/family/` with Gateway auth.

## Where does my family data go?

Nowhere new. Calendar events are read by gog on your Gateway host and rendered
by your Gateway. Nothing is stored; each page load reads the week again. The
only outside request the plugin makes is the Environment Canada weather lookup.
That lookup sends a search box around your configured coordinates.
The page loads no fonts, scripts, or images from other sites.

## Why is it read-only?

A family calendar is shared, trusted state, and a wrong write is expensive:
a moved pickup or a deleted appointment. The first version shows the week
accurately and leaves edits to your calendar app. Reminders and chores are
planned, and they will be explicit actions.

## Who can see the Family tab?

Anyone signed in to the Control UI with at least `operator.read`. The Chat with
strip uses that person's own agent list, so it only shows agents they can
already open.
