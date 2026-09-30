# oc-family-pack audit: gaps for "family helps manage schedules"

Date: 2026-09-30
Scope: all 30 beads under `oc-family-pack-s5k`, the current stub in `src/`, and cross-checks
against Bernie at `/opt/family-bot` (commit 824606d) and `gog calendar` v0.39.1.

Short version: **the beads are very strong on read-and-tell, and thin exactly where
"help manage" means write, coordinate, and undo.**

## The biggest gap: the write loop is create-only

`oc-family-pack-s5k.28` (`family.calendar.create`) is the *only* write action in the whole
contract (`s5k.30`). Everything else is read or broadcast. But managing a family schedule is
mostly not creating:

| Family says | Bead coverage | `gog` capability that already exists |
|---|---|---|
| "practice moved to 6pm" | none | `calendar update <cal> <eventId> --from --to` |
| "soccer's cancelled" | none | `calendar delete` |
| "it moved to Dad's calendar" | none | `calendar move <cal> <eventId> <dest>` |
| "swim every Tuesday" | none | `create/update --rrule 'RRULE:FREQ=WEEKLY;BYDAY=TU'` |
| "remind us 1 day ahead" | partially (`s5k.11` polling only) | `create/update --reminder popup:1d` |
| "Riley's coming too" | none | `--add-attendee` |
| "it's an all-day thing" | none | `--all-day` |

Every one of those is a single gog subcommand the host already has. This is the single
highest-value missing slice — without it the family can add and never fix.

## No approval, no undo, no idempotency on writes

- **Draft/confirm is gone.** Bernie did `store_draft` → post to `#smithy` → ✅/❌ reaction →
  `create_event` (`bot/tools/calendar.py:144`, `bot/bot.py:2442-2468`). `s5k.28` writes
  straight through and "confirms back". For a shared family calendar driven by an LLM,
  unconfirmed writes are the risk.
- **Kids' requests are a parenthetical.** `.28` says "Optional later: kids' requests need
  parent approval" — that's a bead that doesn't exist. `s5k.14` covers chore approval, not
  event approval.
- **No undo, no audit.** No bead records who created/changed what, and there's no "revert"
  path. For a calendar everyone shares, "Sam moved the dentist" needs to be answerable.
- **No write idempotency.** `s5k.11` defines an idempotency key for reminders; `s5k.28` has
  none. A retry after a 20s gog timeout (the reader's own timeout, `src/calendar-gog.ts:8`)
  creates a duplicate event with no way to detect it.

## No "is everyone free?" — the actual coordination question

Zero hits across all beads for RSVP, free/busy, or conflict-on-write (the only "conflict"
string is the weekend-preview text in `s5k.12`).

- Bernie had RSVP end-to-end: `save_rsvp` on ✅/❌/🤔 reactions (`bot/bot.py:2470-2474`),
  `get_rsvps` tool, `/rsvps` slash command (`bot/slash/family_cmds.py:126`). **None of it is
  ported**, and `gog calendar respond` exists if you want it in Google instead.
- `gog calendar freebusy` and `gog calendar conflicts` exist and are unused. "Are we free
  Saturday afternoon" is the family-coordination question and there's no query for it.
  `s5k.7` returns a classified day; it can't answer availability.
- No conflict check *before* a create. A write should be able to say "that overlaps Riley's
  soccer".

## No write-permission model — and one live hole

`src/config.ts` has `role: parent|kid|guest`, and `s5k.26` defines Gateway roles, but **no
bead maps roles to calendar write rights.** `s5k.28` leans on "the Gateway role as the gate"
plus a *model-supplied member* for calendar choice. That means a kid can name any member and
land the event on that person's calendar — the model picks the target, not the identity.
`s5k.24`'s page dialog also requires the user to pick the member, which compounds it.

Missing: which calendars each role may write, whether a kid can write to a parent calendar,
whether the school calendar is parent-only, and what a `guest` may do at all.
`gog calendar acl <cal>` exists if you want the real Google ACL as the source.

## Family members editing Google directly is invisible

`calendar.changed` (`s5k.30`) fires "after writes and when the reader sees new data" — but
nothing polls or watches. If Sam moves an event in the Google Calendar app on her phone, the
page (which the notes say refreshes on `calendar.changed`, with *no* polling) never sees it.
`gog calendar changed` lists recent changes including deletions; there's no bead using it, and
no syncToken/etag story. `FamilyEvent` (`src/types.ts:36-45`) carries no `updated`/`etag`, so
the reminder idempotency key from `s5k.11` ("event updated time") has nothing to hash.

## Concrete code-vs-bead mismatches you'll hit

- **`htmlLink` is dropped.** `s5k.28`'s AC says "replies with the link", but `parseGogEvents`
  (`src/calendar-gog.ts:41-70`) captures neither `htmlLink` nor `updated`. The reply would
  need the create response, not a re-read.
- **`recurring` / `movedFromOriginal` don't exist yet.** `s5k.5` requires them;
  `src/types.ts` has neither.
- **Write scope is unverified.** `s5k.4` trims setup to
  `gog auth add --services calendar`, which is *service*-level, not write-vs-read. `gog` has a
  `--readonly` mode, so a read-only grant is a live failure mode with no bead to detect or
  explain it.
- **`--send-updates` defaults to `none`.** Creating an event with attendees won't notify
  anyone unless you set it. Nothing in the beads mentions notification mode.

## Operational trust gaps

- **Silent failure.** `s5k.10` works out *how* to post, but no bead covers *knowing it
  failed*. No delivery receipt, no dead-man alert. If the daily brief stops posting on a
  Tuesday, the family just… doesn't get it, and that's how they stop trusting it.
- **No stale-data signal.** `src/calendar-gog.ts` has a 20s timeout and yields
  `status: "error"`, and the weather card can serve stale — but nothing tells the user "you're
  looking at 3-hour-old data" before they act on it.
- **No feature flags for cutover.** `s5k.9` gives Bernie a `bts.handed_off` switch. There's
  no matching plugin-side kill switch for writes — so a bad write behavior can't be turned
  off without uninstalling.

## Family-member access and onboarding

`s5k.26` (gateway), `s5k.29` (Discord), `s5k.4` (import) cover the operator setup. Missing
for the *family*, not the operator:

- No bead for what a kid's experience actually is on the page and in chat (allowed tools,
  visible calendars, what they can change).
- No self-service identity linking — `.4` is a one-shot import; if Sam's Discord ID changes or
  a new family member appears, re-running is manual. `users.linkChannelIdentity` is there,
  nothing wires it to a flow.
- No family-facing runbook / "here's how to ask Bernie to change something" — `.27` is the
  agent skill, not the humans'.

## Recommended filing order

1. `family.calendar.update` / `move` / `delete` actions + tools (one bead, unblocks the whole
   write loop)
2. Draft → confirm → commit with per-role approval and an undo window
3. Write-permission model: role → allowed calendars, plus a real write-scope check at startup
4. Write idempotency + a small append-only write log (who/what/when), giving you audit *and*
   revert
5. `family.availability` (freebusy) + conflict check surfaced on create
6. RSVP/attendance for shared events (port Bernie's, or delegate to Google via
   `calendar respond`)
7. External-change detection: `gog calendar changed` poll + `updated`/`etag` on `FamilyEvent`
   so `calendar.changed` fires for edits made outside the plugin
8. Delivery receipt + failure alert for briefs (trust)
9. `htmlLink`/`attendees`/`recurring`/`movedFromOriginal` on `FamilyEvent`
10. Write feature flag + per-role runbook for kids

Suggested edges: 1 → 2/3/5, 4 → 7.