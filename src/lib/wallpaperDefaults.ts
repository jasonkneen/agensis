// ---------------------------------------------------------------------------
// The wallpaper's default opacity, in ONE place.
//
// This was the literal 0.42 repeated at twenty sites — four in the browser,
// several column defaults, and the applied migrations. A default spread that
// thinly cannot be changed with any confidence: miss one and a workspace
// created down that path looks different from every other one, with nothing to
// point at.
//
// 0.42 was also the wrong value. A wallpaper at 42% is neither a wallpaper nor
// a clean surface — it reads as a raised translucent pane floating over the app
// background, which is exactly how the owner described it before asking what it
// was. 0.7 lets the image be the surface while still taking theme colour from
// what is behind it.
//
// The slider (Settings) still writes anything from 0 to 1; this is only where a
// workspace or desktop STARTS. Applied migrations are deliberately not edited —
// they record what already ran — so a new migration moves the column default
// and the rows that never chose for themselves.
// ---------------------------------------------------------------------------

/** Starting wallpaper opacity for a new workspace or desktop. */
export const DEFAULT_BACKGROUND_OPACITY = 0.7;

/**
 * The value that means "nobody ever chose". Rows created before the default
 * moved hold this exactly, which is what makes them safe to migrate; a value
 * the owner picked by hand is almost never exactly this.
 */
export const LEGACY_DEFAULT_BACKGROUND_OPACITY = 0.42;
