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

If gog is missing or not signed in, the Family page shows the setup steps. If
the Gateway runs as a service without your shell `PATH`, set `gogPath` to the
full path of the binary.

## Why doesn't the Family page appear?

Family is a native Control UI page, so it needs three things:

- The plugin is installed and enabled, and the Gateway has restarted since.
- **Settings → Labs → Custom plugin UI** is on
  (`gateway.controlUi.experimental.customPlugins: true`). It is off by default.
- The Control UI is open over HTTPS or on `http://127.0.0.1` / `http://localhost`.
  Native plugin assets use secure cookies, so plain HTTP on a LAN address
  cannot load the page. `tailscale serve` in front of the Gateway works.

Then **Family** appears in the sidebar. The page lives at
`/plugin?plugin=oc-family-pack&id=family` under your Control UI URL.

## Can I install it straight from Git?

Yes. `openclaw plugins install git:https://github.com/DonnieFi/oc-family-pack.git`
clones the repository and installs its dependencies, but it does not run a
build. The repository therefore ships the compiled `dist/` folder, and the
installer asks you to accept the plugin's capabilities first.

## Where does my family data go?

Nowhere new. Calendar events are read by gog on your Gateway host and rendered
in your Control UI. Nothing is stored; each page load reads the week again. The
only outside request the plugin makes is the Environment Canada weather lookup.
That lookup sends a search box around your configured coordinates.
The page loads no fonts, scripts, or images from other sites.

## Why is it read-only?

A family calendar is shared, trusted state, and a wrong write is expensive:
a moved pickup or a deleted appointment. The first version shows the week
accurately and leaves edits to your calendar app. Reminders and chores are
planned, and they will be explicit actions.

## Who can see the Family page?

Anyone signed in to the Control UI with at least `operator.read`, once custom
plugin UI is on, currently sees the whole household week. Per-person filtering
(parents see every calendar; kids see shared, school, and their own) is the
planned server check against the signed-in client. The Chat with strip uses
that person's own agent list, so it only shows agents they can already open.
