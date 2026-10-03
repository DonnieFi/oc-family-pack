/** Who approves when the roster has no parents. */
export const SETUP_PERSON = "the person who set this up";
const APPROVAL = { "personal-own": "needs-approval", "personal-other": "needs-approval", shared: "needs-approval", school: "needs-approval" };
/**
 * Bernie's role gate let parents past every check (task_access.can_view_task) and had
 * no per-calendar rule, so the kid row is new. Reads are the visibility filter's job.
 */
const TABLE = {
    parent: { "personal-own": "write", "personal-other": "write", shared: "write", school: "write" },
    kid: { ...APPROVAL, "personal-own": "write" },
    guest: APPROVAL,
};
/**
 * The writer's role and roster id. Discord trusts only a roster match. Off Discord the
 * owner flag doesn't name a person, so a tool caller writes as a kid with no calendar of
 * their own. The page writes as a parent until s5k.34.6 checks operator.write.
 */
function writer(requester) {
    switch (requester.from) {
        case "discord":
            return requester.member ? { role: requester.member.role, profileId: requester.member.profileId } : { role: "guest" };
        case "tool":
            return { role: "kid" };
        case "page":
            return { role: "parent" };
        case "other":
            return { role: "guest" };
    }
}
/** Whether this requester may write to this calendar, or who has to approve it. Handlers ask this and never branch on role. */
export function writeRight(members, requester, calendar) {
    const { role, profileId } = writer(requester);
    const target = calendar.kind !== "personal" ? calendar.kind : profileId !== undefined && calendar.owners.includes(profileId) ? "personal-own" : "personal-other";
    if (TABLE[role][target] === "write")
        return { right: "write" };
    const parents = members.filter((member) => member.role === "parent").map((member) => member.displayName);
    return { right: "needs-approval", approvers: parents.length > 0 ? parents : [SETUP_PERSON] };
}
