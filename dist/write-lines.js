/** The verb ux's lines use for each write op. */
export const OP_VERB = { create: "add", update: "change", move: "move", delete: "delete" };
/** An event's name in bold, or "that event" when the write failed before its name was known. */
export const named = (name) => (name ? `**${name}**` : "that event");
/** ux's line when nothing was written: a refused stamp, or the store failing before gog ran. Never the store's own text. */
export const somethingWrongLine = (op, name) => `Something went wrong checking that, so I didn't ${OP_VERB[op]} ${named(name)}.`;
