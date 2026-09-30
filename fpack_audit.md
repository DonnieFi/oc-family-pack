# oc-family-pack audit: gaps for "family helps manage schedules"

Date: 2026-09-30 (rewritten 2026-09-30 after the epic restructure and team review)
Scope: all 53 beads under `oc-family-pack-s5k`, branch `epic/foundation` vs `main`,
the code in `src/`, and cross-checks against Bernie at `/opt/family-bot` (read-only)
plus `gog calendar` v0.39.1.

---

## Part 1 — Feature gaps: what the plan was missing

Short version: **the plan was very strong on read-and-tell, and thin exactly where
"help manage" means write, coordinate, and undo.** Most of these are now filed as
epics s5k.31-37; the remaining ownerless gaps are called out at the end of this part.

### The biggest gap: the write loop was create-only

`family.calendar.create` was the *only* write action in the whole contract. Everything
else was read or broadcast. But managing a family schedule is mostly not creating:

| Family says | Bead coverage at the time | `gog` capability that already exists |
|---|---|---|
| "practice moved to 6pm" | none | `calendar update <cal> <eventId> --from --to` |
| "soccer's cancelled" | none | `calendar delete` |
| "it moved to Dad's calendar" | none | `calendar move <cal> <eventId> <dest>` |
| "swim every Tuesday" | none | `create/update --rrule 'RRULE:FREQ=WEEKLY;BYDAY=TU'` |
| "remind us 1 day ahead" | partially (poll-only reminders) | `create/update --reminder popup:1d` |
| "Riley's coming too" | none | `--add-attendee` |
| "it's an all-day thing" | none | `--all-day` |

Every one of those is a single gog subcommand the host already has. Now `s5k.28`.

### No approval, no undo, no idempotency on writes

- **Draft/confirm was gone.** Bernie did `store_draft` -> post to a channel -> reaction
  -> `create_event` (`bot/tools/calendar.py:144`, `bot/bot.py:2442-2468`). The plan wrote
  straight through and "confirmed back". For a shared family calendar driven by an LLM,
  unconfirmed writes are the risk. Now `s5k.34.3`.
- **Kids' requests were a parenthetical.** "Optional later: kids' requests need parent
  approval" was a bead that did not exist. Now `s5k.34.3`.
- **No undo, no audit.** Nothing recorded who created or changed what, and there was no
  revert path. Now `s5k.34.2` (write log) and `s5k.34.4` (undo).
- **No write idempotency.** Reminders had an idempotency key; writes had none. A retry
  after a 20s gog timeout creates a duplicate event with no way to detect it. Now `s5k.34.2`.

### No "is everyone free?" — the actual coordination question

Zero hits across the plan for RSVP, free/busy, or conflict-on-write.

- Bernie had RSVP end-to-end: `save_rsvp` on reactions (`bot/bot.py:2470-2474`),
  `get_rsvps` tool, `/rsvps` slash (`bot/slash/family_cmds.py:126`). **None of it was
  ported.** Now `s5k.37.1`; Google-native alternative is `gog calendar respond`.
- `gog calendar freebusy` and `gog calendar conflicts` existed and were unused. "Are we
  free Saturday afternoon" is the coordination question and nothing answered it. Now `s5k.34.7`.
- No conflict check *before* a create. Now `s5k.34.5`.

### No write-permission model — and one live hole

`role: parent|kid|guest` existed in config and Gateway roles existed in the plan, but
**nothing mapped roles to calendar write rights.** The create bead leaned on "the Gateway
role as the gate" plus a *model-supplied member* for calendar choice, which means a kid
could name any member and land the event on that person's calendar — the model picks the
target, not the identity. Now `s5k.34.1`.

### Family members editing Google directly was invisible

`calendar.changed` was specified to fire "after writes and when the reader sees new data",
but nothing polled or watched. A parent moving an event in the Google app on their phone
would never reach the page. `gog calendar changed` lists recent changes including deletions.
Now `s5k.33.1`.

### Operational trust gaps

- **Silent failure.** Delivery was specified but not *observability* — no delivery receipt,
  no dead-man alert. Now `s5k.35.1`.
- **No stale-data signal.** Now `s5k.33.1` (calendar).
- **No feature flags for cutover.** Bernie got a `bts.handed_off` switch; the plugin had no
  matching kill switch. Now `s5k.34.6`.

