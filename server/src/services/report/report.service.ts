// ─── Report Service ──────────────────────────────────────────────────────────
//
// Phase H of chat-fix-and-dm-system plan (1 May 2026). Stefan: "people
// should be able to report people". Reports go into an admin moderation
// queue. Distinct from blocks (silent, per-user, no admin involvement).
//
// 11 Nov 2026 (Shirley Palmer's item 16): a report can name one message or one wall post, not only a member. The member
// reported is then its author, and a copy of its words is kept with the report (migration 150), so the evidence outlives
// a delete. The same reporter reporting the same target again within a day is told "You already reported this.".

import { v4 as uuid } from 'uuid';
import type { PoolClient } from 'pg';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { AppError, ConflictError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes, REPORT_REPEAT_HOURS, type ReportReason, type ReportSubjectKind } from '@rsn/shared';
import { getPost as getPodPost } from '../pod/pod-wall.service';
import { getPost as getCirclePost } from '../circle/circle-wall.service';
import { canReadEventChat } from '../event-chat/event-chat.service';

export type { ReportReason } from '@rsn/shared';
export type ReportStatus = 'open' | 'resolved' | 'dismissed';

export interface UserReport {
  id: string;
  reporterId: string;
  reportedId: string;
  reason: ReportReason;
  description: string | null;
  status: ReportStatus;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNotes: string | null;
  createdAt: Date;
  /** What was reported besides the member (migration 150): one message or post, or null for the member alone. */
  subjectKind: ReportSubjectKind | null;
  subjectId: string | null;
}

export interface ReportWithUsers extends UserReport {
  reporterDisplayName: string | null;
  reporterEmail: string | null;
  reportedDisplayName: string | null;
  reportedEmail: string | null;
  // Auto-flag count: total open reports against the reported user.
  totalOpenAgainstReported: number;
  /** The reported message's or post's words as they were when it was reported. Platform admins only. */
  subjectExcerpt: string | null;
}

const VALID_REASONS: ReportReason[] = [
  'spam', 'harassment', 'inappropriate_content',
  'fake_profile', 'safety', 'other',
];

/** The copy of a message or post kept with its report: the evidence that outlives a delete. */
export const EXCERPT_MAX = 2000;

/** What a member reads when a report is refused. */
export const REPORT_WORDS = {
  self: 'You cannot report yourself.',
  ownMessage: 'You cannot report your own message.',
  ownPost: 'You cannot report your own post.',
  ownComment: 'You cannot report your own comment.',
  systemMessage: 'This message comes from REASON and cannot be reported.',
  messageGone: 'That message is no longer there.',
  postGone: 'That post is no longer there.',
  commentGone: 'That comment is no longer there.',
  noTarget: 'Say who or what you are reporting.',
  already: 'You already reported this.',
} as const;

/** A report as the route hands it over. A report names a member (`reportedId`), or a message or post (`subject`). */
export interface ReportInput {
  reason: ReportReason;
  description?: string;
  /** Reported from a chat: the conversation, kept only when the reporter is in it. */
  conversationId?: string | null;
  reportedId?: string;
  subject?: { kind: ReportSubjectKind; id: string };
}

/** Who is reporting, as the walls read them (a platform admin reads every pod and circle wall). */
export interface Reporter {
  userId: string;
  role: string;
}

/** A reported message or post, as the reporter can see it: its author, its words, and the chat it sits in. */
interface ResolvedSubject {
  authorId: string;
  excerpt: string;
  conversationId: string | null;
}

/** Words plus what was attached, cut to EXCERPT_MAX: a voice note or a picture is kept as its address. */
export function excerptOf(content: string | null | undefined, attachments: Array<{ label: string; url: string }> = []): string {
  const parts = [(content ?? '').trim(), ...attachments.map((a) => `[${a.label}] ${a.url}`)].filter(Boolean);
  return parts.join('\n').slice(0, EXCERPT_MAX);
}

/**
 * A direct message the reporter can see: one in a conversation they are part of. A message of someone else's chat, a
 * group message (it has no conversation) and one that is gone all read as "no longer there", so nothing is learnt about
 * other chats. REASON's own cards (kind system) and the reporter's own words cannot be reported.
 */
