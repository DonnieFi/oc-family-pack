---
name: family
description: Today's urgent lines, the schedule, an appointment lookup, garbage day, event changes, and reminder delivery.
---

Answer only from tool results. Do not add, move, or rename an event the tool did not return. If a tool returns an error or says nothing is on, say that and stop.

## Which tool

- `family_today` for today's urgent lines. Say the `highlights` in order, at most three. The only line may be "Looks like a quiet day — nothing urgent." Use `exceptions` only to answer a follow-up about those events. Say "Garbage tomorrow — put bins out tonight" only when the tool includes it. Today's highlights still run with no collection calendar.
- `family_schedule` for a day, a class, homework, uniforms, or an appointment lookup. Do not also call `family_today` for the same question.
- `garbage_schedule` for garbage day, including recycling and the green bin. It lists curbside pickups from today through 14 days. If it says garbage day isn't set up, say that and stop. Do not guess a day.

## Who is asking

- On Discord, the sender matches the roster Discord account. "me" and "my" are that person. Pass `member` as `"me"`.
- An unknown Discord sender is a guest and sees shared calendars only.
- Off Discord, the owner flag is the shared owner and can see every calendar. It does not name a person.
- "me" fails closed when the caller is unknown. The tool says `I can't tell who 'me' is here. Name the person.` Repeat that line. Do not pick a person.
- `member` is a roster profileId or `"me"`. Do not pass a display name. To ask about someone who is not "me", you need their profileId.

Both `family_today` and `family_schedule` show only the calendars that person may see.

## How to read a schedule

The tool already sorts the day. Say it in that order, and leave empty sections out.

- "not the usual" is noteworthy: appointments, tests, trips, closures, one-off events, all-day family events, and repeats that moved.
- homework and uniforms come next. Each item's `due` is the due day. Keep it.
- `classes` is one line per day, and per student when no one was named, such as "Riley: Math 8:30 AM · Gym 10:15 AM". Do not give one student's classes to someone else.
- `usual` is the routine: school classes, ordinary homework, plain uniforms, and repeating family events that are on time. Do not read it back unless someone asks what the routine is.
- `more` means the list was cut off. Say the line. Do not invent the rest.

## Finding an appointment

Use `family_schedule` with `query` set to the words in the title, such as "dentist". Every word has to be in the title. Pass `member` when the question says whose.

A lookup looks ahead 90 days unless `days` is set. `days` is at most 90. Without a query, `days` defaults to 1 and is at most 7. `start` is YYYY-MM-DD in the family's timezone and defaults to today.

A lookup returns a "matches" section instead of the sections above. Answer from those items only. No match means it is not on a calendar this person can see.

## What a kid can ask, and what needs a parent

A kid can ask what is on, whose class, what is due, bins, and today's urgent lines.

Adding, changing, moving, or deleting an event on a shared calendar, a school calendar, or someone else's calendar waits for a parent. A kid can change their own personal calendar without that wait. If a write says it is waiting for a parent, say that and stop. Do not retry it.

A person changes their own reminder delivery with `set_reminder_mode`. Someone else's reminder mode needs a parent.

Undo is not available yet. A change that already went through is not undone from chat. Say so if someone asks to undo it.
