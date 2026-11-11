import { hasName } from "./participants.js";
/**
 * People a school event is for, when a household rule narrows the calendar owners.
 * Absent means no rule changed the owner list. An empty list means a rule matched
 * and none of the owners are in it. The first matching rule wins.
 */
export function narrowedAudience(event, calendars, members, rules) {
    if (rules === undefined || rules.length === 0)
        return undefined;
    const keys = event.calendarKeys ?? [event.calendarKey];
    const sources = keys.flatMap((key) => {
        const calendar = calendars.get(key);
        return calendar ? [calendar] : [];
    });
    if (sources.length === 0 || sources.some((calendar) => calendar.kind !== "school"))
        return undefined;
    const ownerSet = new Set(sources.flatMap((calendar) => calendar.owners));
    const owners = members.map((member) => member.id).filter((id) => ownerSet.has(id));
    for (const rule of rules) {
        if (rule.calendar !== undefined && !keys.includes(rule.calendar))
            continue;
        if (!hasName(event.title, rule.title))
            continue;
        const audience = peopleFor(rule, owners, members);
        if (audience.length === owners.length)
            return undefined;
        return audience;
    }
    return undefined;
}
/** True when an earlier rule would match every title the later rule was written for. */
export function ruleShadows(earlier, later) {
    const overlap = earlier.calendar === undefined || later.calendar === undefined || earlier.calendar === later.calendar;
    return overlap && hasName(later.title, earlier.title);
}
function peopleFor(rule, owners, members) {
    if (rule.audience === "school")
        return [...owners];
    if (rule.audience === "cohort") {
        const cohort = rule.cohort ?? "";
        return owners.filter((id) => members.find((member) => member.id === id)?.cohorts?.includes(cohort));
    }
    const students = new Set(rule.students ?? []);
    return owners.filter((id) => students.has(id));
}
