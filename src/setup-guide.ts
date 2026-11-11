import type { SetupStep } from "./setup.ts";

/** A stored answer. It names a step, never a secret. */
export type GuideCheckpoint = {
  version: 1;
  answers: { id: string; value: "yes" | "no" | "skip" }[];
};

export type GuideState = {
  load: () => Promise<GuideCheckpoint | undefined>;
  save: (checkpoint: GuideCheckpoint) => Promise<void>;
};

const ANSWERS = new Set(["yes", "no", "back", "skip", "cancel"]);

export type GuideRun = {
  ok: boolean;
  text: string;
  checkpoint: GuideCheckpoint;
  /** False for a noninteractive checklist, which is not a saved guide run. */
  save: boolean;
};

function stepId(name: string): string {
  return name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
}

function checkpointOf(answers: GuideCheckpoint["answers"]): GuideCheckpoint {
  return { version: 1, answers };
}

function emptyCheckpoint(): GuideCheckpoint {
  return checkpointOf([]);
}

function parseCheckpoint(value: GuideCheckpoint | undefined): GuideCheckpoint {
  if (value === undefined || value.version !== 1 || !Array.isArray(value.answers)) return emptyCheckpoint();
  const answers = value.answers.flatMap((answer) =>
    answer && (answer.value === "yes" || answer.value === "no" || answer.value === "skip") && typeof answer.id === "string"
      ? [{ id: answer.id, value: answer.value }]
      : [],
  );
  return checkpointOf(answers);
}

/** Walk the remaining setup steps. Nothing here writes Gateway config. */
export function runGuide(input: {
  steps: readonly SetupStep[];
  checkpoint?: GuideCheckpoint;
  answers: readonly string[];
  dryRun: boolean;
  noninteractive?: { ok: boolean; text: string };
  settled: { ok: boolean; text: string };
}): GuideRun {
  if (input.noninteractive) {
    return { ok: input.noninteractive.ok, text: input.noninteractive.text, checkpoint: parseCheckpoint(input.checkpoint), save: false };
  }
  const pending = input.steps.filter((step) => !step.done).map((step) => ({
    ...step,
    id: stepId(step.name),
    optional: step.optional === true || step.name === "Location",
  }));
  const stored = new Map(parseCheckpoint(input.checkpoint).answers.map((answer) => [answer.id, answer.value]));
  const answers: GuideCheckpoint["answers"] = [];
  for (const step of pending) {
    const value = stored.get(step.id);
    if (value === undefined) break;
    answers.push({ id: step.id, value });
  }
  if (pending.length === 0) {
    return { ok: input.settled.ok, text: input.settled.text, checkpoint: checkpointOf(answers), save: true };
  }
  for (const raw of input.answers) {
    const choice = raw.trim().toLowerCase();
    if (!ANSWERS.has(choice)) {
      return { ok: false, text: "Answer yes, no, back, skip, or cancel.", checkpoint: checkpointOf(answers), save: true };
    }
    if (choice === "cancel") {
      return {
        ok: false,
        text: "Setup was cancelled. Nothing was changed.",
        checkpoint: checkpointOf(answers),
        save: true,
      };
    }
    if (choice === "back") {
      answers.pop();
      continue;
    }
    const step = pending[answers.length];
    if (step === undefined) break;
    if (choice !== "yes" && choice !== "no" && choice !== "skip") {
      return { ok: false, text: "Answer yes, no, back, skip, or cancel.", checkpoint: checkpointOf(answers), save: true };
    }
    if (choice === "skip" && !step.optional) {
      return {
        ok: false,
        text: `${step.name} is required. skip is only for optional steps.`,
        checkpoint: checkpointOf(answers),
        save: true,
      };
    }
    answers.push({ id: step.id, value: choice });
  }
  const checkpoint: GuideCheckpoint = { version: 1, answers };
  const step = pending[answers.length];
  if (step !== undefined) {
    const choices = step.optional ? "yes, no, skip, or back" : "yes, no, or back";
    return {
      ok: false,
      text: [`${step.name}`, step.next, "", `Answer ${choices}. cancel stops without applying anything.`].join("\n"),
      checkpoint,
      save: true,
    };
  }
  const chosen = answers.flatMap((answer) => {
    if (answer.value !== "yes") return [];
    const found = pending.find((item) => item.id === answer.id);
    return found ? [found.next] : [];
  });
  const body = chosen.length > 0 ? chosen.join("\n\n") : "No changes to make.";
  const ending = input.dryRun ? "Dry run. Nothing was applied." : "Nothing was written to the Gateway config.";
  return { ok: false, text: `${body}\n\n${ending}`, checkpoint, save: true };
}

/** Read a checkpoint JSON string. A bad body starts the guide over. */
export function readGuideCheckpoint(body: string | undefined): GuideCheckpoint | undefined {
  if (body === undefined || body.trim() === "") return undefined;
  try {
    return parseCheckpoint(JSON.parse(body) as GuideCheckpoint);
  } catch {
    return undefined;
  }
}
