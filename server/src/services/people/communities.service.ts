// ─── A profile's Communities (Shirley pilot S3, 11 Nov 2026; brief RSN 14) ───────────────────────────────────────
// "Display only Circles, Groups and Pods the viewer is permitted to discover; never expose hidden/private membership.
// 'Request to join' appears on discoverable approval gated spaces." Before this, a profile named only the spaces both
// people share (the brief's `shared`), so Shirley's Public with approval pod never showed on her profile.
//
// The rows are the spaces the person is in (an active pod membership; any circle membership: circle_members has no
// status) that the VIEWER may see:
//   - a space anyone may discover: an open circle, a Public open or a Public with approval pod (Shirley pilot S2, D2);
//   - or a space the viewer is in with them (an active pod membership, or a circle membership): the viewer already sees
//     its members, so naming it tells them nothing new. A private pod or a closed circle the viewer is not in is never
//     named, to anyone, platform admins included (a profile never shows an admin more than a member).
// Never listed: an archived circle; a pod that is not active (draft, suspended, archived); a membership that is not
// active (left, removed, invited, waiting).
//
// Nothing at all when the person turned "Show my communities on my profile" off (users.show_communities, migration
// 148), or is hidden from search (profile_visible false: the most private reading of "hidden"), or is an event guest. A
// block either way is the 404 an unknown member gets (as the brief answers), and so is a closed or suspended account.
//
// Each row's action follows the space's own rules (S2 included): in it, 'open'; an approval pod, 'request', or
// 'pending' while their ask waits; an open circle or a Public open pod, 'join', or 'none' when an organiser removed them
// (they come back only by an organiser's invitation; a platform admin is exempt, as the join routes say). The routes
// refuse anyway: this only decides which button is drawn.
//
// The preview ("Preview as others see it") is the same read for a viewer who is in nothing and blocked by no one, which
// is what a member with no connection to them is sent; only there is the member told why their list is empty.

import { query } from '../../db';
import { AppError, NotFoundError } from '../../middleware/errors';
import {
  ErrorCodes, UserRole,
  type ProfileCommunities, type ProfileCommunitiesHidden, type ProfileCommunity, type ProfileCommunityAccess,
  type ProfileCommunityAction, type ProfileCommunityRole,
} from '@rsn/shared';
import * as blockService from '../block/block.service';

/** The first page a profile shows, and the most one page may hold. */
export const COMMUNITIES_PAGE = 8;
export const COMMUNITIES_PAGE_MAX = 50;
/** No profile is paged past this: a person in more spaces than that is shown their first ones. */
export const COMMUNITIES_OFFSET_MAX = 1000;

export interface CommunitiesPage { limit?: number; offset?: number }

interface Target { status: string; account_kind: string | null; profile_visible: boolean; show_communities: boolean }

interface Row {
  kind: 'circle' | 'pod';
  id: string;
  name: string;
  role: string;
  access: ProfileCommunityAccess;
  viewer_member: boolean;
  viewer_pending: boolean;
  viewer_removed: boolean;
  has_rules: boolean;
  total: number;
}

const ROLES: readonly ProfileCommunityRole[] = ['owner', 'moderator', 'director', 'host', 'member'];

/**
 * The spaces both arms read, for the person in `$2` and the viewer in `$1` (NULL in the preview: in nothing, so only
 * the discoverable spaces pass). Organisers first (owner and director, then moderator and host), circles before pods,
 * then by name; the window count is every row the viewer may see. `$3` and `$4` are the page.
 */
export const COMMUNITIES_SQL = `
  WITH spaces AS (
    SELECT 'circle'::text AS kind, c.id, c.name, cm.role::text AS role,
           CASE WHEN c.join_policy = 'open' THEN 'open' ELSE 'members' END AS access,
           (vm.user_id IS NOT NULL) AS viewer_member,
           EXISTS (SELECT 1 FROM circle_join_requests r
                    WHERE r.circle_id = c.id AND r.user_id = $1 AND r.status = 'pending') AS viewer_pending,
           EXISTS (SELECT 1 FROM circle_removals x WHERE x.circle_id = c.id AND x.user_id = $1) AS viewer_removed,
           FALSE AS has_rules
      FROM circle_members cm
      JOIN circles c ON c.id = cm.circle_id AND c.archived_at IS NULL
      LEFT JOIN circle_members vm ON vm.circle_id = c.id AND vm.user_id = $1
     WHERE cm.user_id = $2
       AND (c.join_policy = 'open' OR vm.user_id IS NOT NULL)
    UNION ALL
    SELECT 'pod'::text AS kind, p.id, p.name, pm.role::text AS role,
           CASE p.visibility::text WHEN 'public' THEN 'open' WHEN 'public_with_approval' THEN 'approval' ELSE 'members' END AS access,
           COALESCE(vm.status::text = 'active', FALSE) AS viewer_member,
           COALESCE(vm.status::text = 'pending_approval', FALSE) AS viewer_pending,
           COALESCE(vm.status::text <> 'active' AND vm.removal_kind = 'removed', FALSE) AS viewer_removed,
           (COALESCE(btrim(p.join_config->>'rulesText'), '') <> ''
             OR COALESCE(btrim(p.join_config->>'agreementText'), '') <> '') AS has_rules
      FROM pod_members pm
      JOIN pods p ON p.id = pm.pod_id AND p.status::text = 'active'
      LEFT JOIN pod_members vm ON vm.pod_id = p.id AND vm.user_id = $1
     WHERE pm.user_id = $2 AND pm.status::text = 'active'
       AND (p.visibility::text IN ('public', 'public_with_approval') OR vm.status::text = 'active')
  )
  SELECT kind, id, name, role, access, viewer_member, viewer_pending, viewer_removed, has_rules,
         count(*) OVER ()::int AS total
    FROM spaces
   ORDER BY CASE WHEN role IN ('owner', 'director') THEN 0 WHEN role IN ('moderator', 'host') THEN 1 ELSE 2 END,
            kind, lower(name), id
   LIMIT $3 OFFSET $4`;

