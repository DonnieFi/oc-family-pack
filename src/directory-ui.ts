// People page: a view and a patch preview of the one roster. It does not write config.

import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { DELIVERY_NOTE, DIRECTORY_METHOD, DIRECTORY_PREVIEW_METHOD, DIRECTORY_PERSISTENCE, RESERVATION_NOTE } from "./directory-contract.ts";
import type { DirectoryDevice, DirectoryMember } from "./directory.ts";

type Child = Node | string | null | undefined | false;

function h(tag: string, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== false) node.setAttribute(name, value === true ? "" : value);
  }
  node.append(...children.filter((child): child is Node | string => child !== null && child !== undefined && child !== false));
  return node;
}

function field(label: string, value: string, onInput: (value: string) => void): HTMLLabelElement {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => onInput(input.value));
  return h("label", { class: "ocfp-field" }, h("span", {}, label), input) as HTMLLabelElement;
}

function selectField(label: string, value: string, options: readonly string[], onInput: (value: string) => void): HTMLLabelElement {
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
  return h("label", { class: "ocfp-field" }, h("span", {}, label), select) as HTMLLabelElement;
}

type DirectoryResponse = {
  demo?: boolean;
  persistence?: string;
  delivery?: string;
  reservation?: string;
  members?: DirectoryMember[];
  error?: string;
};

type PreviewResponse = { ok?: boolean; changed?: boolean; patch?: string; note?: string; error?: string };

