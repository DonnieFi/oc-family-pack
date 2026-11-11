/** Display name, its first word, and aliases. Short or blank tokens are skipped. */
export function nameTokens(member) {
    const tokens = new Set();
    const add = (value) => {
        const key = value?.trim().toLowerCase();
        if (key !== undefined && key.length >= 2)
            tokens.add(key);
    };
    add(member.displayName);
    add(member.displayName.trim().split(/\s+/)[0]);
    for (const alias of member.aliases ?? [])
        add(alias);
    return [...tokens];
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** True when `token` is a whole Unicode word in `title`. */
export function hasName(title, token) {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(token)}(?![\\p{L}\\p{N}])`, "iu").test(title);
}
/** The provider event id: Google's id when the read kept it, otherwise the wire id's tail. */
export function sourceEventId(event) {
    const fromGoogle = event.google?.eventId?.trim();
    if (fromGoogle)
        return fromGoogle;
    const prefix = `${event.calendarKey}/`;
    return event.id.startsWith(prefix) ? event.id.slice(prefix.length) : event.id;
}
/**
 * Participants of one event. Ambiguous words are listed and name nobody.
 * Overrides apply only to this calendar and provider event id.
 */
export function eventParticipants(event, members, overrides = []) {
    const tokenOwners = new Map();
    for (const member of members) {
        if (member.role === "guest")
            continue;
        for (const token of nameTokens(member)) {
            const list = tokenOwners.get(token) ?? [];
            if (!list.includes(member.id))
                list.push(member.id);
            tokenOwners.set(token, list);
        }
    }
    const ids = new Set();
    const ambiguous = new Set();
    const consider = (token) => {
        const owners = tokenOwners.get(token);
        if (owners === undefined || owners.length === 0)
            return;
        if (owners.length > 1) {
            ambiguous.add(token);
            return;
        }
        ids.add(owners[0]);
    };
    for (const token of [...tokenOwners.keys()].sort((left, right) => right.length - left.length)) {
        if (hasName(event.title, token))
            consider(token);
    }
    for (const attendee of event.google?.attendees ?? []) {
        const email = attendee.email?.trim().toLowerCase();
        if (email) {
            const matched = members.filter((member) => member.email === email && member.role !== "guest");
            if (matched.length === 1)
                ids.add(matched[0].id);
            else if (matched.length > 1)
                ambiguous.add(email);
        }
        const name = attendee.name?.trim().toLowerCase();
        if (name)
            consider(name);
    }
    const eventId = sourceEventId(event);
    for (const override of overrides) {
        if (override.calendarKey !== event.calendarKey || override.eventId !== eventId)
            continue;
        if (override.decision === "reject")
            ids.delete(override.memberId);
        else if (members.some((member) => member.id === override.memberId && member.role !== "guest"))
            ids.add(override.memberId);
    }
    return {
        ids: members.map((member) => member.id).filter((id) => ids.has(id)),
        ambiguous: [...ambiguous],
    };
}
/** Participant ids across copies, in roster order, excluding people who already own a projected calendar. */
export function extraParticipantIds(copies, ownerIds, members, overrides) {
    const ids = new Set();
    for (const copy of copies) {
        for (const id of eventParticipants(copy, members, overrides ?? []).ids)
            ids.add(id);
    }
    const owners = new Set(ownerIds);
    return members.map((member) => member.id).filter((id) => ids.has(id) && !owners.has(id));
}
