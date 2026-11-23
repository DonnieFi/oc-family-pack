// Gateway methods for the People page. operator.write is set by the registrar,
// so a kid never receives contact details. Preview does not write; save writes
// the validated members list to the Gateway config.

import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { ErrorCodes, errorShape, type GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { DELIVERY_NOTE, DIRECTORY_MIGRATED_NOTE, DIRECTORY_PERSISTENCE, DIRECTORY_SAVED_NOTE, RESERVATION_NOTE } from "./directory-contract.ts";
import { directoryMembers, planDirectoryEdit, planMaterialize, MATERIALIZE_INTRO, type DirectoryEdit } from "./directory.ts";
import { DEMO_MEMBERS } from "./demo.ts";
import { parseConfig } from "./config.ts";
import type { Config } from "./types.ts";
import { isRosterParent } from "./visibility.ts";
import { viewerOf } from "./week-method.ts";

type Respond = Pick<GatewayRequestHandlerOptions, "params" | "respond"> &
  Partial<Pick<GatewayRequestHandlerOptions, "client" | "hasCurrentClientAuthority">>;
export type PersistRosterFn = (edits: readonly DirectoryEdit[] | "materialize", check?: (members: unknown[]) => void) => Promise<
  { ok: true; changed: boolean; members: unknown[]; patch: string } | { ok: false; error: string }
>;
export type DirectoryPreviewDeps = {
  persist?: PersistRosterFn;
  onSaved?: (members: unknown[]) => void;
  loadProfiles?: () => Promise<unknown>;
};

async function loadNativeProfiles(): Promise<unknown> {
  const response = await dispatchGatewayMethod("users.list", {});
  if (!response.ok) return undefined;
  return isRecord(response.payload) ? response.payload.profiles : undefined;
}

const PARENT_ONLY = "People is for a parent. This sign-in can read the week, and it cannot see emails, phone numbers, Discord ids, or devices.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawRoster(raw: unknown): { members: unknown[]; calendars: unknown[] } {
  const config = isRecord(raw) ? raw : {};
  return {
    members: Array.isArray(config.members) ? config.members : [],
    calendars: Array.isArray(config.calendars) ? config.calendars : [],
  };
}

const EDIT_KEYS = ["id", "create", "displayName", "login", "gatewayProfileId", "email", "phone", "discordId", "aliases", "lobsterPreferences", "role", "color", "reminders", "devices"] as const;

function parseEdits(value: unknown): DirectoryEdit[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const edits: DirectoryEdit[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim() === "") return undefined;
    for (const key of Object.keys(entry)) {
      if (!EDIT_KEYS.includes(key as (typeof EDIT_KEYS)[number])) return undefined;
    }
    const edit: DirectoryEdit = { id: entry.id };
    if ("create" in entry) {
      if (entry.create !== true) return undefined;
      edit.create = true;
    }
    if ("displayName" in entry) {
      if (typeof entry.displayName !== "string" || entry.displayName.trim() === "") return undefined;
      edit.displayName = entry.displayName;
    }
    for (const key of ["login", "gatewayProfileId", "email", "phone", "discordId", "role", "color", "reminders"] as const) {
      if (!(key in entry)) continue;
      const field = entry[key];
      if (field !== null && typeof field !== "string") return undefined;
      (edit as unknown as Record<string, unknown>)[key] = field;
    }
    if ("lobsterPreferences" in entry) {
      if (!Array.isArray(entry.lobsterPreferences) || entry.lobsterPreferences.some((item) => typeof item !== "string")) return undefined;
      edit.lobsterPreferences = entry.lobsterPreferences;
    }
    if ("aliases" in entry) {
      if (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => typeof alias !== "string")) return undefined;
      edit.aliases = entry.aliases;
    }
    if ("devices" in entry) {
      if (!Array.isArray(entry.devices)) return undefined;
      edit.devices = entry.devices;
    }
    edits.push(edit);
  }
  return edits;
}

export const defaultPersistRoster: PersistRosterFn = async (operation, check) => {
  try {
    let outcome: { ok: true; changed: boolean; members: unknown[]; patch: string } | { ok: false; error: string } | undefined;
    await mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const root = draft as unknown as Record<string, unknown>;
        const plugins = isRecord(root.plugins) ? { ...root.plugins } : {};
        const entries = isRecord(plugins.entries) ? { ...plugins.entries } : {};
        const entry = isRecord(entries["oc-family-pack"]) ? { ...entries["oc-family-pack"] } : {};
        const pluginConfig = isRecord(entry.config) ? { ...entry.config } : {};
        const currentRoster = rawRoster(pluginConfig);
        const planned =
          operation === "materialize"
            ? planMaterialize(currentRoster.members, currentRoster.calendars)
            : planDirectoryEdit(currentRoster.members, operation, currentRoster.calendars);
        outcome = planned;
        if (!planned.ok) {
          throw new Error(planned.error);
        }
        if (planned.changed) {
          check?.(planned.members);
          pluginConfig.members = planned.members;
          entry.config = pluginConfig;
          entries["oc-family-pack"] = entry;
          plugins.entries = entries;
          root.plugins = plugins;
        }
      },
    });
    return outcome ?? { ok: false, error: "The roster could not be saved." };
  } catch (error) {
    if (error instanceof Error && error.message) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: "The roster could not be saved." };
  }
};

