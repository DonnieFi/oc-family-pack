/** The page's quiet line. No ids, no Discord ids, no error text. */
export const DELIVERY_STATUS_METHOD = "family.deliveryStatus";
export const DELIVERY_EMPTY = "No brief has been sent yet.";
export const DELIVERY_UNAVAILABLE = "Couldn't check the last brief.";
const KIND_WORD = {
    daily: "Daily brief",
    weekly: "Weekly brief",
    reminder: "Reminder",
    household: "Household brief",
    alert: "Alert",
};
/** One sentence for the latest row. A target that is not a roster profile id adds no destination. */
export function deliveryStatusLine(row, roster) {
    const kind = KIND_WORD[row.kind];
    if (kind === undefined)
        return undefined;
    const name = roster.find((member) => member.profileId === row.target)?.displayName;
    const named = typeof name === "string" && name.trim() !== "" ? name : undefined;
    const line = sentence(kind, row.status, named);
    if (line === undefined)
        return undefined;
    return { line, failed: row.status === "failed" };
}
function sentence(kind, status, name) {
    if (status === "sent")
        return name === undefined ? `${kind} sent.` : `${kind} sent to ${name}.`;
    if (status === "partial")
        return name === undefined ? `${kind} partly sent.` : `${kind} partly sent to ${name}.`;
    if (status === "failed")
        return name === undefined ? `${kind} did not send.` : `${kind} did not send to ${name}.`;
    if (status === "held")
        return name === undefined ? `${kind} is waiting to send.` : `${kind} to ${name} is waiting to send.`;
    if (status === "unknown")
        return name === undefined ? `${kind} may not have been sent.` : `${kind} to ${name} may not have been sent.`;
    return undefined;
}
/**
 * The Family page reads this. An empty log says none has been sent.
 * A store that is not open, or a failed read, says the check failed. It never includes the target.
 */
export function deliveryStatusMethod(store, roster = () => []) {
    return async ({ respond }) => {
        const unavailable = { line: DELIVERY_UNAVAILABLE, failed: false };
        try {
            const current = store();
            if (!current) {
                respond(true, unavailable);
                return;
            }
            const row = await current.latestDelivery();
            if (row === undefined) {
                respond(true, { line: DELIVERY_EMPTY, failed: false });
                return;
            }
            const view = deliveryStatusLine(row, roster());
            respond(true, view ?? unavailable);
        }
        catch {
            respond(true, unavailable);
        }
    };
}