async function resolveDmMessage(reporterId: string, messageId: string): Promise<ResolvedSubject> {
  const r = await query<{
    from_user_id: string; content: string | null; kind: string | null; conversation_id: string;
    attachment_type: string | null; attachment_url: string | null;
  }>(
    `SELECT m.from_user_id, m.content, m.kind, m.conversation_id, m.attachment_type, m.attachment_url
       FROM direct_messages m
       JOIN dm_conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND (c.user_a_id = $2 OR c.user_b_id = $2)`,
    [messageId, reporterId],
  );
  const m = r.rows[0];
  if (!m) throw new NotFoundError('Message', messageId, REPORT_WORDS.messageGone);
  if (m.kind === 'system') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, REPORT_WORDS.systemMessage);
  if (m.from_user_id === reporterId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, REPORT_WORDS.ownMessage);
  const label = m.attachment_type === 'audio' ? 'Voice message' : m.attachment_type === 'image' ? 'Photo' : 'Attachment';
  return {
    authorId: m.from_user_id,
    excerpt: excerptOf(m.content, m.attachment_url ? [{ label, url: m.attachment_url }] : []),
    conversationId: m.conversation_id,
  };
}

/** The words and pictures of a wall post. */
function postExcerpt(post: { content: string; media: Array<{ type: string; url: string }> }): string {
  return excerptOf(post.content, post.media.map((m) => ({ label: m.type === 'image' ? 'Photo' : 'Attachment', url: m.url })));
}

/**
 * A pod wall post the reporter can read now: the wall's own read decides (an active member of the pod, or a platform
 * admin; a removed member is refused), and a post by someone either of them blocked is "no longer there" to them.
 */
async function resolvePodPost(reporter: Reporter, postId: string): Promise<ResolvedSubject> {
  const r = await query<{ pod_id: string }>(
    `SELECT pod_id FROM pod_posts WHERE id = $1 AND deleted_at IS NULL`,
    [postId],
  );
  const podId = r.rows[0]?.pod_id;
  if (!podId) throw new NotFoundError('Post', postId, REPORT_WORDS.postGone);
  const post = await getPodPost(podId, postId, { userId: reporter.userId, role: reporter.role });
  return { authorId: post.authorId, excerpt: postExcerpt(post), conversationId: null };
}

/** A circle wall post the reporter can read now, by the circle wall's own read. */
async function resolveCirclePost(reporter: Reporter, postId: string): Promise<ResolvedSubject> {
  const post = await getCirclePost(postId, reporter.userId, reporter.role);
  if (!post) throw new NotFoundError('Post', postId, REPORT_WORDS.postGone);
  return { authorId: post.authorId, excerpt: postExcerpt(post), conversationId: null };
}

/**
 * A comment (or reply) on a pod wall post the reporter can read now: the comment and its post must stand, and the pod
 * wall's own read of that post decides (an active member of the pod, or a platform admin; a removed member is refused).
 */
async function resolvePodComment(reporter: Reporter, commentId: string): Promise<ResolvedSubject> {
  const r = await query<{ author_id: string; content: string; post_id: string; pod_id: string }>(
    `SELECT c.author_id, c.content, c.post_id, p.pod_id
       FROM pod_post_comments c
       JOIN pod_posts p ON p.id = c.post_id
      WHERE c.id = $1 AND c.deleted_at IS NULL AND p.deleted_at IS NULL`,
    [commentId],
  );
  const c = r.rows[0];
  if (!c) throw new NotFoundError('Comment', commentId, REPORT_WORDS.commentGone);
  await getPodPost(c.pod_id, c.post_id, { userId: reporter.userId, role: reporter.role });
  return { authorId: c.author_id, excerpt: excerptOf(c.content), conversationId: null };
}

/** A comment (or reply) on a circle wall post the reporter can read now, by the circle wall's own read of the post. */
async function resolveCircleComment(reporter: Reporter, commentId: string): Promise<ResolvedSubject> {
  const r = await query<{ author_id: string; content: string; post_id: string }>(
    `SELECT c.author_id, c.content, c.post_id
       FROM circle_post_comments c
       JOIN circle_posts p ON p.id = c.post_id
      WHERE c.id = $1 AND c.deleted_at IS NULL AND p.deleted_at IS NULL`,
    [commentId],
  );
  const c = r.rows[0];
  if (!c) throw new NotFoundError('Comment', commentId, REPORT_WORDS.commentGone);
  const post = await getCirclePost(c.post_id, reporter.userId, reporter.role);
  if (!post) throw new NotFoundError('Comment', commentId, REPORT_WORDS.commentGone);
  return { authorId: c.author_id, excerpt: excerptOf(c.content), conversationId: null };
}

