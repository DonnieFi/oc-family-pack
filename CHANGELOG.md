# Changelog

## Unreleased

- An appointment that names someone, such as "Riley dentist" on Alex's calendar, shows in that person's week and answers. It is not copied and nobody is invited. A name shared by two people is left unset until the household confirms one. The rest of a hidden calendar stays hidden.
- `openclaw family setup --guide` asks the remaining steps, remembers the answers, and can resume. cancel does not report success. `--noninteractive` prints the checklist. `--dry-run` says nothing was applied. The guide does not write Gateway config.
- Setup lists the Discord alerts channel, the morning, after-school, and weekend-preview briefs, and the garbage calendar. A channel, clock time, or `.ics` link already in the config is Done. One Discord channel already on the Gateway is the id the alerts step prints. These five are optional and do not block "Everything is set up."
- A shared school calendar can name who a title is for. `audienceRules` match a title phrase, first rule wins, and keep only people who already own that calendar. `school` is every owner, `cohort` is owners in that cohort, and `student` is the named owners. Put the narrower rule first. When no rule matches, the owners are unchanged.
- The People page opens a profile banner and the Lobsterdex. A parent picks up to eight companions. The choice is stored on that person's card and applied with the config patch. The page stays parent-only.
- An all-day uniform or homework note whose calendar end is the same day still shows on that day.
- Shared copies of one event keep a durable id. A title or time edit does not change it, and two appointments on one calendar stay separate. A write still changes one authorized calendar event.

- Start calendar change polling with a seven-day window so Google does not reject the initial 30-day request.

- The Family week separates uniforms, day information and collapsible homework. Person chips filter to one person and include their classes; important school notices remain in day information. Display ownership follows configured calendars rather than guessing a student from feed volume. Uniform notes stay visible on a narrow week and name the child. A day that only has homework does not say nothing is planned. A notice such as "PE exam" stays on the day.

- Legacy devices with repeated labels now load and materialize collision-free ids. Unique label-based ids and all explicit ids are preserved. Migration is deterministic across roster/device ordering, and freezes ids before later renames.
- Device reservations now accept only IPv4 literals. IPv6 (including previously accepted malformed literals) is refused with an explicit IPv4 error; remove or replace existing IPv6 reservations before upgrading.
- The tested host is now OpenClaw `2026.11.1`. The devDependency, `build.openclawVersion`, `install.minHostVersion`, `compat.pluginApi`, peer range (`>=2026.11.1 <2026.12`), lockfile and host-pin test move together. The isolated smoke passes on 11.1. The `family_schedule` smoke derives its expected wall times from the family zone, so it passes in both EST and EDT.
- People can have `aliases` (`Mom`, `Dad`, `Aunt Jo`). `family_schedule`, `set_reminder_mode` and `family_contact` resolve a unique id, login, display name, first name, alias or Discord id; an ambiguous name fails closed. `family_members` gives the agent the roster without contacts. Aliases never grant identity.
- `family setup` understands `login`, validates the roster with the same parser the plugin uses, warns about derived member ids, materializes an id when it adds a Discord id or email, checks `allowUsers`, `identityScopes` and calendar owners, and prints parent Discord targets for calendar approvals. LAN parents get `operator.approvals`.
- The Today widget and page writes use Gateway methods that resolve the signed-in viewer. Page writes, the People directory and TodayHome require a roster parent (or the shared owner), not just `operator.write`. A calendar the requester cannot see is refused before an approval.
- Calendar `key` can be pinned so reordering does not change wire ids; labels must be unique. Delivery rows record whether a target is a member or a channel, a pre-send `no-channel` failure is final, a member without Discord gets no retry flood, and reminders default to `off` for them. `discordAccount` selects the family bot account.
- The People page edits several cards into one patch and can change aliases, role and reminder mode. `gatewayProfileId` is no longer editable from the page. Email-shaped trusted-proxy usernames are accepted; an email login gets a local-part member id and display name so the address is never echoed as an id.
- `accessMode: "lan"` makes a paired device token a guest instead of the shared owner. Demo mode refuses calendar writes and does not start briefs, reminders, or household jobs. `family setup` checks the roster through the plugin parser, compares Gateway scopes by role (an extra `operator.admin` is still a parent), warns on derived ids and a missing LAN `accessMode`, and points at the exact People-page/config edit when a member has no login.

- Calendar writes from the agent now default to `confirm`. If you never set `writes`, the agent will ask for a parent's approval before it changes a calendar. Set `writes: "on"` to keep the old behaviour.
- Needs OpenClaw `2026.11.1` or newer, before `2026.12`. Tested on `2026.11.1`. The peer range is `>=2026.11.1 <2026.12`; a later 2026.11 patch is admitted but is not claimed until the smoke passes on it. An install on OpenClaw 2026.10.x has to upgrade OpenClaw first.
- A member needs only a name. `email`, `phone`, `discordId` and `profileId` are optional. Setup warns about a member with no Discord account; it does not refuse them. Email and phone are stored and are not notification routes. They stay off the week, the Family page, briefs, and logs. The People page shows them to a parent and previews a config patch. It does not write the Gateway config. `family_contact` returns one person's card only when the host sets `senderIsOwner`. `family.week` and `family.members` renamed each member's `profileId` to `memberId`. The values are the same. A client that reads `profileId` from either has to switch to `memberId`.
- `openclaw family setup --materialize-ids` prints a patch that writes the member and device ids this config already uses. Calendar owners stay as they are. After you apply it, a name or login change does not change a member id. New people from setup are written with an explicit id.
- `openclaw family setup --email NAME=address` stores an email on that person's card. A bad address is not repeated in the error. The lines above the config patch do not print addresses. The patch itself does, because applying it replaces the whole members list.
- `family_schedule`'s `member` is a roster member id, or `"me"` on Discord.
- A fresh Home gets the Today card once. Removing it does not put it back. The Family page then offers "Pin Today on Home". Someone who cannot write is not asked.
- `npm run build` runs `openclaw plugins build` in a throwaway state directory. It refuses the live Gateway's state directory, ports 18789 and 18799, and a pid whose command is the live gateway.

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
