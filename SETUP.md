# Set up a household

The person is the record you add. `openclaw family setup` prints the next step and never writes config.

## The person

Each person is a member in `plugins.entries.oc-family-pack.config.members`.

- **name** (required). What the family calls this person. `displayName` is still accepted. When setup adds someone, it sets this to the username with the first letter capitalized. `riley` becomes Riley.
- **id** (optional). The internal key. Calendar owners, briefs, reminders and Today use it. Omitted means the `profileId`, or else a lower-case slug of the name (`Riley S` becomes `riley-s`). Two people with the same id fail the config, and the error names both.
- **profileId** (optional). Only for someone who signs in to the Control UI. Lower case. This is the trusted-proxy sign-in username, the `X-Forwarded-User` value. It is separate from the Gateway's internal profile id. The page matches it exactly. Someone without one can't open the Family page as themselves. It is never made up from the name. A member id from the browser is not identity.
- **aliases** (optional). The names the family actually uses in chat, such as `Mom`, `Dad`, or `Aunt Jo`. They are for addressing only. They never grant a page or Discord identity. An alias cannot collide with another person's id, login, or alias.
- **role** (optional). `parent`, `kid`, or `guest`. Omitted means `guest`. At least one parent is required before the Members step is done.
- **color** (optional). A CSS color, such as `#3b82f6`. The page uses it. The setup command does not set it.
- **discordId** (optional). 17 to 20 digits. It stays in config. The week payload never includes it.
- **reminders** (optional). `dm`, `channel`, or `off`. Omitted means `dm` when the person has a `discordId`, and `off` when they do not. Change it later in chat with `set_reminder_mode`. The setup command does not set it.
- **devices** (optional). `id`, `label`, `hostname`, `primaryMac`, `aliasMacs`, `source`, `sharedWith`, and `reservation`. A MAC is a device signal. It is normalized when config is parsed, and it stays off the week payload. An omitted device `id` keeps the label slug when unique. Repeated labels are disambiguated with the owner id and, when needed, a numeric suffix. Explicit ids never change. Run `--materialize-ids` and apply its patch before changing labels, MACs, logins, or roster membership; derived ids are only a legacy fallback. `sharedWith` lists other member ids on that one record. A second record with the same MAC is refused. `reservation` is an IPv4 address the operator wrote down (`address`, `source`, and an optional `network`). An observed address is not stored, and a reservation does not change the router. The setup command does not set devices.

- **email** (optional). Trimmed and stored in lower case. It is only stored on the person's card. Nothing in this plugin sends email, and no output shows it. Two people may share one.

Someone with no Discord account still loads, and setup says: Riley has no Discord account, so this version can't send them reminders or briefs. Email and phone stay on the contact card and are not notification routes. A kid's card doesn't need a parent's Discord. Sign-in is `profileId` or `login`. `phone` is optional and is only stored.

Usernames use lower-case letters, numbers, dots, dashes, underscores, or a plain email address. Try `alex` or `alex@example.com`, not `Alex Smith`. Each person sees this as their name in the Control UI, so use what the family calls them. It must be the same value the proxy sends in `X-Forwarded-User`.

## Add someone

This prints a patch. It does not save.

```bash
openclaw family setup --parent alex --parent sam --kid riley
```

Use `--guest` for a guest.

Pass Discord in the same command, or later:

```bash
openclaw family setup --parent alex --discord alex=200000000000000001
```

Someone already in the config keeps their fields. If a legacy member has no explicit id, adding a Discord id or email also writes the id, so a later rename cannot move calendar owners. Setup says: "alex is already set up, so that entry was left as it is."

## Apply the patch

`openclaw config patch` replaces a whole array. Setup copies the members you already have and appends the new ones, so the printed patch still contains everyone. Dropping a person from that JSON removes them.

Copy the JSON object from the output. The printed intro is: Check it first with `openclaw config patch --stdin --dry-run`, then run it again without `--dry-run` to apply it.

```bash
openclaw config patch --stdin --dry-run
```

Paste the JSON on stdin, then run the same command without `--dry-run`.

When setup prints a patch, it exits non-zero, because the config is not saved yet. If every named person was already present and no Discord id changed, it prints "No changes to make."

## Discord

`--discord` is `NAME=ID`. Turn on Developer Mode in Discord, right-click the person, and pick Copy User ID. A mention is not an id. Each person has one id. Two people cannot share one.

An id for someone who is not already in the family, and not added in this command, fails. Setup says they are not in the family yet, and to add them with `--parent`, `--kid`, or `--guest` in the same command.

In LAN mode, when you pass `--discord`, setup also prints `users.linkChannelIdentity`. The profile id in that command is a `PROFILE_alex` placeholder. Replace each `PROFILE_` placeholder with that person's profile id from `users.list`. Run the link after they have signed in once, so their profile exists. If more than one Discord account is configured, replace `ACCOUNT` with the `channels.discord.accounts` entry the family uses. Solo mode does not print those lines.

Discord is how this version knows who "me" is in chat. The Family page works without it.

## Email

`--email` is `NAME=address`.

```bash
openclaw family setup --kid riley --email riley=riley@example.com
```

