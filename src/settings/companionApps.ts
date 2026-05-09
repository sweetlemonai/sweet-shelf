/**
 * Registry of Sweet Lemon companion extensions surfaced in Sweet
 * Shelf's custom Settings page.
 *
 * Adding a new companion is a one-line append to `COMPANION_APPS`.
 * The webview reads this array via `state.ts`, renders one card per
 * entry, and tracks installed status by querying the active
 * extension set.
 *
 * Field semantics:
 *   - `extensionId`: marketplace id, e.g. `sweetlemonai.sweet-markdown`.
 *     Used both to query install status and to drive the Install
 *     button (`workbench.extensions.installExtension`).
 *   - `displayName`: card title.
 *   - `description`: one-line subtitle.
 *   - `iconPath`: relative to the extension's `media/` directory.
 *     Optional; the webview falls back to a generic glyph if the
 *     resource is missing.
 *   - `openCommand`: command to invoke when the user clicks Open on
 *     an installed app. If the command isn't registered (e.g. older
 *     version of the companion), the panel falls back to opening
 *     the marketplace listing.
 */

export interface CompanionApp {
  extensionId: string;
  displayName: string;
  description: string;
  iconPath?: string;
  openCommand?: string;
  /**
   * Lifecycle of the companion. `"published"` (the default when
   * omitted) means the marketplace listing is live and the panel
   * renders Install / Installed+Open buttons. `"coming-soon"` hides
   * the action buttons and shows a muted "Coming soon" pill — the
   * card still advertises the app without offering a button that
   * would 404 on click.
   */
  status?: "published" | "coming-soon";
}

export const COMPANION_APPS: readonly CompanionApp[] = [
  {
    extensionId: "sweet-lemon.sweet-markdown",
    displayName: "Sweet Markdown",
    description: "Better preview and editing for markdown files.",
    iconPath: "companion-apps/sweet-markdown.png",
    openCommand: "sweetMarkdown.openPreview",
    status: "coming-soon",
  },
  {
    // Published under the `purple-vision` publisher; surfaced here as
    // a Sweet Lemon companion by editorial choice. The "More from
    // Sweet Lemon" link points at the `sweet-lemon` publisher page,
    // so Braindump won't appear there — that's fine; the card here
    // is the discovery surface.
    extensionId: "purple-vision.braindump",
    displayName: "Braindump",
    description: "Frictionless syntax for stream-of-consciousness notes.",
    iconPath: "companion-apps/braindump.png",
    openCommand: "braindump.start",
    status: "coming-soon",
  },
];

/** Marketplace publisher page — opened from the "More from Sweet Lemon" link. */
export const SWEET_LEMON_PUBLISHER_URL =
  "https://marketplace.visualstudio.com/publishers/sweet-lemon";
