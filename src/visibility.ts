import type { Config } from "./types.ts";

/**
 * Who is asking for a week. `owner` is a shared-token sign-in, the only
 * caller who sees the whole household. Everyone else is a `person`, named by
 * the username the Gateway authenticated, or by no name at all.
 */
export type Viewer = { kind: "owner" } | { kind: "person"; username: string | undefined } | { kind: "member"; id: string };

/**
 * Calendar ids `viewer` may see. Parents and the owner see every calendar.
 * Everyone sees `shared` calendars. A `school` or `personal` calendar also goes
 * to the members in its `owners`. A username matches a member only when it
 * equals that member's `profileId` exactly, so guests, strangers, unnamed
 * sessions, and a member with no login get `shared` calendars only. A `member`
 * viewer is a roster person already matched by a verified Discord sender.
 */
export function visibleCalendarIds(config: Pick<Config, "members" | "calendars">, viewer: Viewer): Set<string> {
  const member =
    viewer.kind === "member"
      ? config.members.find((entry) => entry.id === viewer.id)
      : viewer.kind === "person" && viewer.username !== undefined
        ? config.members.find((entry) => entry.profileId === viewer.username)
        : undefined;
  const seesAll = viewer.kind === "owner" || member?.role === "parent";
  const isMember = member !== undefined && member.role !== "guest";
  return new Set(
    config.calendars
      .filter((calendar) => seesAll || calendar.kind === "shared" || (isMember && calendar.owners.includes(member.id)))
      .map((calendar) => calendar.id),
  );
}
