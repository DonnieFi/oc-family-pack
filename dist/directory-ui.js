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
function selectField(label, value, options, onInput) {
    const select = document.createElement("select");
    select.setAttribute("aria-label", label);
    for (const option of options) {
        const node = document.createElement("option");
        node.value = option;
        node.textContent = option;
        node.selected = option === value;
        select.append(node);
    }
    select.addEventListener("change", () => onInput(select.value));
    return h("label", { class: "ocfp-field" }, h("span", {}, label), select);
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
        aliases: member.aliases ?? [],
        lobsterPreferences: member.lobsterPreferences ?? [],
        role: member.role,
        color: member.color ?? null,
        reminders: member.reminders,
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
const RESTRICTED = "Contact cards are for a parent. This sign-in can read the week, and it cannot see emails, phone numbers, Discord ids, or devices.";
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
            if (typeof body?.error === "string") {
                show(h("p", { class: "ocfp-people-note" }, body.error));
                return;
            }
            const members = Array.isArray(body?.members) ? body.members.map(memberDraft) : [];
            render(members, body?.persistence ?? DIRECTORY_PERSISTENCE, body?.delivery ?? DELIVERY_NOTE, body?.reservation ?? RESERVATION_NOTE, body?.demo === true);
        }, () => {
            if (!disposed)
                show(h("p", { class: "ocfp-people-note" }, "People didn't load."));
        });
    };
    const render = (members, persistence, delivery, reservation, demo) => {
        let selected = 0;
        let profileOpen = false;
        const edited = new Set();
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
            form.append(h("p", { class: "ocfp-person-id" }, `Id ${member.id}`), h("p", { class: "ocfp-people-note" }, "Login must match the name your proxy sends in X-Forwarded-User. A changed Discord id needs `users.linkChannelIdentity`. Role here is the plugin roster role; the Gateway role is set with `openclaw family access lan` and `users.setRole`."), field("Name", member.displayName, (value) => {
                member.displayName = value;
                edited.add(selected);
            }), field("Aliases", (member.aliases ?? []).join(", "), (value) => {
                const aliases = value.split(",").map((part) => part.trim().toLowerCase()).filter((part) => part !== "");
                if (aliases.length === 0)
                    delete member.aliases;
                else
                    member.aliases = aliases;
                edited.add(selected);
            }), selectField("Role", member.role, ["parent", "kid", "guest"], (value) => {
                member.role = value;
                edited.add(selected);
            }), field("Lobster preferences", (member.lobsterPreferences ?? []).join(", "), (value) => {
                member.lobsterPreferences = value.split(",").map((part) => part.trim()).filter(Boolean);
                edited.add(selected);
            }), field("Color", member.color ?? "", (value) => {
                if (value === "")
                    delete member.color;
                else
                    member.color = value;
                edited.add(selected);
            }), selectField("Reminders", member.reminders, ["dm", "channel", "off"], (value) => {
                member.reminders = value;
                edited.add(selected);
            }), field("Login", member.login ?? "", (value) => {
                if (value === "")
                    delete member.login;
                else
                    member.login = value;
                edited.add(selected);
            }), field("Email", member.email ?? "", (value) => {
                if (value === "")
                    delete member.email;
                else
                    member.email = value;
                edited.add(selected);
            }), field("Phone", member.phone ?? "", (value) => {
                if (value === "")
                    delete member.phone;
                else
                    member.phone = value;
                edited.add(selected);
            }), field("Discord id", member.discordId ?? "", (value) => {
                if (value === "")
                    delete member.discordId;
                else
                    member.discordId = value;
                edited.add(selected);
            }));
            const identity = h("section", { class: "ocfp-people-group" }, h("h3", {}, "Identity & role"));
            const signIn = h("section", { class: "ocfp-people-group" }, h("h3", {}, "Sign-in & linked accounts"), h("p", { class: "ocfp-people-note" }, "Changing your login also requires updating the proxy allowlist. Link Discord with users.linkChannelIdentity."));
            const contact = h("section", { class: "ocfp-people-group" }, h("h3", {}, "Contact card"), h("p", { class: "ocfp-people-note" }, delivery));
            for (const label of [...form.querySelectorAll("label.ocfp-field")]) {
                const key = label.querySelector("input, select")?.getAttribute("aria-label");
                (key === "Email" || key === "Phone" ? contact : key === "Login" || key === "Discord id" || key === "Reminders" ? signIn : identity).append(label);
            }
            form.append(identity, signIn, contact, h("h3", { class: "ocfp-people-devices-title" }, "Network devices"), h("p", { class: "ocfp-people-note ocfp-people-wide" }, reservation));
            for (const device of member.devices) {
                const touch = () => edited.add(selected);
                form.append(h("fieldset", { class: "ocfp-device" }, h("legend", {}, device.label || "Device"), field("Device label", device.label, (value) => {
                    device.label = value;
                    touch();
                }), field("Hostname", device.hostname ?? "", (value) => {
                    if (value === "")
                        delete device.hostname;
                    else
                        device.hostname = value;
                    touch();
                }), field("MAC", device.primaryMac, (value) => {
                    device.primaryMac = value;
                    touch();
                }), field("Reserved IP", device.reservation?.address ?? "", (value) => {
                    touch();
                    if (value === "") {
                        delete device.reservation;
                        return;
                    }
                    device.reservation = { address: value, source: device.reservation?.source ?? "operator", ...(device.reservation?.network !== undefined ? { network: device.reservation.network } : {}) };
                }), field("Shared with", device.sharedWith.join(", "), (value) => {
                    device.sharedWith = value.split(",").map((part) => part.trim().toLowerCase()).filter((part) => part !== "");
                    touch();
                })));
            }
        };
        const paintList = () => {
            list.replaceChildren(...members.map((member, index) => {
                const button = h("button", { type: "button", class: "ocfp-person", "aria-label": `Open ${member.displayName}'s profile` }, h("span", { class: "ocfp-people-avatar", "aria-hidden": "true" }, member.displayName.slice(0, 1).toUpperCase()), h("strong", {}, member.displayName), h("span", { class: "ocfp-people-role" }, member.role), h("span", { class: "ocfp-people-note" }, (member.aliases ?? []).join(", ") || "No aliases"), h("span", { class: "ocfp-people-status" }, member.login ? "Sign-in ready" : "Sign-in needed", " · ", member.discordId ? "Discord linked" : "No Discord", ` · ${member.devices.length} devices`), ...(edited.has(index) ? [h("span", { class: "ocfp-people-dirty" }, "Edited")] : []));
                if (member.color)
                    button.style.setProperty("--ocfp-person-color", member.color);
                button.addEventListener("click", () => {
                    selected = index;
                    profileOpen = true;
                    paintForm();
                    syncView();
                    back.focus();
                });
                return button;
            }));
        };
        const back = h("button", { type: "button", class: "ocfp-btn ocfp-people-back" }, "← Everyone");
        back.addEventListener("click", () => { profileOpen = false; paintList(); syncView(); list.querySelector("button")?.focus(); });
        const profileTitle = h("h2", { class: "ocfp-people-title" });
        const actions = h("div", { class: "ocfp-people-actions" });
        const syncView = () => {
            list.hidden = profileOpen;
            form.hidden = !profileOpen;
            back.hidden = !profileOpen;
            profileTitle.hidden = !profileOpen;
            actions.hidden = !profileOpen;
            if (profileOpen)
                profileTitle.textContent = `${members[selected]?.displayName ?? ""}’s profile`;
        };
        const preview = h("button", { type: "button" }, "Preview patch");
        preview.addEventListener("click", () => {
            const targets = edited.size > 0 ? [...edited] : [selected];
            const edits = targets.flatMap((index) => {
                const member = members[index];
                return member === undefined ? [] : [editFrom(member)];
            });
            if (edits.length === 0)
                return;
            result.textContent = `Checking ${edits.length} ${edits.length === 1 ? "card" : "cards"}…`;
            void host.request(DIRECTORY_PREVIEW_METHOD, { op: "edit", edits }).then((body) => {
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
        actions.append(preview, migrate);
        syncView();
        section.replaceChildren(h("div", { class: "ocfp-masthead" }, h("div", {}, h("p", { class: "ocfp-kicker" }, "Family · a place for everyone"), h("h2", { class: "ocfp-title" }, "People"), h("p", { class: "ocfp-subtitle" }, "All your people, together in one place."))), h("p", { class: "ocfp-people-note" }, delivery), h("p", { class: "ocfp-people-note" }, persistence), h("p", { class: "ocfp-people-note" }, reservation), ...(demo ? [h("p", { class: "ocfp-people-note" }, "Demo mode shows the sample family. Turn demo off before previewing a roster patch.")] : []), list, back, profileTitle, form, actions, result);
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
