/**
 * Calendar ids `viewer` may see. Parents and the owner see every calendar.
 * Everyone sees `shared` calendars. A `school` or `personal` calendar also goes
 * to the members in its `owners`. A username matches a member only when it
 * equals that member's `profileId` exactly, so guests, strangers and unnamed
 * sessions get `shared` calendars only.
 */
export function visibleCalendarIds(config, viewer) {
    const member = viewer.kind === "person" ? config.members.find((entry) => entry.profileId === viewer.username) : undefined;
    const seesAll = viewer.kind === "owner" || member?.role === "parent";
    const isMember = member !== undefined && member.role !== "guest";
    return new Set(config.calendars
        .filter((calendar) => seesAll || calendar.kind === "shared" || (isMember && calendar.owners.includes(member.profileId)))
        .map((calendar) => calendar.id));
}
