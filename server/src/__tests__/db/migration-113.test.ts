// ─── Migration 113: the organiser's own words on a "message everyone" job (26 Oct 2026) ──
//
// Message all participants v2 (COM-03). Until now a job sent a fixed feedback template; now the
// organiser writes the message, and a job may also reach the people who registered but never came.
// Both are columns on post_event_message_jobs. The body is NULL for the older, template jobs, so
// every row that exists keeps meaning exactly what it meant. The index serves the "3 sends per event
// per sender per 24 hours" count. This file is applied in production and is never edited: a later
// change restates what it needs in a NEW migration and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const FILE = '113_post_event_message_body.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is never read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ');

describe('migration 113 (post-event message body)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('only adds: nothing is dropped, deleted, truncated, rewritten or inserted', () => {
    expect(flat).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT)\b/i);
  });

  it('adds the organiser\'s text as a nullable column of 1 to 2000 characters, so every older job stays a template job', () => {
    expect(flat).toMatch(/ALTER TABLE post_event_message_jobs/i);
    expect(flat).toMatch(
      /ADD COLUMN IF NOT EXISTS body TEXT NULL CHECK \(body IS NULL OR length\(btrim\(body\)\) BETWEEN 1 AND 2000\)/i,
    );
  });

  it('adds the "also people who registered but did not come" choice, off for every existing job', () => {
    expect(flat).toMatch(/ADD COLUMN IF NOT EXISTS include_no_shows BOOLEAN NOT NULL DEFAULT FALSE/i);
  });

  it('indexes the sender\'s recent sends for one event, newest first', () => {
    expect(flat).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_pem_jobs_creator ON post_event_message_jobs \(session_id, created_by, created_at DESC\)/i,
    );
  });

  it('is safe to run twice: every statement is guarded', () => {
    const columns = flat.match(/ADD COLUMN/gi) ?? [];
    const guarded = flat.match(/ADD COLUMN IF NOT EXISTS/gi) ?? [];
    expect(columns.length).toBe(2);
    expect(guarded.length).toBe(columns.length);
    for (const create of flat.match(/CREATE (UNIQUE )?INDEX [^;]*/gi) ?? []) {
      expect(create).toMatch(/IF NOT EXISTS/i);
    }
  });
});
