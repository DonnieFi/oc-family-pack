import { DEMO_MEMBERS } from "./demo.js";
import { pageRole } from "./write-permissions.js";
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
    const byGateway = viewer.gatewayProfileId === undefined
        ? []
        : config.members.filter((entry) => entry.gatewayProfileId === viewer.gatewayProfileId);
    if (byGateway.length > 1)
        return undefined;
    const byUsername = viewer.username === undefined ? undefined : config.members.find((entry) => entry.profileId === viewer.username);
    // Two identities that disagree are not a person. Fail closed rather than
    // letting a stale gatewayProfileId override the signed-in username.
    if (byGateway.length === 1 && byUsername !== undefined && byGateway[0].id !== byUsername.id)
        return undefined;
    return byGateway[0] ?? byUsername;
}
/**
 * Calendar ids `viewer` may see. Parents and the owner see every calendar.
 * Everyone sees `shared` calendars. A `school` or `personal` calendar also goes
 * to the members in its `owners`. A username matches a member only when it
 * equals that member's `profileId` exactly, so guests, strangers, unnamed
 * sessions, and a member with no login get `shared` calendars only. A `member`
 * viewer is a roster person already matched by a verified Discord sender.
 */
/** The read viewer implied by a write requester, used to keep hidden calendars out of approvals. */
export function viewerForRequester(requester) {
    switch (requester.from) {
        case "discord":
            return requester.member ? { kind: "member", id: requester.member.id } : { kind: "person", username: undefined };
        case "page": {
            const role = requester.role ?? (pageRole(requester.client) === "parent" ? "parent" : "guest");
            return role === "parent" ? { kind: "owner" } : { kind: "person", username: undefined };
        }
        case "tool":
            return requester.senderIsOwner ? { kind: "owner" } : { kind: "person", username: undefined };
        default:
            return { kind: "person", username: undefined };
    }
}
function rosterMembers(config) {
    return config.demo ? DEMO_MEMBERS : config.members;
}
/** A page parent is the shared owner or a roster parent. A roster kid/guest is not. */
export function isRosterParent(config, viewer) {
    if (viewer.kind === "owner")
        return true;
    if (memberForViewer({ members: rosterMembers(config) }, viewer)?.role === "parent")
        return true;
    // Demo shows a synthetic roster but a real parent may still be signed in.
    return config.demo && memberForViewer({ members: config.members }, viewer)?.role === "parent";
}
export function visibleCalendarIds(config, viewer) {
    const member = memberForViewer(config, viewer);
    const seesAll = viewer.kind === "owner" || member?.role === "parent";
    const isMember = member !== undefined && member.role !== "guest";
    return new Set(config.calendars
        .filter((calendar) => seesAll || calendar.kind === "shared" || (isMember && calendar.owners.includes(member.id)))
        .map((calendar) => calendar.id));
}
