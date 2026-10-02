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

Calendar events are read by gog on your Gateway host and rendered in your
Control UI. Each page load reads the week again. The plugin also keeps a SQLite
database on the Gateway host at
`$OPENCLAW_STATE_DIR/plugins/oc-family-pack/oc-family-pack.sqlite`. When
`OPENCLAW_STATE_DIR` is unset, that path is under `~/.openclaw`. Right now it only
records which updates have run. Features that save family data will add their
own tables, and this answer will list what each one keeps. The only
outside request the plugin makes is the Environment Canada weather lookup.
That lookup sends a search box around your configured coordinates.
The page loads no fonts, scripts, or images from other sites.

## Does uninstall delete the family database?

No. Uninstall removes the plugin config and the installed copy of the code.
The database stays where it is, so a later install sees the same data. You
re-enter the config and enable the plugin again.

To delete the data, uninstall first, then remove the directory:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/plugins/oc-family-pack"
```

## Why does `openclaw plugins pack` fail?

Pack builds one archive file. The family store loads `dist/store-worker.js`
next to the main plugin file, and pack rejects that layout, so a pack artifact
does not run. A git install or an npm install keeps both files and works.

## Why is it read-only?

A family calendar is shared, trusted state, and a wrong write is expensive:
a moved pickup or a deleted appointment. The first version shows the week
accurately and leaves edits to your calendar app. Reminders and chores are
planned, and they will be explicit actions.

## Who can see the Family page?

Everyone signed in to the Control UI with at least `operator.read`, once
custom plugin UI is on, sees every configured calendar. The member chips only
filter the view; they do not hide anyone's events from anyone. Roles don't
limit what anyone can see. If a calendar should stay
private, leave it out of the config. The Chat with strip uses that person's
own agent list, so it only shows agents they can already open.