### Family-member access and onboarding

Missing for the *family*, not the operator: what a kid's experience actually is, self-service
identity linking, and a family-facing runbook. Now `s5k.27` and `s5k.37.3`.

### Ownerless gaps (as of this rewrite)

Two items from this list still have no bead:

- **`--add-attendee` on write.** `s5k.28`'s create flag list omits it and no other bead
  mentions attendee management on write. (`s5k.37.2` covers attendees/ invites as a deferred
  feature, but the create path never wires them.)
- **Weather staleness.** `s5k.33.1` covers *calendar* staleness. The weather card can serve
  a cached observation up to 30 minutes past its real age with no age signal, and nothing
  owns that.

---

## Part 2 — Code and plan review of `epic/foundation`

Four independent review lenses: correctness/tests, privacy/security, architecture rules,
UX/accessibility/docs. Reviewed `git diff main...epic/foundation` (2 commits, 37 files).

**Gates, all green:** `npm run typecheck` clean, `npm test` 23/23 pass,
`npm run validate` -> `{"valid":true,"errors":[]}`, `openclaw plugins build --check` up to
date, `npm run check:dist` -> `dist/ matches src/ (9 files)`.

**Verdict:** nothing here is broken, but **`s5k.24`'s own acceptance criteria cannot be met on
this branch**, and the restructure left a few of Part 1's gaps without an owner.

The structural work is genuinely good: real calendar IDs are replaced by positional keys
(`c0`, `c1`), Google write fields are stripped in `toWire` (`calendar-gog.ts:126-128`), the old
CSP/escaping sink is structurally eliminated rather than reimplemented (every DOM node is
`createElement` + text; zero `innerHTML` in `src/` or `dist/`), and the browser bundle makes
**zero** network calls — its entire authority is one scope-checked read.

### Consensus findings (two lenses landed on each independently)

**1. One bad calendar erases the whole family week.** `src/calendar-gog.ts:189`
```ts
if (reads.some((read) => read.status === "unconfigured")) return { status: "unconfigured", hint: GOG_SETUP_HINT };
```
`ENOENT` at `:158` is genuinely global, but the per-account auth failure at `:168-170` is
not — and `GOG_AUTH_FAILURE` also matches `invalid_grant` for a single calendar. One kid's
expired token collapses the entire week into "Connect your family calendars" and tells the
operator to *install gog*. This contradicts the function's own doc comment at `:183`
("One failing calendar becomes a warning beside the rest") and makes the per-calendar
warning path at `:192-200` unreachable in the mixed case.
**This is the failure a real household hits first.**

**2. gog's stderr reaches the page.** `calendar-gog.ts:135` redacts only the *configured*
calendar id, then returns gog's last stderr line as `message` -> `contract.ts:60` -> the
warning banner. Privacy lens: any other identifier or token echoed in stderr is published,
and `MESSAGE_MAX` bounds length, not content. UX lens: `"gog exited with code 1"` is not "a
calm family week". Clamp to a known-string allowlist or drop stderr.

**3. A malformed all-day date rejects the entire `family.week` call.** `readTime`
(`calendar-gog.ts:55`) accepts any `^\d{4}-\d{2}-\d{2}$` without checking the date exists, so
`"2026-13-45"` flows through, satisfies the schema (`contract.ts:40` is bare `Text(32)`),
then `eventSpan` -> `addDays` (`week.ts:121`) throws — out of `readCalendar`'s try, out of
`Promise.all`, rejecting the whole payload including roster and weather. Every *other* junk
field in that function is defensively `continue`d; this one isn't. Worse variant: a bad
`start` with a valid `end` places the event on the wrong days, or none, silently.

### Should-fix, high value

