import assert from "node:assert/strict";
import { test } from "node:test";
import { dueReminders, inQuietHours, reminderAlert, reminderEmbed, reminderKey, reminderMessage, type ReminderEvent } from "./reminder.ts";
import { localTime } from "./week.ts";

const TZ = "America/Halifax";
const QUIET = { startHour: 22, endHour: 7 };
const at = (date: string, hours: number) => localTime(date, hours, TZ);

function event(start: string, owners: ReminderEvent["owners"], extra: Partial<ReminderEvent> = {}): ReminderEvent {
  return { id: "c0/evt-1", title: "Dentist", start, end: new Date(Date.parse(start) + 30 * 60_000).toISOString(), updated: "2026-10-01T12:00:00.000Z", owners, ...extra };
}

test("quiet hours wrap midnight and equal hours are never quiet", () => {
  assert.equal(inQuietHours(at("2026-10-13", 21.99), TZ, QUIET), false);
  assert.equal(inQuietHours(at("2026-10-13", 22), TZ, QUIET), true);
  assert.equal(inQuietHours(at("2026-10-14", 6.99), TZ, QUIET), true);
  assert.equal(inQuietHours(at("2026-10-14", 7), TZ, QUIET), false);
  assert.equal(inQuietHours(at("2026-10-14", 3), TZ, { startHour: 9, endHour: 9 }), false);
  assert.equal(inQuietHours(at("2026-10-14", 10), TZ, { startHour: 9, endHour: 17 }), true);
  assert.equal(inQuietHours(at("2026-10-14", 17), TZ, { startHour: 9, endHour: 17 }), false);
});

test("a lead during quiet hours waits, and the 07:00 tick sends it once", () => {
  const start = new Date(at("2026-10-14", 7.25)).toISOString();
  const dentist = event(start, [{ profileId: "alex", displayName: "Alex" }]);
  assert.deepEqual(dueReminders([dentist], at("2026-10-14", 6.75), TZ, [30], QUIET), []);
  const flushed = dueReminders([dentist], at("2026-10-14", 7), TZ, [30], QUIET);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]!.minsUntil, 15);
  assert.equal(flushed[0]!.key, reminderKey("c0/evt-1", 30, dentist.updated, "alex"));
  assert.equal(dueReminders([dentist], at("2026-10-14", 8), TZ, [30], QUIET).length, 0);
});

test("outside quiet hours a lead within a minute is due, and a second owner is a second reminder", () => {
  const start = new Date(at("2026-10-14", 10)).toISOString();
  const shared = event(start, [
    { profileId: "alex", displayName: "Alex" },
    { profileId: "riley", displayName: "Riley" },
  ]);
  const due = dueReminders([shared], at("2026-10-14", 9.75), TZ, [15], QUIET);
  assert.deepEqual(due.map((item) => item.profileId), ["alex", "riley"]);
  assert.equal(dueReminders([shared], at("2026-10-14", 9.5), TZ, [15], QUIET).length, 0);
});

test("a changed updated time is a new key", () => {
  const start = new Date(at("2026-10-14", 10)).toISOString();
  const first = reminderKey("c0/evt-1", 15, "2026-10-01T12:00:00.000Z", "alex");
  const moved = event(start, [{ profileId: "alex", displayName: "Alex" }], { updated: "2026-10-02T12:00:00.000Z" });
  assert.notEqual(dueReminders([moved], at("2026-10-14", 9.75), TZ, [15], QUIET)[0]!.key, first);
});

test("the reminder embed names the event and the people, and a channel post puts the mention first", () => {
  const start = new Date(at("2026-10-14", 10)).toISOString();
  const dentist = event(start, [{ profileId: "alex", displayName: "Alex" }]);
  const embed = reminderEmbed(dentist, 15, TZ, ["Alex", "Riley"]);
  assert.equal(embed.title, "📅 Dentist");
  assert.equal(embed.description, "⏰ Starting in **15 minutes**");
  assert.match(embed.fields![0]!.value, /10:00 AM/);
  assert.match(embed.fields!.at(-1)!.value, /Alex, Riley/);
  assert.equal(embed.footer, undefined);
  const channel = reminderMessage(dentist, 15, TZ, ["Alex"], "<@333333333333333333>");
  assert.equal(channel.text, "<@333333333333333333> — heads up!");
  assert.equal(reminderMessage(dentist, 0, TZ, ["Alex"]).embed!.description, "⏰ **Starting NOW!**");
});

test("the parent alert names the event and not an id", () => {
  assert.match(reminderAlert("Dentist", "unknown"), /Dentist/);
  assert.equal(reminderAlert("Dentist", "unknown").includes("evt"), false);
  assert.match(reminderAlert("x".repeat(200), "failed"), /no Discord id/);
});
