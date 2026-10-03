import type { Config } from "./types.ts";

/**
 * Who is asking for a week. `owner` is a shared-token sign-in, the only
 * caller who sees the whole household. Everyone else is a `person`, named by
 * the username the Gateway authenticated, or by no name at all.
 */
export type Viewer = { kind: "owner" } | { kind: "person"; username: string | undefined };

/**
 * Calendar ids `viewer` may see. Parents and the owner see every calendar.
 * Everyone sees `shared` calendars. A `school` or `personal` calendar also goes
 * to the members in its `owners`. A username matches a member only when it
 * equals that member's `profileId` exactly, so guests, strangers and unnamed
 * sessions get `shared` calendars only.
 */
export function visibleCalendarIds(config: Pick<Config, "members" | "calendars">, viewer: Viewer): Set<string> {
  const member = viewer.kind === "person" ? config.members.find((entry) => entry.profileId === viewer.username) : undefined;
  const seesAll = viewer.kind === "owner" || member?.role === "parent";
  const isMember = member !== undefined && member.role !== "guest";
  return new Set(
    config.calendars
      .filter((calendar) => seesAll || calendar.kind === "shared" || (isMember && calendar.owners.includes(member.profileId)))
      .map((calendar) => calendar.id),
  );
}