| Area | Finding |
|---|---|
| Architecture | **`openclaw/plugin-sdk/tool-plugin` is a 4th SDK subpath** (`index.ts:2`) not in AGENTS.md's allowlist, and the host's own compat registry marks it `status: "deprecated"` since 2026-07-15. It is unavoidable: `definePluginEntry` exposes a **getter-only** `configSchema`, so `plugin.configSchema = …` throws under ESM strict mode — which is *why* the metadata hack exists, though the comment at `index.ts:20-22` does not say so. Amend AGENTS.md or knowingly accept. |
| Architecture | **Two disagreeing config schemas.** `entry.configSchema` is `emptyPluginConfigSchema()` — it rejects *any* non-empty config. It works only because runtime validation reads `manifestRecord.configSchema` from the committed `openclaw.plugin.json`. Correctness currently depends on a generated JSON artifact, with no test tying the two together. `s5k.3` adds `devices[]`/`aliases[]`, and until `plugins build` re-runs and the manifest is recommitted, those get rejected. |
| Correctness | **`startOfLocalDay` returns the *second* local midnight on DST fall-back** (`week.ts:85-103`). The bisection invariant "the guess is outside the day" only holds for forward shifts. Verified against a brute-force oracle across 27 zones: **22 of 71 ambiguous-midnight transitions wrong.** All known instances are past dates today, but this is the primitive `s5k.34` writes will build on. |
| Correctness | **Google titles/locations are never HTML-unescaped.** No unescape anywhere in `src/`. Every household sees literal `&amp;` in every title containing `&`, `'`, `"` or `<`. The fixture has no entity-bearing field, so nothing can catch it. This was an explicit item in `s5k.5`'s notes. |
| Privacy | **No bead owns read scoping.** Any `operator.read` session gets *every* member's personal calendar in full. The person chips are cosmetic — they toggle a class on nodes whose text is already in the DOM (`control-ui.ts:165,336-340`). This is exactly the documented "roles are collaboration, not isolation" caveat, and `FAQ.md:58-62` / `README.md:137-139` do not say so; a reader will take "anyone with operator.read" as access control. |
| Correctness | **The 5° bbox step returns a distant foreign forecast** (`weather-ec.ts:4`). `readEcWeather(Seattle)` -> `status: "ok"`, `stationName: "Vancouver"`, ~200 km away, no indication. `bboxUrl` also does not clamp latitude, so `lat: 89` emits `bbox=…,94.000`. |
| UX/a11y | **Today emphasis is invisible on phones** — the badge lives in `.ocfp-day-head`, which is `display:none` at <=760px (`control-ui.css:825-827`); the narrow replacement signals today with a 1px border tint and no text. Phones are the stated audience (README/FAQ point at Tailscale Serve for family phones). |
| UX/a11y | **Dimming and person colours fail WCAG contrast.** `.is-dimmed` = `opacity: 0.32` (`control-ui.css:504-507`) -> measured 1.6-2.8:1 against a 4.5:1 requirement. The fixed OKLCH palette in `week.ts:7-10` has no light variant -> 2.1-2.7:1 against a white card, below the 3:1 non-text threshold, and that colour is the *sole* visual identifier of ownership (card bar, chip dot, owner dots). |

### The bead problem to decide on

`s5k.24`'s AC — *"add-event from the page shows the new event after `calendar.changed`"* — is
unsatisfiable on this branch for three independent reasons: no add-event UI (writes are
`s5k.28`), no dependency edge `s5k.24 -> s5k.28`, and **`contract.ts:103` declares
`events: {}`**, so `defineFeaturePlugin` skips `api.registerService` entirely and
`watch(..., { events: [] })` (`control-ui.ts:111-115`) can never fire. The page is a one-shot
snapshot that only refreshes on reconnect.

Two related plan gaps:

- `s5k.24`'s notes promise *"last brief delivery status"* and *"updated N min ago"*, but
  `s5k.35` and `s5k.36` both merge after `s5k.33` with **no edge between them** — that
  surface has no home and no bead.
- The bead says `host.dock.openSession`. **`host.dock` does not exist** in 2026.9.7's
  `ControlUiHost` — the code correctly used `host.sessions.open` (`control-ui.ts:510`).
  Correct the bead so the next person does not burn a cycle, and drop "dock open" from the
  screenshot AC.

Also: `renderWeek` does a full `replaceChildren` rebuild (`control-ui.ts:343-347`). Harmless
with no refresh events; the moment `events` is populated, keyboard focus inside the grid
drops to `<body>` on every push. Fix the shape before `s5k.28` lands.

### Lower priority, for the queue

- `MAX_WEEK_EVENTS` error message quotes a count that is wrong in the byte-limit case, and a
  test asserts the wrong text (`payload.test.ts:122`).
- `--max 250` per calendar (`calendar-gog.ts:149-151`) may silently truncate with no entry in
  `warnings`.