/**
 * A message in a group chat the reporter is a member of now, written since they joined it (what the group's own read
 * shows them). Someone who left, was never in it, or joined after the message reads it as "no longer there". REASON's
 * own lines cannot be reported.
 */
async function resolveGroupMessage(reporterId: string, messageId: string): Promise<ResolvedSubject> {
  const r = await query<{
    from_user_id: string; content: string | null; kind: string | null;
    attachment_type: string | null; attachment_url: string | null;
  }>(
    `SELECT m.from_user_id, m.content, m.kind, m.attachment_type, m.attachment_url
       FROM direct_messages m
       JOIN dm_group_members gm ON gm.group_id = m.group_id AND gm.user_id = $2
      WHERE m.id = $1 AND m.group_id IS NOT NULL AND m.created_at >= gm.joined_at`,
    [messageId, reporterId],
  );
  const m = r.rows[0];
  if (!m) throw new NotFoundError('Message', messageId, REPORT_WORDS.messageGone);
  if (m.kind === 'system') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, REPORT_WORDS.systemMessage);
  const label = m.attachment_type === 'audio' ? 'Voice message' : m.attachment_type === 'image' ? 'Photo' : 'Attachment';
  return {
    authorId: m.from_user_id,
    excerpt: excerptOf(m.content, m.attachment_url ? [{ label, url: m.attachment_url }] : []),
    conversationId: null,
  };
}

/**
 * A message in an event's chat the reporter can read: the event's own chat rule decides (its host, co-hosts and the
 * people who joined it; a removed member reads nothing), and a breakout room's message only by the people it was for.
 * A message whose sender's account is gone, or one deleted, is "no longer there".
 */
async function resolveEventChatMessage(reporter: Reporter, messageId: string): Promise<ResolvedSubject> {
  const r = await query<{ session_id: string; sender_id: string | null; content: string; scope: string; audience_ids: string[] | null }>(
    `SELECT session_id, sender_id, content, scope, audience_ids
       FROM event_chat_messages
      WHERE id = $1 AND deleted_at IS NULL`,
    [messageId],
  );
  const m = r.rows[0];
  if (!m || !m.sender_id) throw new NotFoundError('Message', messageId, REPORT_WORDS.messageGone);
  // The same rule the room's own chat uses (fix round 2): someone registered and in the room before the event starts
  // reads its lobby chat (their joined_at is still empty then), so they can report what they read there. A removed
  // member, or someone with no place, still reads nothing.
  const access = await canReadEventChat(reporter.userId, reporter.role, m.session_id, { inSessionRoom: true });
  const roomOk = m.scope === 'room' && access === 'all' && (m.audience_ids ?? []).includes(reporter.userId);
  if (!access || (m.scope !== 'lobby' && !roomOk)) throw new NotFoundError('Message', messageId, REPORT_WORDS.messageGone);
  return { authorId: m.sender_id, excerpt: excerptOf(m.content), conversationId: null };
}

const OWN_WORDS: Record<ReportSubjectKind, string> = {
  dm_message: REPORT_WORDS.ownMessage,
  group_message: REPORT_WORDS.ownMessage,
  event_chat_message: REPORT_WORDS.ownMessage,
  pod_post: REPORT_WORDS.ownPost,
  circle_post: REPORT_WORDS.ownPost,
  pod_comment: REPORT_WORDS.ownComment,
  circle_comment: REPORT_WORDS.ownComment,
};

function readSubject(reporter: Reporter, subject: NonNullable<ReportInput['subject']>): Promise<ResolvedSubject> {
  switch (subject.kind) {
    case 'dm_message': return resolveDmMessage(reporter.userId, subject.id);
    case 'pod_post': return resolvePodPost(reporter, subject.id);
    case 'circle_post': return resolveCirclePost(reporter, subject.id);
    case 'pod_comment': return resolvePodComment(reporter, subject.id);
    case 'circle_comment': return resolveCircleComment(reporter, subject.id);
    case 'group_message': return resolveGroupMessage(reporter.userId, subject.id);
    case 'event_chat_message': return resolveEventChatMessage(reporter, subject.id);
  }
}

