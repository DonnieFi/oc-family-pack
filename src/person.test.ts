import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "./config.ts";
import { resolveMemberReference } from "./person.ts";

const { members } = parseConfig({
  members: [
    { id: "alex", name: "Alex Smith", role: "parent", profileId: "alex", discordId: "100000000000000001", aliases: ["dad"] },
    { id: "riley", name: "Riley Smith", role: "kid", profileId: "riley", aliases: ["ri", "ri-ri"] },
    { id: "rj", name: "Riley Jones", role: "kid" },
    { id: "j1", name: "Jordan Smith", role: "kid" },
    { id: "j2", name: "Jordan Jones", role: "kid" },
    { id: "jo", name: "Aunt Jo", role: "guest", aliases: ["jo", "aunt jo"] },
  ],
});

const idOf = (token: string): string | undefined => {
  const found = resolveMemberReference(members, token);
  return "member" in found ? found.member.id : undefined;
};

test("people resolve by id, login, display name, first name, alias and Discord id", () => {
  for (const token of ["alex", "Alex", "Alex Smith", "dad", "100000000000000001"]) {
    assert.equal(idOf(token), "alex", token);
  }
  assert.equal(idOf("Riley Smith"), "riley");
  assert.equal(idOf("riley"), "riley", "an exact id wins over another person's first name");
  assert.equal(idOf("aunt jo"), "jo");
  assert.equal(idOf("JO"), "jo");
});

test("unknown and ambiguous references fail closed", () => {
  const errorOf = (token: string): string | undefined => {
    const found = resolveMemberReference(members, token);
    return "error" in found ? found.error : undefined;
  };
  assert.equal(errorOf("Nobody"), "That person is not in the family.");
  assert.match(errorOf("Jordan") ?? "", /matches more than one person/);
  assert.match(errorOf(" ") ?? "", /not in the family/);
});

test("aliases cannot collide with an id, login, or another alias", () => {
  assert.throws(
    () =>
      parseConfig({
        members: [
          { id: "alex", name: "Alex", role: "parent" },
          { id: "sam", name: "Sam", role: "parent", aliases: ["alex"] },
        ],
      }),
    /already.*name, id, login, alias/,
  );
  assert.throws(
    () =>
      parseConfig({
        members: [
          { id: "alex", name: "Alex", role: "parent", aliases: ["dad"] },
          { id: "sam", name: "Sam", role: "parent", aliases: ["dad"] },
        ],
      }),
    /already.*name, id, login, alias/,
  );
  assert.throws(
    () => parseConfig({ members: [{ id: "alex", name: "Alex", role: "parent", aliases: ["dad", "dad"] }] }),
    /more than once/,
  );
});
