// Gateway methods for the People page. operator.write is set by the registrar,
// so a kid never receives contact details. Nothing here writes config.
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { DELIVERY_NOTE, DIRECTORY_PERSISTENCE, RESERVATION_NOTE } from "./directory-contract.js";
import { directoryMembers, planDirectoryEdit, planMaterialize, MATERIALIZE_INTRO } from "./directory.js";
import { DEMO_MEMBERS } from "./demo.js";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rawRoster(raw) {
    const config = isRecord(raw) ? raw : {};
    return {
        members: Array.isArray(config.members) ? config.members : [],
        calendars: Array.isArray(config.calendars) ? config.calendars : [],
    };
}
const EDIT_KEYS = ["id", "displayName", "login", "gatewayProfileId", "email", "phone", "discordId", "devices"];
function parseEdits(value) {
    if (!Array.isArray(value))
        return undefined;
    const edits = [];
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim() === "")
            return undefined;
        for (const key of Object.keys(entry)) {
            if (!EDIT_KEYS.includes(key))
                return undefined;
        }
        const edit = { id: entry.id };
        if ("displayName" in entry) {
            if (typeof entry.displayName !== "string" || entry.displayName.trim() === "")
                return undefined;
            edit.displayName = entry.displayName;
        }
        for (const key of ["login", "gatewayProfileId", "email", "phone", "discordId"]) {
            if (!(key in entry))
                continue;
            const field = entry[key];
            if (field !== null && typeof field !== "string")
                return undefined;
            edit[key] = field;
        }
        if ("devices" in entry) {
            if (!Array.isArray(entry.devices))
                return undefined;
            edit.devices = entry.devices;
        }
        edits.push(edit);
    }
    return edits;
}
/** The roster a parent may view. Demo mode shows the sample family and no private network data beyond that sample. */
export function directoryMethod(config, _raw) {
    return async ({ respond }) => {
        const current = config();
        respond(true, {
            demo: current.demo,
            persistence: DIRECTORY_PERSISTENCE,
            delivery: DELIVERY_NOTE,
            reservation: RESERVATION_NOTE,
            members: directoryMembers(current.demo ? DEMO_MEMBERS : current.members),
        });
    };
}
/** Validate an edit or an id migration and return a config patch. This does not write. */
export function directoryPreviewMethod(config, raw) {
    return async ({ params, respond }) => {
        const current = config();
        if (current.demo) {
            respond(true, { ok: false, error: "Demo mode shows the sample family. Turn demo off before previewing a roster patch." });
            return;
        }
        const body = isRecord(params) ? params : null;
        if (body === null || (body.op !== "materialize" && body.op !== "edit")) {
            respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "family.directory.preview takes op materialize or edit"));
            return;
        }
        const roster = rawRoster(raw());
        if (body.op === "materialize") {
            const preview = planMaterialize(roster.members, roster.calendars);
            if (!preview.ok) {
                respond(true, { ok: false, error: preview.error });
                return;
            }
            respond(true, {
                ok: true,
                changed: preview.changed,
                patch: preview.patch,
                note: preview.changed ? `${MATERIALIZE_INTRO} ${DIRECTORY_PERSISTENCE}` : "Every member and device already has an id. No changes to make.",
            });
            return;
        }
        const edits = parseEdits(body.edits);
        if (edits === undefined) {
            respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "family.directory.preview edits must be a list of member updates"));
            return;
        }
        const preview = planDirectoryEdit(roster.members, edits, roster.calendars);
        if (!preview.ok) {
            respond(true, { ok: false, error: preview.error });
            return;
        }
        respond(true, {
            ok: true,
            changed: preview.changed,
            patch: preview.patch,
            note: preview.changed ? DIRECTORY_PERSISTENCE : "No changes to make.",
        });
    };
}
