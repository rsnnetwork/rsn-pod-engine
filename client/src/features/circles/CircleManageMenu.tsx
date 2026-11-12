// ─── A circle's Manage menu (Shirley pilot S3, 11 Nov 2026; brief RSN 11) ────────────────────────────────────────
// Edit details, Members, Invitations, Pods, Events, Visibility (who can join), Moderation (join requests) and Export, each
// only for whoever may use it (circleManageKeys: the owner and moderators; Visibility for the owner alone; Export by S7's
// own rule, the viewer's own role). Each entry opens
// the sheet or section the page already has, or the event scheduler for the circle. The page owns the sheets.
import { useNavigate } from 'react-router-dom';
import ManageMenu, { scrollToSection, type ManageEntry } from '@/features/manage/ManageMenu';
import { CIRCLE_HINT, SECTION_ID, circleManageKeys, type ManageKey } from '@/features/manage/manage-menu';
import { scheduleForCircleHref } from '@/features/sessions/circle-preset';
import { mayExportCircle } from '@/features/spaces/space-export';
import { POLICY_LABEL, type CircleDetail } from './circle-logic';

export type CircleSheet = 'edit' | 'invitations' | 'settings' | 'export';

interface Props {
  circle: CircleDetail;
  openSheet: (sheet: CircleSheet) => void;
  openRequests: () => void;
}

export default function CircleManageMenu({ circle, openSheet, openRequests }: Props) {
  const navigate = useNavigate();
  const waiting = circle.requestCount ?? 0;
  const entry: Record<ManageKey, ManageEntry | null> = {
    edit: { key: 'edit', onSelect: () => openSheet('edit'), testId: 'circle-edit' },
    members: { key: 'members', onSelect: () => scrollToSection(SECTION_ID.circleMembers) },
    invitations: { key: 'invitations', onSelect: () => openSheet('invitations'), testId: 'circle-invitations' },
    pods: { key: 'pods', onSelect: () => scrollToSection(SECTION_ID.circlePods) },
    events: { key: 'events', onSelect: () => navigate(scheduleForCircleHref(circle.id)) },
    visibility: circle.joinPolicy === undefined ? null : {
      key: 'visibility',
      onSelect: () => openSheet('settings'),
      testId: 'circle-settings',
      hint: `${CIRCLE_HINT.visibility}. Now: ${POLICY_LABEL[circle.joinPolicy]}.`,
    },
    moderation: { key: 'moderation', onSelect: openRequests, hint: waiting > 0 ? `${waiting} waiting to join` : CIRCLE_HINT.moderation },
    // Shirley pilot S7's export sheet, for the circle's owner and moderators (their own role, never an admin's powers).
    export: { key: 'export', onSelect: () => openSheet('export'), testId: 'circle-export' },
    circles: null,
    duplicate: null,
    archive: null,
  };
  const entries = circleManageKeys(circle, mayExportCircle(circle.myRole))
    .flatMap((key) => (entry[key] ? [{ hint: CIRCLE_HINT[key], ...entry[key]! }] : []));
  return <ManageMenu title={`Manage ${circle.name}`} entries={entries} />;
}
