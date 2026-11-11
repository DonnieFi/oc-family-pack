import { createHash } from "node:crypto";

/**
 * One household event has a durable fp-id. Provider identity (iCal UID and the
 * occurrence slot) decides a match before a conservative title window does.
 * An fp-id is never a Google event id. Callers filter to calendars the viewer
 * may see before calling in, and the projection names only those copies.
 */
export const MERGE_WINDOW_MS = 15 * 60_000;
export const FP_ID = /^fp_[0-9a-f]{32}$/;

/** The title form copies are matched on, and that schedule lookups match words in. */
export const normalTitle = (title: string) => title.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");

export type IdentityEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendarKey: string;
  google?: {
    eventId?: string;
    iCalUID?: string;
    recurringEventId?: string;
    originalStart?: string;
  };
};

export type IdentitySource = {
  calendarKey: string;
  eventId: string;
  fpId: string;
  iCalUid?: string;
  seriesId?: string;
  occurrence?: string;
};

export type IdentityOverride = {
  kind: "merge" | "split";
  sources: { calendarKey: string; eventId: string }[];
};

export type LegacyRef = { fpId: string; ref: string };

export type IdentityBook = {
  sources: IdentitySource[];
  overrides: IdentityOverride[];
  legacy: LegacyRef[];
};

export const EMPTY_BOOK: IdentityBook = { sources: [], overrides: [], legacy: [] };

export type IdentityPatch = {
  sources: IdentitySource[];
  legacy: LegacyRef[];
  dropLegacy: LegacyRef[];
  dirty: boolean;
};

export type IdentityGroup<E> = {
  fpId: string;
  copies: E[];
  /** Wire ids already used for this fp-id, including ones no longer in the read. */
  legacyIds: string[];
};

export type ReconcileResult<E> = {
  groups: IdentityGroup<E>[];
  patch: IdentityPatch;
};

export type IdentityMemory = {
  identityBook: () => Promise<IdentityBook>;
  rememberIdentity: (patch: IdentityPatch) => Promise<void>;
};

type Copy<E extends IdentityEvent> = {
  index: number;
  event: E;
  eventId: string;
  sourceKey: string;
  providerKey?: string;
  titleKey: string;
  startMs: number;
  iCalUid?: string;
  seriesId?: string;
  occurrence?: string;
};

