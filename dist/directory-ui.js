// People page: a view and a patch preview of the one roster. It does not write config.
import { DELIVERY_NOTE, DIRECTORY_METHOD, DIRECTORY_PREVIEW_METHOD, DIRECTORY_PERSISTENCE, RESERVATION_NOTE } from "./directory-contract.js";
function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
        if (value !== undefined && value !== false)
            node.setAttribute(name, value === true ? "" : value);
    }
    node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return node;
}
function field(label, value, onInput) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => onInput(input.value));
    return h("label", { class: "ocfp-field" }, h("span", {}, label), input);
}
function deviceDraft(device) {
    return {
        id: device.id,
        label: device.label,
        ...(device.hostname !== undefined ? { hostname: device.hostname } : {}),
        primaryMac: device.primaryMac,
        aliasMacs: [...device.aliasMacs],
        source: device.source,
        ...(device.reservation !== undefined ? { reservation: { ...device.reservation } } : {}),
        sharedWith: [...device.sharedWith],
    };
}
function memberDraft(member) {
    return { ...member, devices: member.devices.map(deviceDraft) };
}
/** The edit the preview method applies. Devices are sent in full so a field change does not drop a MAC. */
export function editFrom(member) {
    return {
        id: member.id,
        displayName: member.displayName,
        login: member.login ?? null,
        gatewayProfileId: member.gatewayProfileId ?? null,
        email: member.email ?? null,
        phone: member.phone ?? null,
        discordId: member.discordId ?? null,
        devices: member.devices.map((device) => ({
            ...(device.id !== "" ? { id: device.id } : {}),
            label: device.label,
            ...(device.hostname !== undefined && device.hostname !== "" ? { hostname: device.hostname } : {}),
            primaryMac: device.primaryMac,
            ...(device.aliasMacs.length > 0 ? { aliasMacs: device.aliasMacs } : {}),
            source: device.source,
            ...(device.sharedWith.length > 0 ? { sharedWith: device.sharedWith } : {}),
            ...(device.reservation !== undefined ? { reservation: device.reservation } : {}),
        })),
    };
}
const RESTRICTED = "Contact cards are for a parent. This sign-in can read the week, and it cannot see emails, phone numbers, or devices.";
/**
 * People. A parent loads the roster, edits one card, and previews the config
 * patch. A kid sees the restriction and the page does not request the roster.
 */