function deviceDraft(device: DirectoryDevice): DirectoryDevice {
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

function memberDraft(member: DirectoryMember): DirectoryMember {
  return { ...member, devices: member.devices.map(deviceDraft) };
}

/** The edit the preview method applies. Devices are sent in full so a field change does not drop a MAC. */
export function editFrom(member: DirectoryMember): Record<string, unknown> {
  return {
    id: member.id,
    displayName: member.displayName,
    login: member.login ?? null,
    aliases: member.aliases ?? [],
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
export function mountPeoplePage(container: HTMLElement, initial: ControlUiViewContext) {
  const host: ControlUiHost = initial.host;
  const root = h("div", { class: "oc-family-pack" }, h("section", { class: "ocfp-people ocfp-panel", "aria-label": "People" }));
  const section = root.querySelector("section");
  if (section === null) return;
  container.append(root);
  let disposed = false;
  const show = (node: HTMLElement) => {
    section.replaceChildren(node);
  };
  const load = () => {
    if (disposed) return;
    if (!host.connection.connected) {
      show(h("p", { class: "ocfp-people-note" }, "The Gateway is not connected."));
      return;
    }
    if (!host.connection.canWrite) {
      show(h("p", { class: "ocfp-people-note" }, RESTRICTED));
      return;
    }
    show(h("p", { class: "ocfp-people-note" }, "Loading people…"));
    void host.request<DirectoryResponse>(DIRECTORY_METHOD, {}).then(
      (body) => {
        if (disposed) return;
        if (typeof body?.error === "string") {
          show(h("p", { class: "ocfp-people-note" }, body.error));
          return;
        }
        const members = Array.isArray(body?.members) ? body.members.map(memberDraft) : [];
        render(members, body?.persistence ?? DIRECTORY_PERSISTENCE, body?.delivery ?? DELIVERY_NOTE, body?.reservation ?? RESERVATION_NOTE, body?.demo === true);
      },
      () => {
        if (!disposed) show(h("p", { class: "ocfp-people-note" }, "People didn't load."));
      },
    );
  };
  const render = (members: DirectoryMember[], persistence: string, delivery: string, reservation: string, demo: boolean) => {
    let selected = 0;
    const edited = new Set<number>();
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
      form.append(
        h("p", { class: "ocfp-person-id" }, `Id ${member.id}`),
        h(
          "p",
          { class: "ocfp-people-note" },
          "Login must match the name your proxy sends in X-Forwarded-User. A changed Discord id needs `users.linkChannelIdentity`. Role here is the plugin roster role; the Gateway role is set with `openclaw family access lan` and `users.setRole`.",
        ),
        field("Name", member.displayName, (value) => {
          member.displayName = value;
          edited.add(selected);
        }),
        field("Aliases", (member.aliases ?? []).join(", "), (value) => {
          const aliases = value.split(",").map((part) => part.trim().toLowerCase()).filter((part) => part !== "");
          if (aliases.length === 0) delete member.aliases;
          else member.aliases = aliases;
          edited.add(selected);
        }),
        selectField("Role", member.role, ["parent", "kid", "guest"], (value) => {
          member.role = value as DirectoryMember["role"];
          edited.add(selected);
        }),
        field("Color", member.color ?? "", (value) => {
          if (value === "") delete member.color;
          else member.color = value;
          edited.add(selected);
        }),
        selectField("Reminders", member.reminders, ["dm", "channel", "off"], (value) => {
          member.reminders = value as DirectoryMember["reminders"];
          edited.add(selected);
        }),
        field("Login", member.login ?? "", (value) => {
          if (value === "") delete member.login;
          else member.login = value;
          edited.add(selected);
        }),
        field("Email", member.email ?? "", (value) => {
          if (value === "") delete member.email;
          else member.email = value;
          edited.add(selected);
        }),
        field("Phone", member.phone ?? "", (value) => {
          if (value === "") delete member.phone;
          else member.phone = value;
          edited.add(selected);
        }),
        field("Discord id", member.discordId ?? "", (value) => {
          if (value === "") delete member.discordId;
          else member.discordId = value;
          edited.add(selected);
        }),
      );
      for (const device of member.devices) {
        const touch = () => edited.add(selected);
        form.append(
          h("fieldset", { class: "ocfp-device" },
            h("legend", {}, device.label || "Device"),
            field("Device label", device.label, (value) => {
              device.label = value;
              touch();
            }),
            field("Hostname", device.hostname ?? "", (value) => {
              if (value === "") delete device.hostname;
              else device.hostname = value;
              touch();
            }),
            field("MAC", device.primaryMac, (value) => {
              device.primaryMac = value;
              touch();
            }),
            field("Reserved IP", device.reservation?.address ?? "", (value) => {
              touch();
              if (value === "") {
                delete device.reservation;
                return;
              }
              device.reservation = { address: value, source: device.reservation?.source ?? "operator", ...(device.reservation?.network !== undefined ? { network: device.reservation.network } : {}) };
            }),
            field("Shared with", device.sharedWith.join(", "), (value) => {
              device.sharedWith = value.split(",").map((part) => part.trim().toLowerCase()).filter((part) => part !== "");
              touch();
            }),
          ),
        );
      }
    };
    const paintList = () => {
      list.replaceChildren(
        ...members.map((member, index) => {
          const button = h("button", { type: "button", class: index === selected ? "ocfp-person is-selected" : "ocfp-person", "aria-pressed": index === selected ? "true" : "false" }, member.displayName);
          button.addEventListener("click", () => {
            selected = index;
            paintList();
            paintForm();
          });
          return button;
        }),
      );
    };
    const preview = h("button", { type: "button" }, "Preview patch");
    preview.addEventListener("click", () => {
      const targets = edited.size > 0 ? [...edited] : [selected];
      const edits = targets.flatMap((index) => {
        const member = members[index];
        return member === undefined ? [] : [editFrom(member)];
      });
      if (edits.length === 0) return;
      result.textContent = `Checking ${edits.length} ${edits.length === 1 ? "card" : "cards"}…`;
      void host.request<PreviewResponse>(DIRECTORY_PREVIEW_METHOD, { op: "edit", edits }).then(
        (body) => {
          if (disposed) return;
          if (body?.ok === false) {
            result.textContent = body.error ?? "That change was not accepted.";
            return;
          }
          result.textContent = [body?.note ?? persistence, body?.changed ? (body.patch ?? "") : ""].filter((line) => line !== "").join("\n\n");
        },
        () => {
          if (!disposed) result.textContent = "The patch could not be checked.";
        },
      );
    });
    const migrate = h("button", { type: "button" }, "Preview id migration");
    migrate.addEventListener("click", () => {
      result.textContent = "Checking ids…";
      void host.request<PreviewResponse>(DIRECTORY_PREVIEW_METHOD, { op: "materialize" }).then(
        (body) => {
          if (disposed) return;
          if (body?.ok === false) {
            result.textContent = body.error ?? "The migration was not accepted.";
            return;
          }
          result.textContent = [body?.note ?? persistence, body?.changed ? (body.patch ?? "") : ""].filter((line) => line !== "").join("\n\n");
        },
        () => {
          if (!disposed) result.textContent = "The migration could not be checked.";
        },
      );
    });
    paintList();
    paintForm();
    section.replaceChildren(
      h("h2", { class: "ocfp-people-title" }, "People"),
      h("p", { class: "ocfp-people-note" }, delivery),
      h("p", { class: "ocfp-people-note" }, persistence),
      h("p", { class: "ocfp-people-note" }, reservation),
      ...(demo ? [h("p", { class: "ocfp-people-note" }, "Demo mode shows the sample family. Turn demo off before previewing a roster patch.")] : []),
      list,
      form,
      h("div", { class: "ocfp-people-actions" }, preview, migrate),
      result,
    );
  };
  load();
  let connected = host.connection.connected;
  let writable = host.connection.canWrite;
  const stop = host.subscribe(() => {
    if (connected === host.connection.connected && writable === host.connection.canWrite) return;
    connected = host.connection.connected;
    writable = host.connection.canWrite;
    load();
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop();
  };
  initial.signal.addEventListener("abort", dispose, { once: true });
  return { dispose };
}
