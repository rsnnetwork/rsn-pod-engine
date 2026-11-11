// ─── An organiser's export as CSV files (Shirley pilot S7, 11 Nov 2026; item 20, D6) ─────────────────────────────
// Pure: the rows the reads in space-export.service.ts found, turned into the cells of four files. Every cell goes
// through csvCell (lib/csv.ts): RFC 4180 quoting, and text a spreadsheet would run as a formula (a name such as
// =HYPERLINK(...), a post that starts with +, - or @) is written with a ' in front. The file has a UTF-8 BOM and CRLF
// line ends, and is assembled by joining strings: no regex ever runs over a whole file (a regex over upload-sized
// text overflows Node 20's stack).
//
// What the files never hold: an email address, any private profile field, a member who left or was removed (they are
// a count), anyone blocked either way with the organiser, another member's post or comment (a count only), a private
// pod the organiser is not in, or one person's place at an event (each event's own report has that, under its rules).

import {
  EVENT_FORMATS, POD_VISIBILITY_COPY, podTypeRule, resolveEventFormat, utcToZonedWallTime, eventZone,
  type PodType, type PodVisibilitySetting, type SpaceExportSection, type SpaceKind,
} from '@rsn/shared';
import { csvDocumentWithBom, type CsvValue } from '../../lib/csv';

/** The space itself, as space.csv lists it. Linked names are the ones the organiser may see. */
export interface SpaceDetails {
  kind: SpaceKind;
  name: string;
  description: string | null;
  /** A circle: 'open' | 'closed'. A pod: its visibility setting. */
  access: string;
  createdAt: Date;
  currentMembers: number;
  formerMembers: number;
  /** A pod only. */
  podType?: string | null;
  status?: string | null;
  rules?: string | null;
  /** The pods a circle lists, or the circles a pod is in. */
  linked: string[];
  /** A circle only: the organisations (entities) linked to it. */
  organisations?: string[];
}

export interface MemberRow { name: string; role: string; joinedAt: Date }

export interface EventRow {
  title: string;
  scheduledAt: Date;
  timezone: string | null;
  status: string;
  publication: string | null;
  format: string | null;
  config: object | null;
  registered: number;
  came: number;
}

export interface PostRow {
  createdAt: Date;
  editedAt: Date | null;
  content: string;
  linkUrl: string | null;
  mediaCount: number;
  commentCount: number;
  pinned: boolean;
  /** A circle post that shares another post: only the organiser's own words are in the file. */
  shared?: boolean;
}

const ROLE_WORDS: Record<string, string> = {
  owner: 'Owner', moderator: 'Moderator', member: 'Member', director: 'Director', host: 'Host',
};

const LIVE = new Set(['lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby']);

const POD_STATUS_WORDS: Record<string, string> = { draft: 'Draft', active: 'Active', archived: 'Archived', suspended: 'Suspended' };

const two = (n: number) => String(n).padStart(2, '0');

/** "2026-11-11" in UTC. */
export function utcDay(at: Date): string {
  return `${at.getUTCFullYear()}-${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())}`;
}

/** "2026-11-11 14:05" in UTC, or '' for none. */
export function utcMinute(at: Date | null): string {
  if (!at) return '';
  return `${utcDay(at)} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`;
}

/** The file's name: what it holds and the day it was taken, never the space's own name (dates and fixed words only). */
export function exportFileName(kind: SpaceKind, section: SpaceExportSection, at: Date): string {
  return `reason-${kind}-${section}-${utcDay(at)}.csv`;
}

function accessWords(kind: SpaceKind, access: string): string {
  if (kind === 'circle') return access === 'closed' ? 'Closed: people ask to join and an organiser lets them in' : 'Open: anyone on REASON can join';
  const setting = (access === 'invite_only' ? 'private' : access) as PodVisibilitySetting;
  return POD_VISIBILITY_COPY[setting]?.label ?? POD_VISIBILITY_COPY.private.label;
}

export function spaceRows(d: SpaceDetails, at: Date): CsvValue[][] {
  const rows: CsvValue[][] = [
    ['Field', 'Value'],
    ['Kind', d.kind === 'circle' ? 'Circle' : 'Pod'],
    ['Name', d.name],
    ['Description', d.description ?? ''],
    [d.kind === 'circle' ? 'Who can join' : 'Visibility', accessWords(d.kind, d.access)],
  ];
  if (d.kind === 'pod') {
    rows.push(['Type', d.podType ? podTypeRule(d.podType as PodType).label : '']);
    rows.push(['Status', POD_STATUS_WORDS[d.status ?? ''] ?? '']);
    rows.push(['Rules', d.rules ?? '']);
  }
  rows.push(['Created', utcDay(d.createdAt)]);
  rows.push(['Current members', d.currentMembers]);
  rows.push([d.kind === 'circle' ? 'Members removed by an organiser' : 'Former members (left or removed)', d.formerMembers]);
  for (const name of d.linked) rows.push([d.kind === 'circle' ? 'Pod' : 'Circle', name]);
  for (const name of d.organisations ?? []) rows.push(['Organisation', name]);
  rows.push(['Exported (UTC)', utcMinute(at)]);
  return rows;
}

export function memberRows(members: readonly MemberRow[]): CsvValue[][] {
  const rows: CsvValue[][] = new Array(members.length + 1);
  rows[0] = ['Name', 'Role', 'Joined'];
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    rows[i + 1] = [m.name, ROLE_WORDS[m.role] ?? 'Member', utcDay(m.joinedAt)];
  }
  return rows;
}

function eventStatusWords(e: EventRow): string {
  if (e.status === 'cancelled') return 'Cancelled';
  if (e.status === 'completed') return 'Ended';
  if (LIVE.has(e.status)) return 'Live';
  return e.publication && e.publication !== 'published' ? 'Draft' : 'Upcoming';
}

export function eventRows(events: readonly EventRow[]): CsvValue[][] {
  const rows: CsvValue[][] = new Array(events.length + 1);
  rows[0] = ['Title', 'Starts (on the event\'s clock)', 'Time zone', 'Status', 'Format', 'Registered', 'Came'];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const zone = eventZone(e.timezone);
    rows[i + 1] = [
      e.title, utcToZonedWallTime(e.scheduledAt, zone).replace('T', ' '), zone, eventStatusWords(e),
      EVENT_FORMATS[resolveEventFormat({ format: e.format, config: e.config })].label, e.registered, e.came,
    ];
  }
  return rows;
}

export function postRows(kind: SpaceKind, posts: readonly PostRow[]): CsvValue[][] {
  const rows: CsvValue[][] = new Array(posts.length + 1);
  const header: CsvValue[] = ['Posted (UTC)', 'Edited (UTC)', 'Text', 'Link', 'Pictures or videos', 'Comments', 'Pinned'];
  rows[0] = kind === 'circle' ? [...header, 'Shares another post'] : header;
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const row: CsvValue[] = [
      utcMinute(p.createdAt), utcMinute(p.editedAt), p.content, p.linkUrl ?? '', p.mediaCount, p.commentCount, p.pinned ? 'Yes' : 'No',
    ];
    rows[i + 1] = kind === 'circle' ? [...row, p.shared ? 'Yes' : 'No'] : row;
  }
  return rows;
}

/** A finished file: its name, its text, and how many data rows it holds (for the access log). */
export interface SpaceExportFile { filename: string; body: string; rows: number }

export function exportFile(kind: SpaceKind, section: SpaceExportSection, rows: CsvValue[][], at: Date): SpaceExportFile {
  return { filename: exportFileName(kind, section, at), body: csvDocumentWithBom(rows), rows: Math.max(0, rows.length - 1) };
}
