import { reconcile, type IdentityBook, normalTitle } from "./identity.ts";
import type { FamilyEvent } from "./types.ts";

export { normalTitle };

/**
 * Copies of one household event. Provider identity matches first. A title and
 * a 15-minute window match only an imported copy that has no provider identity,
 * across calendars, and only when one candidate fits. Two appointments on one
 * calendar stay apart. Pass `book` to keep fp-ids and manual merge or split.
 */
export function groupCopies<E extends FamilyEvent>(events: readonly E[], book?: IdentityBook): E[][] {
  return reconcile(events, book).groups.map((group) => group.copies);
}

/**
 * One event for a group of copies. The earliest copy supplies id, title, times
 * and `calendarKey`; `calendarKeys` lists every source calendar in the group
 * and is set only when there are two or more. The id is that copy's wire id,
 * never an fp-id.
 */
export function mergeGroup<E extends FamilyEvent>([first, ...rest]: readonly E[]): E {
  const merged: E = { ...first! };
  if (rest.length === 0) {
    return merged;
  }
  const copies = [first!, ...rest];
  const location = copies.find((copy) => copy.location !== undefined)?.location;
  const htmlLink = copies.find((copy) => copy.htmlLink !== undefined)?.htmlLink;
  if (location !== undefined) merged.location = location;
  if (htmlLink !== undefined) merged.htmlLink = htmlLink;
  const calendarKeys = [...new Set(copies.map((copy) => copy.calendarKey))];
  if (calendarKeys.length > 1) merged.calendarKeys = calendarKeys;
  return merged;
}

/** The same event read from several calendars becomes one event, as `groupCopies` and `mergeGroup` describe. */
export function mergeCopies<E extends FamilyEvent>(events: readonly E[], book?: IdentityBook): E[] {
  return groupCopies(events, book).map(mergeGroup);
}
