// ─── An organiser's export of their circle or pod (Shirley pilot S7, 11 Nov 2026; item 20, plan decision D6) ─────
// "Organisers should be able to export if they leave", inside privacy limits: a joined member has not agreed to their
// private profile data or messages leaving REASON. So the files hold the space's own details, its current members by
// name with their role and the date they joined (never an email or any private profile field; people who left or were
// removed are a count only), the events it ran as counts, and the posts the organiser wrote themselves.
// Who: a circle's owner and moderators; a pod's director and hosts. Every download is written to the access log
// before the file leaves, and refused when that write fails.

export const SPACE_KINDS = ['circle', 'pod'] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

export const SPACE_EXPORT_SECTIONS = ['space', 'members', 'events', 'posts'] as const;
export type SpaceExportSection = (typeof SPACE_EXPORT_SECTIONS)[number];

/** What each file is called on the export sheet, and what it holds, in a member's words. */
export const SPACE_EXPORT_COPY: Record<SpaceExportSection, { label: string; holds: string }> = {
  space: { label: 'Details', holds: 'Its name, description, settings, when it was made and how many members it has.' },
  members: { label: 'Members', holds: 'Current members: name, role and the date they joined. No email addresses.' },
  events: { label: 'Events', holds: 'Its own events: title, time, status, and how many registered and came. Each pod in a circle exports its own events.' },
  posts: { label: 'Your posts', holds: 'The posts you wrote on its wall. Other people\'s posts and comments stay on REASON.' },
};

/**
 * GET /api/circles/archived/mine: an archived circle the member is still owner or moderator of (fix round 1). Its page
 * stays closed; the Circles page lists it with its Export, so an organiser keeps their copy after archiving.
 */
export interface ArchivedCircleRun { id: string; name: string; archivedAt: string; myRole: 'owner' | 'moderator' }
