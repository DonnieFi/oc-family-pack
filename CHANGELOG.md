# Changelog

## 0.2.0 — 2026-10-04

What you can use now.

- The Family page is in the Control UI at `/plugin?plugin=oc-family-pack&id=family`. The week is Monday–Sunday, with a color per person. Chips dim events. They are not who you are. Weather is Environment Canada, and Canada only. The chat strip opens any agent that signed-in person can already open. The page does not need Discord.
- You can change calendars from the page and from chat, through one write path. The page needs `operator.write`, which a kid's role does not have. In Discord, a kid can change their own personal calendar. A change to a shared calendar, a school calendar, or someone else's calendar waits for a parent. Undo is not available.
- The Control UI dashboard has a Today widget, id `family-today`. It is separate from the Today jump on the week grid. It shows up to three highlight lines. A quiet day says "Looks like a quiet day — nothing urgent." A failed read says "Couldn't load today." Without read access it says "You need read access to see today."
- The page shows the latest delivery as one sentence, such as "Daily brief sent to Alex." or "No brief has been sent yet." It does not show a channel id or a clock time. `demo: true` shows a synthetic week and does not invent a delivery row.
- Agents can load the `family` skill at `skills/family/SKILL.md`. It teaches `family_today`, `family_schedule`, and `garbage_schedule`.
- Garbage day is optional. Set `garbageIcsUrl` to a city `.ics` link and use `garbage_schedule`. The rest of the plugin works without it.
- The daily brief posts at 07:00 in the household time zone, to the Discord summary channel, and will still send until noon. The weekly brief posts Sunday at 20:00 (8:00 PM) for the coming week, and will still send until Monday noon. Both run only when `summaryChannel` is set.
- Reminders use your lead times, 15 minutes if you leave them unset, and quiet hours, 22:00–07:00 unless you change them. A reminder that comes due overnight goes out in the hour after quiet hours end. Each person is `dm`, `channel`, or `off`, changed with `set_reminder_mode`. Changing someone else's mode needs a parent.
- Household briefs are optional clock times. `morningTime` is a weekday morning direct message to parents. `afterSchoolTime` is a weekday after-school post. `weekendPreviewTime` is the weekend preview, on Friday unless you set another day. The posts use the summary channel.
- `openclaw family setup` prints a config patch and does not write it. `openclaw family gog` is the headless two-step Google sign-in and never passes `--readonly`. `openclaw family access` tells you solo or LAN and changes nothing. [SETUP.md](SETUP.md) is the household walkthrough. [HOUSEHOLD-LAN.md](HOUSEHOLD-LAN.md) is the LAN cutover.
- Discord is what this version uses for briefs, reminders, and for "me" in chat. Control UI chat works too. You cannot pick another messaging service in this version.
- Calendar data stays on the Gateway. `gog` runs locally. Weather sends Environment Canada a search box around your configured coordinates. A collection calendar, when you set one, is fetched from that link. The SQLite file is `$OPENCLAW_STATE_DIR/plugins/oc-family-pack/oc-family-pack.sqlite` (under `~/.openclaw` when that variable is unset). Uninstall leaves the file in place.
- Parents, and the shared-token owner, see every calendar. Everyone sees shared calendars. A school or personal calendar also goes to its owners when that person is a member, not a guest. Guests, and anyone not on the roster, see shared calendars only.

Not in this version: chores, undo, a messaging-service picker, Home Assistant, RSVP, and appearance themes.

## 0.1.0

0.1.0 was the first package number. Nothing was tagged or published at 0.1.0. The household surface grew under that number until 0.2.0.