/** What the viewer can do from one row; see the header. A platform admin is never held back by a removal. */
export function actionFor(row: Pick<Row, 'kind' | 'access' | 'viewer_member' | 'viewer_pending' | 'viewer_removed'>, viewerIsAdmin: boolean): ProfileCommunityAction {
  if (row.viewer_member) return 'open';
  // Only a space the viewer is in is listed as members-only, so this is a row no viewer outside it is sent.
  if (row.access === 'members') return 'none';
  if (row.access === 'approval') return row.viewer_pending ? 'pending' : 'request';
  // An open circle or a Public open pod: they join at once (a waiting ask there is let in by joining), unless an
  // organiser removed them.
  return row.viewer_removed && !viewerIsAdmin ? 'none' : 'join';
}

function toCommunity(row: Row, viewerIsAdmin: boolean): ProfileCommunity {
  const role: ProfileCommunityRole = ROLES.find((r) => r === row.role) ?? 'member';
  return {
    kind: row.kind,
    id: row.id,
    name: row.name,
    role,
    access: row.access,
    action: actionFor(row, viewerIsAdmin),
    hasJoinRules: !!row.has_rules,
  };
}

function pageOf(page: CommunitiesPage): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? COMMUNITIES_PAGE), 1), COMMUNITIES_PAGE_MAX);
  const offset = Math.min(Math.max(Math.trunc(page.offset ?? 0), 0), COMMUNITIES_OFFSET_MAX);
  return { limit, offset };
}

async function readTarget(targetId: string): Promise<Target | null> {
  const r = await query<Target>(
    `SELECT status::text AS status, account_kind, profile_visible, show_communities FROM users WHERE id = $1`,
    [targetId],
  );
  return r.rows[0] ?? null;
}

/** Why a person's profile lists nothing whatever they are in, or null when it may list their spaces. */
export function hiddenReason(t: Pick<Target, 'account_kind' | 'profile_visible' | 'show_communities'>): ProfileCommunitiesHidden | 'guest' | null {
  if (t.account_kind === 'event_guest') return 'guest';
  if (t.show_communities === false) return 'setting_off';
  if (t.profile_visible === false) return 'hidden_from_search';
  return null;
}

const EMPTY: Omit<ProfileCommunities, 'hidden'> = { items: [], total: 0, nextOffset: null };

async function readPage(viewerId: string | null, targetId: string, page: CommunitiesPage, viewerIsAdmin: boolean): Promise<Omit<ProfileCommunities, 'hidden'>> {
  const { limit, offset } = pageOf(page);
  const r = await query<Row>(COMMUNITIES_SQL, [viewerId, targetId, limit, offset]);
  const total = r.rows[0]?.total ?? 0;
  const items = r.rows.map((row) => toCommunity(row, viewerIsAdmin));
  const next = offset + items.length;
  return { items, total, nextOffset: items.length > 0 && next < total && next <= COMMUNITIES_OFFSET_MAX ? next : null };
}

/**
 * The person's spaces the viewer may see. 400 for your own id (your own read is the preview), 404 when either has
 * blocked the other or the account is not open (the same 404 an unknown member gets).
 */
export async function getProfileCommunities(
  viewerId: string, viewerRole: string | undefined, targetId: string, page: CommunitiesPage = {},
): Promise<ProfileCommunities> {
  if (viewerId === targetId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'This is your own profile');
  }
  if (await blockService.areBlocked(viewerId, targetId)) throw new NotFoundError('User', targetId);
  const target = await readTarget(targetId);
  if (!target || target.status !== 'active') throw new NotFoundError('User', targetId);
  if (hiddenReason(target) !== null) return { ...EMPTY };
  const viewerIsAdmin = viewerRole === UserRole.ADMIN || viewerRole === UserRole.SUPER_ADMIN;
  return readPage(viewerId, targetId, page, viewerIsAdmin);
}

/**
 * Your own spaces as a member with no connection to you sees them ("Preview as others see it"), and, when that is
 * nothing because of a setting of yours, which one.
 */
export async function getOwnCommunitiesPreview(userId: string, page: CommunitiesPage = {}): Promise<ProfileCommunities> {
  const target = await readTarget(userId);
  if (!target) throw new NotFoundError('User', userId);
  const why = hiddenReason(target);
  if (why === 'guest') return { ...EMPTY, hidden: null };
  if (why !== null) return { ...EMPTY, hidden: why };
  return { ...(await readPage(null, userId, page, false)), hidden: null };
}
