import assert from "node:assert/strict";
import { test } from "node:test";
import { contrastRatio, mixTowardInk } from "./contrast.ts";

const MEMBERS = {
  blue: "oklch(0.72 0.14 245)",
  amber: "oklch(0.72 0.16 55)",
  pink: "oklch(0.72 0.18 310)",
  green: "oklch(0.75 0.15 150)",
} as const;

test("muted text and the neutral stripe clear their floors on the card", () => {
  assert.equal(contrastRatio("#8b8b94", "#161920"), 5.208);
  assert.equal(contrastRatio("#6e6960", "#ffffff"), 5.451);
  assert.equal(contrastRatio("oklch(0.8 0.03 80)", "#161920"), 9.4);
  assert.equal(contrastRatio("oklch(0.55 0.03 70)", "#ffffff"), 4.875);
});

test("member colours already clear 3:1 on the dark card", () => {
  assert.deepEqual(
    Object.fromEntries(Object.values(MEMBERS).map((color) => [color, contrastRatio(color, "#161920")])),
    {
      [MEMBERS.blue]: 7.168,
      [MEMBERS.amber]: 6.761,
      [MEMBERS.pink]: 6.582,
      [MEMBERS.green]: 8.381,
    },
  );
});

test("light mode mixes each member colour toward ink until it clears 3.1:1", () => {
  const ink = "#211e1a";
  const card = "#ffffff";
  assert.deepEqual(
    Object.fromEntries(Object.values(MEMBERS).map((color) => [color, contrastRatio(color, card)])),
    {
      [MEMBERS.blue]: 2.454,
      [MEMBERS.amber]: 2.601,
      [MEMBERS.pink]: 2.672,
      [MEMBERS.green]: 2.099,
    },
  );
  assert.deepEqual(mixTowardInk(MEMBERS.blue, ink, card), {
    inkPercent: 14.3,
    ratio: 3.1,
    color: "oklch(0.6509 0.1212 220.72)",
  });
  assert.deepEqual(mixTowardInk(MEMBERS.amber, ink, card), {
    inkPercent: 10,
    ratio: 3.104,
    color: "oklch(0.6717 0.1449 57.02)",
  });
  assert.deepEqual(mixTowardInk(MEMBERS.pink, ink, card), {
    inkPercent: 8.2,
    ratio: 3.105,
    color: "oklch(0.6804 0.1660 320.26)",
  });
  assert.deepEqual(mixTowardInk(MEMBERS.green, ink, card), {
    inkPercent: 19.5,
    ratio: 3.1,
    color: "oklch(0.6500 0.1225 135.41)",
  });
  assert.deepEqual(mixTowardInk(MEMBERS.blue, ink, "#fff"), mixTowardInk(MEMBERS.blue, ink, card));
  assert.deepEqual(mixTowardInk(MEMBERS.blue, ink, "#161920"), {
    inkPercent: 0,
    ratio: 7.168,
    color: MEMBERS.blue,
  });
});
