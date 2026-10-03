import assert from "node:assert/strict";
import { test } from "node:test";
import type { CalendarConfig, Config, MemberConfig } from "./types.ts";
import { visibleCalendarIds, type Viewer } from "./visibility.ts";

const member = (profileId: string, role: MemberConfig["role"]): MemberConfig => ({ profileId, displayName: profileId, role, devices: [] });
const calendar = (id: string, kind: CalendarConfig["kind"], owners: string[]): CalendarConfig => ({ key: id, id, label: id, kind, owners });

const config: Pick<Config, "members" | "calendars"> = {
  members: [member("alex", "parent"), member("riley", "kid"), member("jordan", "kid"), member("gran", "guest")],
  calendars: [
    calendar("family", "shared", []),
    calendar("alex-work", "personal", ["alex"]),
    calendar("riley-own", "personal", ["riley"]),
    calendar("jordan-own", "personal", ["jordan"]),
    calendar("school", "school", ["riley", "jordan"]),
    calendar("gran-own", "personal", ["gran"]),
    calendar("orphan-school", "school", []),
  ],
};
const ALL = config.calendars.map((entry) => entry.id);
const seen = (viewer: Viewer) => [...visibleCalendarIds(config, viewer)].sort();
const person = (username: string | undefined): Viewer => ({ kind: "person", username });

test("a shared-token owner sees every calendar", () => {
  assert.deepEqual(seen({ kind: "owner" }), [...ALL].sort());
});

test("a parent sees every calendar, including ones with no owners", () => {
  assert.deepEqual(seen(person("alex")), [...ALL].sort());
});

test("a kid sees shared calendars, their school calendar and their own", () => {
  assert.deepEqual(seen(person("riley")), ["family", "riley-own", "school"]);
  assert.deepEqual(seen(person("jordan")), ["family", "jordan-own", "school"]);
});

test("a guest sees shared calendars only, even one listing them as an owner", () => {
  assert.deepEqual(seen(person("gran")), ["family"]);
});

test("a stranger or an unnamed session sees shared calendars only", () => {
  assert.deepEqual(seen(person("mallory")), ["family"]);
  assert.deepEqual(seen(person(undefined)), ["family"]);
});

test("a username matches only the exact profileId", () => {
  for (const near of ["Alex", "alex@example.com", " alex", "alex "]) {
    assert.deepEqual(seen(person(near)), ["family"], near);
  }
});
