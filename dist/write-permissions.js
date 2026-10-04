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
 * Whether a page session may write. Only the host's granted scopes decide: operator.write,
 * or operator.admin, which the host treats as every operator scope
 * (operator-scope-compat operatorScopeSatisfied). No client or no scopes is a guest.
 */
export function pageRole(client) {
    const scopes = Array.isArray(client?.scopes) ? client.scopes : [];
    return scopes.includes("operator.write") || scopes.includes("operator.admin") ? "parent" : "guest";
}
/**
 * The writer's role and roster id. Discord trusts only a roster match. Off Discord the
 * owner flag doesn't name a person, so a tool caller writes as a kid with no calendar of
 * their own. The page is a parent or a guest by its connection's scopes.
 */
function writer(requester) {
    switch (requester.from) {
        case "discord":
            return requester.member ? { role: requester.member.role, profileId: requester.member.profileId } : { role: "guest" };
        case "tool":
            return { role: "kid" };
        case "page":
            return { role: pageRole(requester.client) };
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
    return { right: "needs-approval", approvers: approvers(members) };
}
/** Every roster parent, or the setup person when there are none. */
export function approvers(members) {
    const parents = members.filter((member) => member.role === "parent").map((member) => member.displayName);
    return parents.length > 0 ? parents : [SETUP_PERSON];
}
