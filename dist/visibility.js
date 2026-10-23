/**
 * The roster person a page viewer is, or no one.
 * A host-attested Gateway profile id matches `gatewayProfileId` only.
 * Otherwise the trusted-proxy username matches `profileId` exactly.
 * A name, email, MAC, IP, or member id is not a page identity. Two profile
 * matches are no one: the caller is not guessed.
 */
export function memberForViewer(config, viewer) {
    if (viewer.kind === "member")
        return config.members.find((entry) => entry.id === viewer.id);
    if (viewer.kind !== "person")
        return undefined;
    if (viewer.gatewayProfileId !== undefined) {
        const matches = config.members.filter((entry) => entry.gatewayProfileId === viewer.gatewayProfileId);
        if (matches.length === 1)
            return matches[0];
        if (matches.length > 1)
            return undefined;
    }
    if (viewer.username === undefined)
        return undefined;
    return config.members.find((entry) => entry.profileId === viewer.username);
}
/**
 * Calendar ids `viewer` may see. Parents and the owner see every calendar.
 * Everyone sees `shared` calendars. A `school` or `personal` calendar also goes
 * to the members in its `owners`. A username matches a member only when it
 * equals that member's `profileId` exactly, so guests, strangers, unnamed
 * sessions, and a member with no login get `shared` calendars only. A `member`
 * viewer is a roster person already matched by a verified Discord sender.
 */
export function visibleCalendarIds(config, viewer) {
    const member = memberForViewer(config, viewer);
    const seesAll = viewer.kind === "owner" || member?.role === "parent";
    const isMember = member !== undefined && member.role !== "guest";
    return new Set(config.calendars
        .filter((calendar) => seesAll || calendar.kind === "shared" || (isMember && calendar.owners.includes(member.id)))
        .map((calendar) => calendar.id));
}