/** The roster a parent may view. Demo mode shows the sample family and no private network data beyond that sample. */
export function directoryMethod(config: () => Config, _raw: () => unknown) {
  return async ({ client, respond }: Pick<Respond, "respond"> & Partial<Pick<Respond, "client">>): Promise<void> => {
    const current = config();
    if (!isRosterParent(current, viewerOf(client, current.accessMode))) {
      respond(true, { error: PARENT_ONLY });
      return;
    }
    respond(true, {
      demo: current.demo,
      persistence: DIRECTORY_PERSISTENCE,
      delivery: DELIVERY_NOTE,
      reservation: RESERVATION_NOTE,
      members: directoryMembers(current.demo ? DEMO_MEMBERS : current.members),
    });
  };
}

/** Validate an edit or an id migration, returning a config patch or saving when save: true is requested. */
export function directoryPreviewMethod(config: () => Config, raw: () => unknown, deps: DirectoryPreviewDeps = {}) {
  const persist = deps.persist ?? defaultPersistRoster;
  return async ({ params, client, respond, hasCurrentClientAuthority }: Respond): Promise<void> => {
    const current = config();
    if (!isRosterParent(current, viewerOf(client, current.accessMode))) {
      respond(true, { ok: false, error: PARENT_ONLY });
      return;
    }
    if (current.demo) {
      respond(true, { ok: false, error: "Demo mode shows the sample family. Turn demo off before previewing a roster patch." });
      return;
    }
    const body = isRecord(params) ? params : null;
    if (
      body === null ||
      (body.op !== "materialize" && body.op !== "edit") ||
      ("save" in body && typeof body.save !== "boolean")
    ) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "family.directory.preview takes op materialize or edit"));
      return;
    }
    const save = body.save === true;
    const roster = rawRoster(raw());
    if (body.op === "materialize") {
      const preview = planMaterialize(roster.members, roster.calendars);
      if (!preview.ok) {
        respond(true, { ok: false, error: preview.error });
        return;
      }
      if (!save) {
        respond(true, {
          ok: true,
          changed: preview.changed,
          patch: preview.patch,
          note: preview.changed ? `${MATERIALIZE_INTRO} ${DIRECTORY_PERSISTENCE}` : "Every member and device already has an id. No changes to make.",
        });
        return;
      }
      if (!preview.changed) {
        respond(true, {
          ok: true,
          saved: false,
          changed: false,
          patch: "",
          members: directoryMembers(current.members),
          note: "Every member and device already has an id. No changes to make.",
        });
        return;
      }
      const saved = await persist("materialize");
      if (!saved.ok) {
        respond(true, { ok: false, error: saved.error });
        return;
      }
      deps.onSaved?.(saved.members);
      const updated = parseConfig({ ...(isRecord(raw()) ? raw() as Record<string, unknown> : {}), members: saved.members }).members;
      respond(true, {
        ok: true,
        saved: saved.changed,
        changed: saved.changed,
        patch: saved.patch,
        members: directoryMembers(updated),
        note: saved.changed ? DIRECTORY_MIGRATED_NOTE : "Every member and device already has an id. No changes to make.",
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
    let check: ((members: unknown[]) => void) | undefined;
    const newLinks = edits.flatMap((edit) => typeof edit.gatewayProfileId === "string" ? [edit.gatewayProfileId.trim()] : []);
    if (newLinks.length > 0) {
      const profiles = await (deps.loadProfiles ?? loadNativeProfiles)().catch(() => undefined);
      const candidates = Array.isArray(profiles)
        ? profiles.filter((profile): profile is Record<string, unknown> =>
          isRecord(profile) && profile.id !== "gateway-owner" && !profile.mergedInto)
        : [];
      if (!newLinks.every((id) => candidates.some((profile) => profile.id === id))) {
        respond(true, { ok: false, error: "The selected OpenClaw profile is unavailable. Refresh the profile list and choose again." });
        return;
      }
      const selected = candidates.filter((candidate) => newLinks.includes(String(candidate.id)));
      check = (members) => {
        if (hasCurrentClientAuthority && !hasCurrentClientAuthority()) {
          throw new Error("Gateway access changed. Sign in again and retry.");
        }
        const plannedMembers = parseConfig({ members }).members;
        for (const profile of selected) {
          // A mutable display name can flag ambiguity, but cannot establish identity.
          const names = [profile.displayName, ...(Array.isArray(profile.emails) ? profile.emails : [])]
            .flatMap((name) => typeof name === "string" ? [name.trim().toLowerCase()] : []);
          if (plannedMembers.some((member) => member.profileId && names.includes(member.profileId) && member.gatewayProfileId !== profile.id)) {
            throw new Error("The selected OpenClaw profile may already belong to another roster login. Check those cards before linking it.");
          }
        }
      };
      try {
        check(preview.members);
      } catch (error) {
        respond(true, { ok: false, error: error instanceof Error ? error.message : "The profile could not be linked." });
        return;
      }
    }
    if (!save) {
      respond(true, {
        ok: true,
        changed: preview.changed,
        patch: preview.patch,
        note: preview.changed ? DIRECTORY_PERSISTENCE : "No changes to make.",
      });
      return;
    }
    if (!preview.changed) {
      respond(true, {
        ok: true,
        saved: false,
        changed: false,
        patch: "",
        members: directoryMembers(current.members),
        note: "No changes to make.",
      });
      return;
    }
    const saved = await persist(edits, check);
    if (!saved.ok) {
      respond(true, { ok: false, error: saved.error });
      return;
    }
    deps.onSaved?.(saved.members);
    const updated = parseConfig({ ...(isRecord(raw()) ? raw() as Record<string, unknown> : {}), members: saved.members }).members;
    respond(true, {
      ok: true,
      saved: saved.changed,
      changed: saved.changed,
      patch: saved.patch,
      members: directoryMembers(updated),
      note: saved.changed ? DIRECTORY_SAVED_NOTE : "No changes to make.",
    });
  };
}
