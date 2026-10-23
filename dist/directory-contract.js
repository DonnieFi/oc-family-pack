/** Gateway methods for the People page. The page bundle imports this file only. */
export const DIRECTORY_METHOD = "family.directory";
export const DIRECTORY_PREVIEW_METHOD = "family.directory.preview";
export const PEOPLE_PAGE_ID = "people";
/**
 * The host has no plugin-page API that writes `plugins.entries` config.
 * `openclaw/plugin-sdk/config-mutation` rewrites the whole host file and is a
 * CLI helper, so the page previews a patch instead of keeping a second roster.
 */
export const DIRECTORY_PERSISTENCE = "This preview does not write the Gateway config, and Family Pack does not keep a second roster. Apply it with `openclaw config patch --stdin --dry-run`, then again without `--dry-run`.";
/** Discord is the only delivery path in this version. */
export const DELIVERY_NOTE = "This version sends reminders and briefs through Discord. Email and phone are stored on the contact card and are not delivery routes.";
/** A reservation is config. Nothing here talks to a router. */
export const RESERVATION_NOTE = "A reserved address is stored on the device. Saving it does not change the router.";
