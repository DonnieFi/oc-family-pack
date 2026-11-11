import assert from "node:assert/strict";
import { test } from "node:test";
import { runGuide, type GuideCheckpoint } from "./setup-guide.ts";
import type { SetupStep } from "./setup.ts";

const STEPS: SetupStep[] = [
  { name: "Access", done: true, next: "access command" },
  { name: "Timezone", done: false, next: "Set timezone America/Halifax" },
  { name: "Location", done: false, next: "Set location for riley@example.com" },
  { name: "Members", done: false, next: "Add Riley" },
  { name: "Calendars", done: false, next: "family gog" },
];

const SETTLED = { ok: false, text: "Timezone: To do\n\nNext: Set timezone America/Halifax" };

test("a guide asks the next incomplete step and resumes from the checkpoint", () => {
  const first = runGuide({ steps: STEPS, answers: [], dryRun: false, settled: SETTLED });
  assert.equal(first.ok, false);
  assert.match(first.text, /^Timezone\n/);
  assert.equal(first.text.includes("checklist is complete"), false);
  const resumed = runGuide({ steps: STEPS, checkpoint: first.checkpoint, answers: ["yes"], dryRun: true, settled: SETTLED });
  assert.match(resumed.text, /^Location\n/);
  const checkpoint = JSON.stringify(resumed.checkpoint);
  assert.equal(checkpoint.includes("example.com"), false);
  assert.equal(checkpoint.includes("America/Halifax"), false);
});

test("skip is only for location, back returns, and cancel is not success", () => {
  const skipped = runGuide({ steps: STEPS, answers: ["skip"], dryRun: false, settled: SETTLED });
  assert.equal(skipped.ok, false);
  assert.match(skipped.text, /Timezone is required/);
  const after = runGuide({
    steps: STEPS,
    checkpoint: { version: 1, answers: [{ id: "timezone", value: "yes" }] },
    answers: ["skip", "back", "no"],
    dryRun: false,
    settled: SETTLED,
  });
  assert.match(after.text, /^Members\n/);
  assert.deepEqual(after.checkpoint.answers.map((answer) => [answer.id, answer.value]), [
    ["timezone", "yes"],
    ["location", "no"],
  ]);
  const cancelled = runGuide({ steps: STEPS, answers: ["cancel"], dryRun: false, settled: SETTLED });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.text, "Setup was cancelled. Nothing was changed.");
  assert.equal(cancelled.text.includes("complete"), false);
  assert.equal(cancelled.text.includes("Everything is set up"), false);
});

test("a finished dry run lists only the accepted steps and says it was not applied", () => {
  const checkpoint: GuideCheckpoint = {
    version: 1,
    answers: [
      { id: "timezone", value: "yes" },
      { id: "location", value: "skip" },
      { id: "members", value: "no" },
    ],
  };
  const done = runGuide({ steps: STEPS, checkpoint, answers: ["yes"], dryRun: true, settled: SETTLED });
  assert.match(done.text, /Set timezone America\/Halifax/);
  assert.match(done.text, /family gog/);
  assert.equal(done.text.includes("Add Riley"), false);
  assert.match(done.text, /Dry run\. Nothing was applied\.$/);
  assert.equal(done.ok, false);
});

test("noninteractive mode is the checklist, and a finished household is not asked again", () => {
  const printed = runGuide({
    steps: STEPS,
    answers: ["yes"],
    dryRun: false,
    noninteractive: { ok: false, text: "Timezone: To do\nNext: Set timezone" },
    settled: SETTLED,
  });
  assert.equal(printed.text, "Timezone: To do\nNext: Set timezone");
  assert.equal(printed.save, false);
  const doneSteps = STEPS.map((step) => ({ ...step, done: true }));
  const settled = { ok: true, text: "Everything is set up." };
  const again = runGuide({ steps: doneSteps, answers: [], dryRun: false, settled });
  assert.equal(again.ok, true);
  assert.equal(again.text, "Everything is set up.");
});