- Duplicate wire ids survive `parseGogEvents` and render twice (`calendar-gog.ts:105`,
  clipping at `EVENT_ID_MAX`).
- Unbounded `?start=` (`week.ts:112-117`) lets a browser page through family calendar history,
  one fresh `gog` fetch per week.
- `.claude/settings.json` and `.codex/config.toml` auto-execute `bd prime --hook-json` on
  session start from a public clone.
- No lockfile ships despite the allowlist (`.gitignore:9-10`), so `typebox ^1.3.34` resolves
  unpinned on every `plugins install git:…`.
- `dist/` ships but is absent from AGENTS.md's "What gets published" list (`.gitignore:22`
  allowlists it and the allowlist change was its own commit with a reason, so the commit
  followed procedure — the published-file list in AGENTS.md is what is out of date).
- The page never checks `host.connection.canRead`, so a scope-less kid sees the nav entry,
  a wasted `gog` round-trip, and a raw Gateway error (`control-ui.ts:139-145,545-546`).
- `host.signal` / `presented` lifecycle requirements from `s5k.24` are unimplemented;
  `openAgentChat` (`control-ui.ts:504-517`) can navigate off a disposed page.
- Forced-colors / high-contrast mode is entirely unhandled: the gradient person bar, chip
  dots, and owner dots are all `background-color`, so the per-person channel vanishes with no
  text fallback — and event cards carry only time, title, and location.
- Orphan `role="tabpanel"` at desktop (`control-ui.ts:279`) with no visible tablist until
  <=760px.
- Hand-rolled agent buttons (`control-ui.ts:474-483`) instead of the SDK's
  `mountAgentPicker` / `mountSelectPicker`.
- `MAX_MEMBERS` (`contract.ts:4`) is a *wire* node budget reused as the config `maxItems`;
  separate the roster cap from the node budget.
- `HOST_MAX_NODES = 4096` (`payload.ts:8-9`) hardcodes host internals; the arithmetic comment
  at `contract.ts:6-13` will rot silently.

### Verified clean

Secrets and API keys (none; no Google client code, gog only) · XSS and untrusted-content
rendering (all `textContent`, zero `innerHTML` in `src/` and `dist/`; CSS injection closed by
the color pattern at `config.ts:8`) · command execution and argument injection (`execFile`, no
shell, literal `--` separator before the calendar id, asserted by test at
`calendar-gog.test.ts:111-137`) · path/file handling (no `fs`, no untrusted paths in plugin
code) · real family data in `src/`, `dist/` and the manifest (only RFC-2606 placeholders; the
`ec-ottawa.json` fixture is a public Environment Canada response) · parse-once boundary
(`parseConfig` called once at `index.ts:13`) · contract node-budget arithmetic (recomputed
from scratch, holds exactly) · schema-vs-runtime conformance (checked across demo, busiest,
over-cap, mixed-failure and unconfigured payloads) · multi-day and overnight spans, all-day
exclusive-end handling · prototype-era doc residue (zero matches for iframe/basePath/HTTP
route) · Bernie-specific wording in shipped copy (none).

---

## Suggested order

1. Split `s5k.24`'s AC to what the branch actually ships (dark/light/narrow, minus dock) and
   add `s5k.24 -> s5k.28`
2. Fix the blanked-week bug + stderr passthrough (small, high household impact)
3. Malformed-date throw, entity unescaping, `startOfLocalDay` bisection
4. Contrast pass on the `week.ts` palette and `.is-dimmed`; Today emphasis on phones
5. File: read-scoping bead, weather staleness bead, attendees-on-write bead
6. Fix this file: redact the channel name at Part 1, and drop the now-stale `FamilyEvent`
   claim noted below

### Corrections to the previous revision of this file

- **The "FamilyEvent carries no `updated`/`etag`" claim is stale.** `GoogleEventFields`
  (`calendar-gog.ts:27-28,77-82`) does carry `updated` and `etag`, and `htmlLink` is captured
  at `:117-119`. The *external-change-detection* gap is real and is now `s5k.33.1`; only the
  code-level justification was wrong.
- The channel name previously quoted in the draft/confirm paragraph is redacted to
  `#<channel>`: this file is allowlisted and ships to a public repo, and AGENTS.md's Privacy
  section covers bead and planning text.