const sourceKey = (calendarKey: string, eventId: string) => `${calendarKey}\u0000${eventId}`;
const pairKey = (a: string, b: string) => (a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`);

function clip(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 1024 ? trimmed.slice(0, 1024) : trimmed;
}

/** Google's event id for a copy. A Family Pack fp-id is not one. */
export function googleEventId(event: IdentityEvent): string {
  const fromGoogle = clip(event.google?.eventId);
  if (fromGoogle && !FP_ID.test(fromGoogle)) return fromGoogle;
  const prefix = `${event.calendarKey}/`;
  const bare = event.id.startsWith(prefix) ? event.id.slice(prefix.length) : event.id;
  return bare;
}

function providerKey(event: IdentityEvent): string | undefined {
  // iCal UID is the provider's shared identity. A recurring series id is local to
  // one calendar, so it distinguishes occurrences only together with that UID.
  // Without a UID, copies fall through to the title window.
  const uid = clip(event.google?.iCalUID);
  if (!uid) return undefined;
  const series = clip(event.google?.recurringEventId);
  const occurrence = clip(event.google?.originalStart);
  return series || occurrence ? `uid:${uid}|${occurrence ?? event.start}` : `uid:${uid}`;
}

function freshId(sources: readonly { calendarKey: string; eventId: string }[], used: ReadonlySet<string>): string {
  const body = sources.map((source) => `${source.calendarKey}/${source.eventId}`).sort().join("\n");
  let salt = "";
  for (;;) {
    const id = `fp_${createHash("sha256").update(body + salt).digest("hex").slice(0, 32)}`;
    if (!used.has(id)) return id;
    salt += "#";
  }
}

function sameSource(left: IdentitySource, right: IdentitySource): boolean {
  return left.fpId === right.fpId && left.iCalUid === right.iCalUid && left.seriesId === right.seriesId && left.occurrence === right.occurrence;
}

/**
 * Groups `events` into household events. `book` keeps fp-ids across a title or
 * time edit and applies manual merge and split. Sources absent from `events`
 * stay in the book and are not projected.
 */
export function reconcile<E extends IdentityEvent>(events: readonly E[], book: IdentityBook = EMPTY_BOOK): ReconcileResult<E> {
  const copies: Copy<E>[] = events.map((event, index) => {
    const eventId = googleEventId(event);
    const provider = providerKey(event);
    const iCalUid = clip(event.google?.iCalUID);
    const seriesId = clip(event.google?.recurringEventId);
    const occurrence = clip(event.google?.originalStart);
    return {
      index,
      event,
      eventId,
      sourceKey: sourceKey(event.calendarKey, eventId),
      titleKey: `${event.allDay ? "day" : "time"}:${normalTitle(event.title)}`,
      startMs: event.allDay ? Date.parse(`${event.start}T00:00:00Z`) : Date.parse(event.start),
      ...(provider ? { providerKey: provider } : {}),
      ...(iCalUid ? { iCalUid } : {}),
      ...(seriesId ? { seriesId } : {}),
      ...(occurrence ? { occurrence } : {}),
    };
  });
  const parent = copies.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const splitPairs = new Set<string>();
  for (const override of book.overrides) {
    if (override.kind !== "split") continue;
    for (let i = 0; i < override.sources.length; i += 1) {
      for (let j = i + 1; j < override.sources.length; j += 1) {
        const a = override.sources[i]!;
        const b = override.sources[j]!;
        splitPairs.add(pairKey(sourceKey(a.calendarKey, a.eventId), sourceKey(b.calendarKey, b.eventId)));
      }
    }
  }
  const blocks = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a === b) return false;
    const leftCopies = copies.filter((copy) => find(copy.index) === a);
    const rightCopies = copies.filter((copy) => find(copy.index) === b);
    return leftCopies.some((one) => rightCopies.some((other) => splitPairs.has(pairKey(one.sourceKey, other.sourceKey))));
  };
  const unionAll = (group: readonly Copy<E>[]) => {
    for (const copy of group) {
      for (const other of group) {
        if (copy.index === other.index || find(copy.index) === find(other.index) || blocks(copy.index, other.index)) continue;
        union(copy.index, other.index);
      }
    }
  };
  for (const override of book.overrides) {
    if (override.kind !== "merge") continue;
    const wanted = new Set(override.sources.map((source) => sourceKey(source.calendarKey, source.eventId)));
    unionAll(copies.filter((copy) => wanted.has(copy.sourceKey)));
  }
  const byProvider = new Map<string, Copy<E>[]>();
  for (const copy of copies) {
    if (!copy.providerKey) continue;
    const list = byProvider.get(copy.providerKey) ?? [];
    list.push(copy);
    byProvider.set(copy.providerKey, list);
  }
  for (const group of byProvider.values()) unionAll(group);
  const stored = new Map(book.sources.map((source) => [sourceKey(source.calendarKey, source.eventId), source]));
  const byStored = new Map<string, Copy<E>[]>();
  for (const copy of copies) {
    const previous = stored.get(copy.sourceKey);
    if (!previous) continue;
    const list = byStored.get(previous.fpId) ?? [];
    list.push(copy);
    byStored.set(previous.fpId, list);
  }
  for (const group of byStored.values()) unionAll(group);

  type Open = {
    anchor: number;
    earliestStart: number;
    latestStart: number;
    earliestDate: string;
    allDay: boolean;
    titleKey: string;
    calendarKeys: Set<string>;
  };
  const opens: Open[] = [];
  const timedOrder = (left: Copy<E>, right: Copy<E>) =>
    (Number.isFinite(left.startMs) ? left.startMs : Number.POSITIVE_INFINITY) - (Number.isFinite(right.startMs) ? right.startMs : Number.POSITIVE_INFINITY) ||
    left.event.calendarKey.localeCompare(right.event.calendarKey) ||
    left.event.id.localeCompare(right.event.id);
  for (const copy of [...copies].sort((a, b) => Number(Boolean(b.providerKey)) - Number(Boolean(a.providerKey)) || timedOrder(a, b))) {
    const root = find(copy.index);
    const existing = opens.find((open) => find(open.anchor) === root);
    if (existing) {
      existing.calendarKeys.add(copy.event.calendarKey);
      existing.earliestStart = Math.min(existing.earliestStart, copy.startMs);
      existing.latestStart = Math.max(existing.latestStart, copy.startMs);
      continue;
    }
    const within = (open: Open) => {
      if (copy.event.allDay !== open.allDay || open.titleKey !== copy.titleKey) return false;
      if (copy.event.allDay) return copy.event.start === open.earliestDate;
      if (!Number.isFinite(open.earliestStart) || !Number.isFinite(copy.startMs)) return false;
      return Math.max(copy.startMs, open.latestStart) - Math.min(copy.startMs, open.earliestStart) <= MERGE_WINDOW_MS;
    };
    // A copy that already has provider identity was matched above. Similarity
    // only attaches an imported copy that has none, and only to one candidate.
    const matches = copy.providerKey
      ? []
      : opens.filter((open) => within(open) && !open.calendarKeys.has(copy.event.calendarKey) && !blocks(open.anchor, copy.index));
    if (matches.length === 1) {
      const open = matches[0]!;
      union(open.anchor, copy.index);
      open.calendarKeys.add(copy.event.calendarKey);
      open.earliestStart = Math.min(open.earliestStart, copy.startMs);
      open.latestStart = Math.max(open.latestStart, copy.startMs);
      continue;
    }
    opens.push({
      anchor: copy.index,
      earliestStart: copy.startMs,
      latestStart: copy.startMs,
      earliestDate: copy.event.start,
      allDay: copy.event.allDay,
      titleKey: copy.titleKey,
      calendarKeys: new Set([copy.event.calendarKey]),
    });
  }

  const components = new Map<number, Copy<E>[]>();
  for (const copy of copies) {
    const root = find(copy.index);
    const list = components.get(root) ?? [];
    list.push(copy);
    components.set(root, list);
  }
  const ordered = [...components.values()].sort((left, right) => {
    const a = left.map((copy) => copy.sourceKey).sort()[0]!;
    const b = right.map((copy) => copy.sourceKey).sort()[0]!;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const used = new Set<string>();
  const fpOf = new Map<number, string>();
  for (const component of ordered) {
    const storedIds = [...new Set(component.flatMap((copy) => {
      const previous = stored.get(copy.sourceKey);
      return previous ? [previous.fpId] : [];
    }))].sort();
    const kept = storedIds.find((id) => FP_ID.test(id) && !used.has(id));
    const fpId = kept ?? freshId(component.map((copy) => ({ calendarKey: copy.event.calendarKey, eventId: copy.eventId })), used);
    used.add(fpId);
    fpOf.set(find(component[0]!.index), fpId);
  }

  const sources: IdentitySource[] = [];
  const legacy: LegacyRef[] = [];
  const dropLegacy: LegacyRef[] = [];
  const knownLegacy = new Set(book.legacy.map((ref) => `${ref.fpId}\u0000${ref.ref}`));
  for (const copy of copies) {
    const fpId = fpOf.get(find(copy.index))!;
    const next: IdentitySource = {
      calendarKey: copy.event.calendarKey,
      eventId: copy.eventId,
      fpId,
      ...(copy.iCalUid ? { iCalUid: copy.iCalUid } : {}),
      ...(copy.seriesId ? { seriesId: copy.seriesId } : {}),
      ...(copy.occurrence ? { occurrence: copy.occurrence } : {}),
    };
    const previous = stored.get(copy.sourceKey);
    if (!previous || !sameSource(previous, next)) sources.push(next);
    if (previous && previous.fpId !== fpId && knownLegacy.has(`${previous.fpId}\u0000${copy.event.id}`)) {
      dropLegacy.push({ fpId: previous.fpId, ref: copy.event.id });
    }
    if (!knownLegacy.has(`${fpId}\u0000${copy.event.id}`)) legacy.push({ fpId, ref: copy.event.id });
  }
  const byStart = (left: E, right: E) =>
    Date.parse(left.allDay ? `${left.start}T00:00:00Z` : left.start) - Date.parse(right.allDay ? `${right.start}T00:00:00Z` : right.start) ||
    left.calendarKey.localeCompare(right.calendarKey) ||
    left.id.localeCompare(right.id);
  const groups = [...components.values()]
    .map((component) => {
      const fpId = fpOf.get(find(component[0]!.index))!;
      const copiesInGroup = component.map((copy) => copy.event).sort(byStart);
      const legacyIds = [
        ...new Set([
          ...copiesInGroup.map((event) => event.id),
          ...book.legacy.filter((ref) => ref.fpId === fpId).map((ref) => ref.ref),
          ...legacy.filter((ref) => ref.fpId === fpId).map((ref) => ref.ref),
        ]),
      ].filter((ref) => !dropLegacy.some((dropped) => dropped.fpId === fpId && dropped.ref === ref));
      return { fpId, copies: copiesInGroup, legacyIds, at: copiesInGroup[0]! };
    })
    .sort((left, right) => copies.find((copy) => copy.event === left.at)!.index - copies.find((copy) => copy.event === right.at)!.index)
    .map(({ fpId, copies: grouped, legacyIds }) => ({ fpId, copies: grouped, legacyIds }));
  return { groups, patch: { sources, legacy, dropLegacy, dirty: sources.length + legacy.length + dropLegacy.length > 0 } };
}

/** The one Google event a write may touch. Never an fp-id, and never more than one source. */
export function resolveWriteSource(
  requested: { calendarKey: string; eventId: string },
  sources: readonly { calendarKey: string; eventId: string }[],
  authorized: ReadonlySet<string>,
): { calendarKey: string; eventId: string } | undefined {
  if (FP_ID.test(requested.eventId)) return undefined;
  const usable = sources.filter((source) => authorized.has(source.calendarKey) && !FP_ID.test(source.eventId));
  const exact = usable.find((source) => source.calendarKey === requested.calendarKey && source.eventId === requested.eventId);
  if (exact) return { calendarKey: exact.calendarKey, eventId: exact.eventId };
  const ranked = [...usable].sort((left, right) => left.calendarKey.localeCompare(right.calendarKey) || left.eventId.localeCompare(right.eventId));
  const chosen = ranked[0];
  return chosen ? { calendarKey: chosen.calendarKey, eventId: chosen.eventId } : undefined;
}

export function memoryOf(store: object | undefined): IdentityMemory | undefined {
  if (!store) return undefined;
  const candidate = store as Partial<IdentityMemory>;
  if (typeof candidate.identityBook !== "function" || typeof candidate.rememberIdentity !== "function") return undefined;
  return {
    identityBook: () => candidate.identityBook!(),
    rememberIdentity: (patch) => candidate.rememberIdentity!(patch),
  };
}

/** Reads the durable book when `memory` is open, groups the copies, and stores new bindings. */
export async function dedupEvents<E extends IdentityEvent>(events: readonly E[], memory: IdentityMemory | undefined): Promise<ReconcileResult<E>> {
  const book = memory ? await memory.identityBook() : EMPTY_BOOK;
  const result = reconcile(events, book);
  if (memory && result.patch.dirty) await memory.rememberIdentity(result.patch);
  return result;
}