export function mountPeoplePage(container, initial) {
    const host = initial.host;
    const root = h("div", { class: "oc-family-pack" }, h("section", { class: "ocfp-people ocfp-panel", "aria-label": "People" }));
    const section = root.querySelector("section");
    if (section === null)
        return;
    container.append(root);
    let disposed = false;
    const show = (node) => {
        section.replaceChildren(node);
    };
    const load = () => {
        if (disposed)
            return;
        if (!host.connection.connected) {
            show(h("p", { class: "ocfp-people-note" }, "The Gateway is not connected."));
            return;
        }
        if (!host.connection.canWrite) {
            show(h("p", { class: "ocfp-people-note" }, RESTRICTED));
            return;
        }
        show(h("p", { class: "ocfp-people-note" }, "Loading people…"));
        void host.request(DIRECTORY_METHOD, {}).then((body) => {
            if (disposed)
                return;
            const members = Array.isArray(body?.members) ? body.members.map(memberDraft) : [];
            render(members, body?.persistence ?? DIRECTORY_PERSISTENCE, body?.delivery ?? DELIVERY_NOTE, body?.reservation ?? RESERVATION_NOTE, body?.demo === true);
        }, () => {
            if (!disposed)
                show(h("p", { class: "ocfp-people-note" }, "People didn't load."));
        });
    };
    const render = (members, persistence, delivery, reservation, demo) => {
        let selected = 0;
        const list = h("div", { class: "ocfp-people-list", role: "list" });
        const form = h("div", { class: "ocfp-people-form" });
        const result = h("pre", { class: "ocfp-patch", "aria-label": "Config patch" });
        const paintForm = () => {
            const member = members[selected];
            form.replaceChildren();
            if (member === undefined) {
                form.append(h("p", { class: "ocfp-people-note" }, "No one is in the family yet. Add someone with `openclaw family setup`."));
                return;
            }
            form.append(h("p", { class: "ocfp-person-id" }, `Id ${member.id}`), field("Name", member.displayName, (value) => {
                member.displayName = value;
            }), field("Login", member.login ?? "", (value) => {
                if (value === "")
                    delete member.login;
                else
                    member.login = value;
            }), field("Gateway profile id", member.gatewayProfileId ?? "", (value) => {
                if (value === "")
                    delete member.gatewayProfileId;
                else
                    member.gatewayProfileId = value;
            }), field("Email", member.email ?? "", (value) => {
                if (value === "")
                    delete member.email;
                else
                    member.email = value;
            }), field("Phone", member.phone ?? "", (value) => {
                if (value === "")
                    delete member.phone;
                else
                    member.phone = value;
            }), field("Discord id", member.discordId ?? "", (value) => {
                if (value === "")
                    delete member.discordId;
                else
                    member.discordId = value;
            }));
            for (const device of member.devices) {
                form.append(h("fieldset", { class: "ocfp-device" }, h("legend", {}, device.label || "Device"), field("Device label", device.label, (value) => {
                    device.label = value;
                }), field("Hostname", device.hostname ?? "", (value) => {
                    if (value === "")
                        delete device.hostname;
                    else
                        device.hostname = value;
                }), field("MAC", device.primaryMac, (value) => {
                    device.primaryMac = value;
                }), field("Reserved IP", device.reservation?.address ?? "", (value) => {
                    if (value === "") {
                        delete device.reservation;
                        return;
                    }
                    device.reservation = { address: value, source: device.reservation?.source ?? "operator", ...(device.reservation?.network !== undefined ? { network: device.reservation.network } : {}) };
                }), field("Shared with", device.sharedWith.join(", "), (value) => {
                    device.sharedWith = value.split(",").map((part) => part.trim().toLowerCase()).filter((part) => part !== "");
                })));
            }
        };
        const paintList = () => {
            list.replaceChildren(...members.map((member, index) => {
                const button = h("button", { type: "button", class: index === selected ? "ocfp-person is-selected" : "ocfp-person", "aria-pressed": index === selected ? "true" : "false" }, member.displayName);
                button.addEventListener("click", () => {
                    selected = index;
                    paintList();
                    paintForm();
                });
                return button;
            }));
        };
        const preview = h("button", { type: "button" }, "Preview patch");
        preview.addEventListener("click", () => {
            const member = members[selected];
            if (member === undefined)
                return;
            result.textContent = "Checking the patch…";
            void host.request(DIRECTORY_PREVIEW_METHOD, { op: "edit", edits: [editFrom(member)] }).then((body) => {
                if (disposed)
                    return;
                if (body?.ok === false) {
                    result.textContent = body.error ?? "That change was not accepted.";
                    return;
                }
                result.textContent = [body?.note ?? persistence, body?.changed ? (body.patch ?? "") : ""].filter((line) => line !== "").join("\n\n");
            }, () => {
                if (!disposed)
                    result.textContent = "The patch could not be checked.";
            });
        });
        const migrate = h("button", { type: "button" }, "Preview id migration");
        migrate.addEventListener("click", () => {
            result.textContent = "Checking ids…";
            void host.request(DIRECTORY_PREVIEW_METHOD, { op: "materialize" }).then((body) => {
                if (disposed)
                    return;
                if (body?.ok === false) {
                    result.textContent = body.error ?? "The migration was not accepted.";
                    return;
                }
                result.textContent = [body?.note ?? persistence, body?.changed ? (body.patch ?? "") : ""].filter((line) => line !== "").join("\n\n");
            }, () => {
                if (!disposed)
                    result.textContent = "The migration could not be checked.";
            });
        });
        paintList();
        paintForm();
        section.replaceChildren(h("h2", { class: "ocfp-people-title" }, "People"), h("p", { class: "ocfp-people-note" }, delivery), h("p", { class: "ocfp-people-note" }, persistence), h("p", { class: "ocfp-people-note" }, reservation), ...(demo ? [h("p", { class: "ocfp-people-note" }, "Demo mode shows the sample family. Turn demo off before previewing a roster patch.")] : []), list, form, h("div", { class: "ocfp-people-actions" }, preview, migrate), result);
    };
    load();
    let connected = host.connection.connected;
    let writable = host.connection.canWrite;
    const stop = host.subscribe(() => {
        if (connected === host.connection.connected && writable === host.connection.canWrite)
            return;
        connected = host.connection.connected;
        writable = host.connection.canWrite;
        load();
    });
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        stop();
    };
    initial.signal.addEventListener("abort", dispose, { once: true });
    return { dispose };
}
