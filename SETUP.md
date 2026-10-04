# Set up a household

The person is the record you add. `openclaw family setup` prints the next step and never writes config.

## The person

Each person is a member in `plugins.entries.oc-family-pack.config.members`.

- **profileId** (required). Lower case. This is the trusted-proxy sign-in username, the `X-Forwarded-User` value. It is the name the Gateway signs that person in as. It is separate from the Gateway's internal profile id. The page matches it exactly. A member id from the browser is not identity.
- **displayName** (required). When setup adds someone, it sets this to the username with the first letter capitalized. `riley` becomes Riley.
- **role** (required). `parent`, `kid`, or `guest`. At least one parent is required before the Members step is done.
- **color** (optional). A CSS color, such as `#3b82f6`. The page uses it. The setup command does not set it.
- **discordId** (optional). 17 to 20 digits. It stays in config. The week payload never includes it.
- **reminders** (optional). `dm`, `channel`, or `off`. Omitted means `dm`. Change it later in chat with `set_reminder_mode`. The setup command does not set it.
- **devices** (optional). `label`, `primaryMac`, `aliasMacs`, and `source`. A MAC is a device signal. It is normalized when config is parsed, and it stays off the week payload. The setup command does not set it.

This version stores no email and no phone on the member. Sign-in is `profileId`. Email aliases, if the household uses them, belong to the OpenClaw user profile, not this plugin.

Usernames use lower-case letters, numbers, dots, dashes, or underscores, up to 32 characters. The command says: Usernames use lower-case letters, numbers, dots, dashes or underscores. Try `alex`, not `Alex Smith`. Each person sees their username as their name in the Control UI, so use what the family calls them.

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

Someone already in the config is left as they are. Setup says: "alex is already set up, so that entry was left as it is."

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

## The checklist

`openclaw family setup` with no names prints a checklist. Each line is `Name: Done` or `Name: To do`, then one Next step.

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

4. **Members.** Done when there is at least one parent. In LAN mode every member must also be in `allowUsers`. If someone is missing, setup tells you to re-run `openclaw family access lan` with the whole family. That command names every member and everyone already allowed.

5. **Calendars.** Next is `openclaw family gog`. The steps are below.

After members exist, a checklist run may also print an optional Discord command, with `DISCORD_ID_alex` as a placeholder:

```bash
openclaw family setup --discord alex=DISCORD_ID_alex
```

How to copy the id is in Discord above.

When every step is Done, setup prints "Everything is set up." The exit code is 0 only then. A run that printed a patch is not finished.

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

If the Gateway service cannot see `gog` on `PATH`, set `gogPath` to the full path of the binary.

When `gog` can list calendars, put them in config. Each one has an `id`, a `label`, and a `kind` of `personal`, `shared`, or `school`. Owners are `profileId` values. A school calendar's owners are the students. A shared calendar's owners may be an empty list. A full example is in the Configuration section of [README.md](README.md). The Calendars step is Done when sign-in is ready and at least one calendar is in config.

## Sign-in

You sign in as your `profileId`.

`openclaw family access` reports solo or LAN and changes nothing. In solo mode, everyone who opens the Control UI is the shared owner, and family members use Discord. In LAN mode, each person has their own sign-in, and every member is in `allowUsers`. The cutover is [HOUSEHOLD-LAN.md](HOUSEHOLD-LAN.md).

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
