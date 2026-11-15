/** Gateway methods for the People page. The page bundle imports this file only. */
export const DIRECTORY_METHOD = "family.directory";
export const DIRECTORY_PREVIEW_METHOD = "family.directory.preview";
export const PEOPLE_PAGE_ID = "people";

/**
 * Saving writes the updated roster to `plugins.entries["oc-family-pack"].config.members`.
 * You can also preview a patch and apply it with `openclaw config patch --stdin --dry-run`, then again without `--dry-run`.
 */
export const DIRECTORY_PERSISTENCE =
  "Save changes writes the roster to the Gateway config. Preview patch does not write the Gateway config; apply it with `openclaw config patch --stdin --dry-run`, then again without `--dry-run`.";

export const DIRECTORY_SAVED_NOTE = "Saved roster changes to the Gateway config.";

export const DIRECTORY_MIGRATED_NOTE =
  "Saved member and device ids to the Gateway config. Calendar owners and reminder history keep those same ids.";

/** Discord is the only delivery path in this version. */
export const DELIVERY_NOTE =
  "This version sends reminders and briefs through Discord. Email and phone are stored on the contact card and are not delivery routes.";

/** A reservation is config. Nothing here talks to a router. */
export const RESERVATION_NOTE = "A reserved address is stored on the device. Saving it does not change the router.";
