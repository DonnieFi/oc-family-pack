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
calendar, with a 20 second timeout and no shell. Adding, changing, moving, and
deleting an event use that same sign-in.

If gog is missing or not signed in, the Family page shows the next step. With
no people yet, that step is `openclaw family setup`. When calendars are not
connected, it is `openclaw family gog`. If the Gateway runs as a service
without your shell `PATH`, set `gogPath` to the full path of the binary.

## Why doesn't the Family page appear?

Family is a native Control UI page, so it needs three things:

- The plugin is installed and enabled, and the Gateway has restarted since.
- **Settings → Labs → Custom plugin UI** is on
  (`gateway.controlUi.experimental.customPlugins: true`). It is off by default.
- The Control UI is open over HTTPS or on `http://127.0.0.1` / `http://localhost`.
  Native plugin assets use secure cookies, so plain HTTP on a LAN address
  cannot load the page. For phones, use LAN mode. Caddy serves the Family
  page over HTTPS on your home network (`openclaw family access lan`).

Then **Family** appears in the sidebar. The page lives at
`/plugin?plugin=oc-family-pack&id=family` under your Control UI URL.

## Can I install it straight from Git?

Yes. `openclaw plugins install git:https://github.com/DonnieFi/oc-family-pack.git`
clones the repository and installs its dependencies, but it does not run a
build. The repository therefore ships the compiled `dist/` folder, and the
installer asks you to accept the plugin's capabilities first.

## Where does my family data go?

On a live Gateway, gog runs on that host and reads and writes Google Calendar.
The Control UI renders the week, and each page load reads the week again.
Demo mode (`demo: true`) does not read real calendars. It shows a sample week.

The plugin also keeps a SQLite database on the Gateway host at
`$OPENCLAW_STATE_DIR/plugins/oc-family-pack/oc-family-pack.sqlite`. When
`OPENCLAW_STATE_DIR` is unset, that path is under `~/.openclaw`. The file holds:

- which schema updates have run
- an append-only log of calendar write outcomes
- an append-only log of brief and reminder delivery attempts
- each person's reminder-mode changes (`dm`, `channel`, or `off`). The latest change wins.

The page never shows the stored delivery target. It shows a sentence such as
"Daily brief sent."

Weather sends a box around your configured coordinates to Environment Canada.
If you set a collection calendar, the plugin fetches that link. The page loads
no fonts, scripts, or images from other sites.

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

## Is the calendar read-only?

No. The page and chat can add, change, move, and delete events.

A write from the page needs `operator.write`. The kid role does not have it, so
a kid cannot change events on the page. From chat, a kid can change their own
personal calendar. A shared calendar, a school calendar, or someone else's
calendar waits for a parent.

Undo is not available. A change that already went through is not undone from
the page or from chat.

Chores are later. They are not in this version.

## Who can see the Family page?

Anyone signed in with at least `operator.read` can open it, once custom plugin
UI is on. What they see is scoped.

Parents, and the shared-token owner, see every calendar. Everyone sees shared
calendars. A school or personal calendar also goes to its owners when that
person is a member and not a guest. Guests, and people who are not on the
roster, see shared calendars only.

The member chips dim events. They are not a privacy control. A calendar that
even parents should not see does not belong in the config.

The Chat with strip uses that person's own agent list, so it only shows agents
they can already open.

## When do briefs and reminders go out?

This version posts them through Discord, using OpenClaw's existing bot. The
Family page works without Discord. There is no messaging-service picker.

The daily brief goes to the summary channel at 07:00 household time, until
noon. The weekly brief goes out Sunday at 20:00, until Monday noon. Both
require `summaryChannel`. Without it, they stay off.

A morning parent DM, an after-school post, and a weekend preview are separate
optional times. Each stays off until that time is set. The weekend preview
runs on Friday unless you set another day.

Reminders fire the lead time before a timed event, 15 minutes if you leave
that unset. Quiet hours default to 22:00–07:00. A reminder that comes due
during quiet hours waits, and goes out in the hour after they end. All-day
events are not reminders. Each person gets a direct message, a mention in the summary
channel, or nothing. The default is a direct message. `set_reminder_mode`
changes your own. Changing someone else's needs a parent.

