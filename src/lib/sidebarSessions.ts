/**
 * How the sidebar splits a workspace's sessions into its three sections.
 *
 * **Channels, DMs and threads belong to the WORKSPACE, not to a desktop.** A
 * desktop is a window/wallpaper configuration inside one workspace; it owns no
 * content. So this function takes no desktop id — there is nothing for one to
 * change here, and that is the point.
 *
 * It used to take one. `chat_sessions.canvas_id` was described in the sidebar
 * as the session's "project", and the list hid any session whose canvas_id was
 * not the open desktop's. That inverted the model: a workspace is the project,
 * a desktop is only a view of it. The visible effect was that switching desktop
 * silently removed channels from the sidebar, which is indistinguishable from
 * having lost them — an account hit exactly that.
 *
 * The column is still written and still stored (it records which desktop a
 * channel was created on, and keeping it means this is reversible). Nothing
 * reads it to decide visibility. Window placement is a different question and
 * is legitimately desktop-scoped — see `useWindows`.
 *
 * The two predicates are injected because they live in the sidebar with the
 * session-shape sniffing they need; this module is only the partition.
 */

export interface SidebarSessionPredicates<T> {
  isDirect: (session: T) => boolean;
  isThread: (session: T) => boolean;
  /** Sessions that exist but should never appear in the sidebar. */
  exclude?: (session: T) => boolean;
}

export interface SidebarSessionGroups<T> {
  /** Everything that is neither a DM nor a thread. */
  channels: T[];
  direct: T[];
  threads: T[];
}

/**
 * Splits the workspace's non-archived sessions into channels, DMs and threads.
 * A session is tested for DM first — a thread-shaped DM is still a DM — so the
 * three groups are disjoint and together cover every non-archived session.
 */
export function partitionSidebarSessions<T extends { archived_at?: string | null }>(
  sessions: readonly T[],
  { isDirect, isThread, exclude }: SidebarSessionPredicates<T>,
): SidebarSessionGroups<T> {
  const channels: T[] = [];
  const direct: T[] = [];
  const threads: T[] = [];

  for (const session of sessions) {
    if (session.archived_at) continue;
    // `exclude` is for sessions that exist but are not places you NAVIGATE to.
    // A huddle transcript is the case: it is reached from the live huddle card
    // or the "You were in a huddle" marker in the channel that held it. Left
    // in, it would land in the CHANNEL bucket (no parent_message_id, no
    // agent-only participant list) and list every call anyone ever started
    // beside the real channels — the exact clutter that moving the huddle
    // conversation out of the channel was meant to remove.
    if (exclude?.(session)) continue;
    if (isDirect(session)) direct.push(session);
    else if (isThread(session)) threads.push(session);
    else channels.push(session);
  }

  return { channels, direct, threads };
}
