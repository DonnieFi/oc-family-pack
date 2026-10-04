import type { WriteLogRow } from "./store.ts";

/** ux's write lines the page shows as well as the Gateway. Nothing here may pull in Gateway code: the Control UI bundle imports it. */
export type WriteOp = WriteLogRow["op"];

/** The verb ux's lines use for each write op. */
export const OP_VERB: Readonly<Record<WriteOp, string>> = { create: "add", update: "change", move: "move", delete: "delete" };

/** An event's name in bold, or "that event" when the write failed before its name was known. */
export const named = (name: string | undefined) => (name ? `**${name}**` : "that event");

/** ux's line when nothing was written: a refused stamp, or the store failing before gog ran. Never the store's own text. */
export const somethingWrongLine = (op: WriteOp, name: string | undefined) => `Something went wrong checking that, so I didn't ${OP_VERB[op]} ${named(name)}.`;