## Do the family commands change config?

No.

`openclaw family setup` prints a config patch and never writes it.
`openclaw family gog` never passes `--readonly`.
`openclaw family access` changes nothing. It reports the sign-in mode, or
prints the steps for one.

## What can a kid ask?

A kid can ask what is on, whose class it is, what is due, when the bins go out, and what is urgent today. The answer comes from the calendars that kid can see.

Changing a shared calendar, a school calendar, or someone else's calendar waits for a parent to approve it. A kid can change their own personal calendar. Changing how someone else gets reminders also needs a parent.

A change that already went through is not undone from chat.

## Why can't I sign out?

LAN mode uses Caddy basic auth, which has no sign-out and no way to switch
accounts. A browser stays signed in as whoever used it first, until you clear
its saved data for this site. On a shared laptop, give each person their own
browser profile. If you want a sign-in page, sign-out or passkeys, upgrade to
Authelia.

## What is a family member?

A member is the household's record of a person, in `plugins.entries.oc-family-pack.config.members`. It holds `profileId`, `displayName`, and `role` (`parent`, `kid`, or `guest`). Optional fields are `color`, `discordId`, `reminders` (`dm`, `channel`, or `off`), and `devices`.

`profileId` is the sign-in username, lower case, matched exactly to the trusted-proxy user. It is not the Gateway's internal profile id. The chips on the Family page only dim events. They do not add a person, and they are not identity. At least one parent is required. The fields and the steps are in [SETUP.md](SETUP.md).

## How do I add someone?

`openclaw family setup --parent alex --kid riley` prints a members patch and does not save it. Usernames are lower case: letters, numbers, dots, dashes, and underscores, up to 32 characters. `alex` is valid. `Alex Smith` is not. The display name becomes the username with the first letter capitalized. Someone already in the config is left unchanged. Pass `--guest sam` for a guest.

Apply it with `openclaw config patch --stdin --dry-run`, then again without `--dry-run`. The Family page does not add people. Setup does.

## Where do email and phone go?

This version stores no email and no phone on the member. Sign-in is the `profileId`. A Discord user id goes in `discordId`, set with `openclaw family setup --discord alex=200000000000000001`. Email aliases, if you use them, belong to the OpenClaw user profile, not this plugin.

## How do I set a Discord user id?

Turn on Developer Mode, right-click the person, and Copy User ID. The id is 17 to 20 digits, not a mention. Pass `--discord NAME=ID` on `openclaw family setup`, alone or with the role flags. One id per person, for someone already in the family or added in the same command. The Family page never shows the id.

In LAN mode, setup also prints `users.linkChannelIdentity`. Run it after that person has signed in once. Replace `PROFILE_` with the Gateway profile id from `users.list`. Solo mode does not print it, because there is no per-person sign-in. Discord is how this version knows who "me" is in chat. The Family page works without Discord. The cutover from solo to LAN is in [HOUSEHOLD-LAN.md](HOUSEHOLD-LAN.md).

## Why does setup print a patch instead of saving?

`openclaw config patch` replaces a whole array. Setup copies the members you already have and appends the new ones, so a patch cannot drop someone by accident. You read it, dry-run it, then apply it.

`openclaw family gog` and `openclaw family access` also change nothing by themselves. gog never passes `--readonly`. `openclaw family access` reports solo or LAN, or prints steps.

## What does setup check?

Five lines, each Done or To do, then one next step.

- **Access mode.** `openclaw family access`.
- **Timezone.** Set `plugins.entries.oc-family-pack.config.timezone`, for example `America/Toronto`.
- **Location.** `lat` and `lon`. Weather is Canada only.
- **Members.** At least one parent. In LAN mode every member must also be in `allowUsers`.
- **Calendars.** `openclaw family gog`, then put calendar ids in config.

When all five are Done, it prints "Everything is set up." A patch is not saved yet, so that run is not finished.