Setup checks the shape and does not repeat a bad address. The checklist and the lines above the patch do not print addresses. The patch JSON does, because `openclaw config patch` replaces the whole members list, and leaving an address out would delete it. An email stays on the card. The week, the Family page, and briefs do not show it. The People page shows it to a parent, or to the shared owner in solo mode. `family_contact` can read one person's email, and only when the host marks the caller as the operator.

## The checklist

`openclaw family setup` with no names prints a checklist. Each line is `Name: Done` or `Name: To do`. When it has a config patch, link command, or approval block to offer, those print above the checklist; otherwise one Next step follows it.

1. **Access mode.** Next is `openclaw family access`. It changes nothing. It reports solo or LAN, or prints the steps for one.

   ```bash
   openclaw family access
   ```

   Solo: everyone who opens the Control UI is the shared owner. Family members use Discord. LAN: one sign-in per person. The walkthrough is [HOUSEHOLD-LAN.md](HOUSEHOLD-LAN.md). Family Pack is local only. A Gateway that allows sign-in from outside the home network is told to use `openclaw family access lan` instead.

2. **Timezone.** Set the full key. Until it is set, the week uses the Gateway machine's zone. Setup prints that zone in the command. `America/Toronto` is one valid value.

   ```bash
   openclaw config set plugins.entries.oc-family-pack.config.timezone America/Toronto
   ```

3. **Location.** `lat` and `lon`. Weather is Canada only. The hint is: Add location { lat, lon } to the plugin config to show local weather. Setup prints `LAT` and `LON` for you to replace. `label` is optional.

   ```bash
   openclaw config set plugins.entries.oc-family-pack.config.location '{"lat":45.42,"lon":-75.7}' --strict-json
   ```

   The same place in the README example is `{ lat: 45.42, lon: -75.7, label: "Home" }`.

4. **Members.** Done when there is at least one parent. In LAN mode every member must also have a `login`, be in `allowUsers`, and have Gateway scopes that match their roster role. If someone is missing, setup names them and prints the access command. That command names every member and everyone already allowed. A member without an explicit `id` gets a warning: run `openclaw family setup --materialize-ids` before a rename.

5. **Calendars.** Next is `openclaw family gog`. The steps are below.

After members exist, a checklist run may also print an optional Discord command, with `DISCORD_ID_alex` as a placeholder:

```bash
openclaw family setup --discord alex=DISCORD_ID_alex
```

How to copy the id is in Discord above.

When every step is Done, no approval block is pending, and no id or LAN-mode warning remains, setup prints "Everything is set up." The exit code is 0 only then. A run that printed a patch is not finished.

## Calendars

```bash
openclaw family gog
```

On a headless Gateway this is two `gog auth add` steps. The first prints a URL. Open it, then pass the browser redirect:

```bash
openclaw family gog --auth-url '…'
```

The commands never pass `--readonly`. On a machine with a browser:

```bash
openclaw family gog --desktop
```

If the Gateway service cannot see `gog` on `PATH`, set `gogPath` to the full path of the binary. Family Pack uses gog's default account; if `gog auth list` holds several, make the family calendars available on the default one. The plugin does not choose a Google account per request.

When `gog` can list calendars, put them in config. Each one has an `id`, a `label`, and a `kind` of `personal`, `shared`, or `school`. Owners are member `id` values. A school calendar's owners are the students. A shared calendar's owners may be an empty list. Set an optional `key` (`c` plus up to seven letters or digits) before reordering the list; the key is the wire id tools and pages use. Labels must be unique. A full example is in the Configuration section of [README.md](README.md). The Calendars step is Done when sign-in is ready, at least one calendar is in config, and every personal or school calendar has an owner.

## Sign-in

You sign in as your `profileId`. Gateway roles and plugin roster roles are two separate settings: `openclaw family access lan` sets `identityScopes`, and `users.setRole` sets the host role. The plugin checks `members[].role` for page writes, People, and approvals; setup reports when the two disagree. Change both when someone changes role.

`openclaw family access` reports solo or LAN and changes nothing. In solo mode, everyone who opens the Control UI is the shared owner, and family members use Discord. In LAN mode, each person has their own sign-in, and every member is in `allowUsers`. A trusted-proxy Gateway is treated as LAN even before `accessMode` is set; setting `accessMode: "lan"` makes it explicit. A paired device token is then a guest and cannot see the household. In solo mode it is the shared owner. The cutover is [HOUSEHOLD-LAN.md](HOUSEHOLD-LAN.md).

Calendar approvals use OpenClaw plugin approvals. The parent LAN role includes `operator.approvals`. In LAN mode, `openclaw family setup` prints an `approvals.plugin` block with the roster parents' Discord targets. Apply it, enable writes for the proof window, prove a kid's shared-calendar write reaches a parent, then enable reminders and briefs.

## After setup

The git install line is in the Install section of [README.md](README.md).

Enable the plugin, then restart the Gateway:

```bash
openclaw plugins enable oc-family-pack
```

Turn on Custom plugin UI. Set `gateway.controlUi.experimental.customPlugins` to `true`:

```json5
{
  gateway: {
    controlUi: {
      experimental: { customPlugins: true },
    },
  },
}
```

The page is `/plugin?plugin=oc-family-pack&id=family`.

Set `demo: true` to show a synthetic week before a calendar is connected. Demo does not invent a delivery row.

Questions are in [FAQ.md](FAQ.md). The LAN cutover is in [HOUSEHOLD-LAN.md](HOUSEHOLD-LAN.md).