/** What is reported, as the reporter can see it now; nobody reports their own words. */
async function resolveSubject(reporter: Reporter, subject: NonNullable<ReportInput['subject']>): Promise<ResolvedSubject> {
  const resolved = await readSubject(reporter, subject);
  if (resolved.authorId === reporter.userId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, OWN_WORDS[subject.kind]);
  return resolved;
}

/** Only a conversation the reporter is actually part of is kept, so the context link can't be spoofed to another chat. */
async function ownConversation(reporterId: string, conversationId: string | null | undefined): Promise<string | null> {
  if (!conversationId) return null;
  const conv = await query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)`,
    [conversationId, reporterId],
  );
  return conv.rows[0]?.id ?? null;
}

interface ReportRow {
  id: string; reporter_id: string; reported_id: string;
  reason: ReportReason; description: string | null;
  status: ReportStatus; resolved_by: string | null;
  resolved_at: Date | null; resolution_notes: string | null;
  created_at: Date;
  subject_kind?: ReportSubjectKind | null; subject_id?: string | null;
}

const REPORT_COLUMNS = `id, reporter_id, reported_id, reason, description, status,
               resolved_by, resolved_at, resolution_notes, created_at, subject_kind, subject_id`;

function toReport(r: ReportRow): UserReport {
  return {
    id: r.id, reporterId: r.reporter_id, reportedId: r.reported_id,
    reason: r.reason, description: r.description,
    status: r.status, resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at, resolutionNotes: r.resolution_notes,
    createdAt: r.created_at,
    subjectKind: r.subject_kind ?? null, subjectId: r.subject_id ?? null,
  };
}

interface NewReport {
  reporterId: string;
  reportedId: string;
  reason: ReportReason;
  description: string | null;
  conversationId: string | null;
  subject: ReportInput['subject'] | null;
  excerpt: string | null;
}

/**
 * One report per reporter and target a day, under a lock on that pair, so two tabs (or a double press) sending the same
 * report at once file it once and the second is told "You already reported this.". The target is the message or post
 * when there is one, else the member.
 */
async function insertOnce(client: PoolClient, row: NewReport): Promise<ReportRow> {
  const target = row.subject ? `${row.subject.kind}:${row.subject.id}` : `member:${row.reportedId}`;
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`report:${row.reporterId}:${target}`]);
  const earlier = row.subject
    ? await client.query(
      `SELECT 1 FROM user_reports
        WHERE reporter_id = $1 AND subject_kind = $2 AND subject_id = $3
          AND created_at > NOW() - ($4::int * INTERVAL '1 hour')
        LIMIT 1`,
      [row.reporterId, row.subject.kind, row.subject.id, REPORT_REPEAT_HOURS],
    )
    : await client.query(
      `SELECT 1 FROM user_reports
        WHERE reporter_id = $1 AND reported_id = $2 AND subject_id IS NULL
          AND created_at > NOW() - ($3::int * INTERVAL '1 hour')
        LIMIT 1`,
      [row.reporterId, row.reportedId, REPORT_REPEAT_HOURS],
    );
  if (earlier.rows.length > 0) throw new ConflictError(ErrorCodes.REPORT_ALREADY_SENT, REPORT_WORDS.already);

  const inserted = await client.query<ReportRow>(
    `INSERT INTO user_reports (id, reporter_id, reported_id, reason, description, conversation_id,
                               subject_kind, subject_id, subject_excerpt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${REPORT_COLUMNS}`,
    [
      uuid(), row.reporterId, row.reportedId, row.reason, row.description, row.conversationId,
      row.subject?.kind ?? null, row.subject?.id ?? null, row.excerpt,
    ],
  );
  return inserted.rows[0];
}

/**
 * Submit a report. It names a member, or one message or post: then the member reported is its author, whatever the
 * client sent, the reporter must be able to see it now, and a copy of its words is kept with the report. Nobody can
 * report themselves or their own words, and the same report within REPORT_REPEAT_HOURS is refused with "You already
 * reported this.". Reporting never needs the two to be on speaking terms: a message from someone the reporter has
 * blocked, in a chat the reporter is part of, can still be reported.
 */
export async function submitReport(reporter: Reporter, input: ReportInput): Promise<UserReport> {
  if (!VALID_REASONS.includes(input.reason)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `Invalid reason: ${input.reason}`);
  }
  const subject = input.subject ?? null;
  const resolved = subject ? await resolveSubject(reporter, subject) : null;
  const reportedId = resolved?.authorId ?? input.reportedId;
  if (!reportedId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, REPORT_WORDS.noTarget);
  if (reportedId === reporter.userId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, REPORT_WORDS.self);

  if (!resolved) {
    const reportedExists = await query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [reportedId]);
    if (reportedExists.rows.length === 0) throw new NotFoundError('User', reportedId);
  }

  const conversationId = resolved ? resolved.conversationId : await ownConversation(reporter.userId, input.conversationId);
  const r = await transaction((client) => insertOnce(client, {
    reporterId: reporter.userId,
    reportedId,
    reason: input.reason,
    description: input.description?.trim().slice(0, 2000) || null,
    conversationId,
    subject,
    excerpt: resolved?.excerpt ?? null,
  }));
  logger.info({ reportId: r.id, reporterId: reporter.userId, reportedId, reason: input.reason, subjectKind: subject?.kind ?? null }, 'User report submitted');
  return toReport(r);
}

/**
 * List all open reports for the admin moderation queue. Includes both
 * users' display info + total open reports against the reported user
 * (auto-flag signal), and the reported message's or post's words.
 */
export async function listOpenReports(): Promise<ReportWithUsers[]> {
  const result = await query<ReportRow & {
    reporter_name: string | null; reporter_email: string | null;
    reported_name: string | null; reported_email: string | null;
    total_open: string;
    subject_excerpt: string | null;
  }>(
    `SELECT r.id, r.reporter_id, r.reported_id, r.reason, r.description,
            r.status, r.resolved_by, r.resolved_at, r.resolution_notes, r.created_at,
            r.subject_kind, r.subject_id, r.subject_excerpt,
            ur.display_name AS reporter_name, ur.email AS reporter_email,
            ud.display_name AS reported_name, ud.email AS reported_email,
            (SELECT COUNT(*)::text FROM user_reports r2
              WHERE r2.reported_id = r.reported_id AND r2.status = 'open') AS total_open
     FROM user_reports r
     JOIN users ur ON ur.id = r.reporter_id
     JOIN users ud ON ud.id = r.reported_id
     WHERE r.status = 'open'
     ORDER BY r.created_at DESC
     LIMIT 500`,
  );
  return result.rows.map(r => ({
    ...toReport(r),
    reporterDisplayName: r.reporter_name,
    reporterEmail: r.reporter_email,
    reportedDisplayName: r.reported_name,
    reportedEmail: r.reported_email,
    totalOpenAgainstReported: parseInt(r.total_open || '0', 10),
    subjectExcerpt: r.subject_excerpt,
  }));
}

/**
 * Admin marks a report as resolved (action taken) with optional notes.
 */
export async function resolveReport(
  reportId: string,
  adminId: string,
  notes?: string,
): Promise<UserReport> {
  return updateReportStatus(reportId, adminId, 'resolved', notes);
}

/**
 * Admin dismisses a report (no action needed).
 */
export async function dismissReport(
  reportId: string,
  adminId: string,
  notes?: string,
): Promise<UserReport> {
  return updateReportStatus(reportId, adminId, 'dismissed', notes);
}

async function updateReportStatus(
  reportId: string,
  adminId: string,
  newStatus: 'resolved' | 'dismissed',
  notes?: string,
): Promise<UserReport> {
  const result = await query<ReportRow>(
    `UPDATE user_reports
     SET status = $2, resolved_by = $3, resolved_at = NOW(), resolution_notes = $4
     WHERE id = $1 AND status = 'open'
     RETURNING ${REPORT_COLUMNS}`,
    [reportId, newStatus, adminId, notes?.trim().slice(0, 2000) || null],
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('Report', reportId);
  }
  const r = result.rows[0];
  logger.info({ reportId: r.id, adminId, newStatus }, 'Report status updated');
  return toReport(r);
}
