// ─── Migration 146: an event's extra matching questions (10 Nov 2026 spec, Part 3 Task 5; plan K5) ───────────────
//
// Two tables, both empty until an organiser saves a question: event_matching_questions (the event's questions, their
// answers to choose from as JSONB, their order) and event_question_answers (each person's option keys per question), with
// one index for a person's answers in an event. Applied files are never edited: a later change is a NEW migration.
//
// Running the file twice is held here by its guards (CREATE TABLE / INDEX IF NOT EXISTS) and was run twice for real on a
// scratch Postgres (PGlite, t5-pglite.mjs) for the task report.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '146_event_matching_questions.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const code = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = (text: string) => code(text).replace(/\s+/g, ' ').trim();

describe('migration 146 (an event\'s extra matching questions)', () => {
  it('is the only migration numbered 146', () => {
    expect(fs.readdirSync(MIGRATIONS).filter((f) => f.startsWith('146_'))).toEqual([FILE]);
  });

  it('has no top-level transaction control (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('makes event_matching_questions with an id, timestamps, a cascading event, the limits and one key per event', () => {
    const f = flat(sql);
    expect(f).toContain('CREATE TABLE IF NOT EXISTS event_matching_questions (');
    expect(f).toContain('id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(f).toContain('session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE');
    expect(f).toContain("key TEXT NOT NULL CHECK (key ~ '^[a-z0-9_]{1,32}$')");
    expect(f).toContain('prompt TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 120)');
    expect(f).toContain("kind TEXT NOT NULL CHECK (kind IN ('single', 'multiple'))");
    expect(f).toContain("prefer TEXT NOT NULL CHECK (prefer IN ('same', 'different'))");
    expect(f).toContain('required BOOLEAN NOT NULL DEFAULT FALSE');
    expect(f).toContain("options JSONB NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 8)");
    expect(f).toContain('updated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL');
    expect(f).toContain('UNIQUE (session_id, key)');
  });

  it('makes event_question_answers: one answer per person and question, 1 to 8 option keys, everything cascading', () => {
    const f = flat(sql);
    expect(f).toContain('CREATE TABLE IF NOT EXISTS event_question_answers (');
    expect(f).toContain('question_id UUID NOT NULL REFERENCES event_matching_questions(id) ON DELETE CASCADE');
    expect(f).toContain('user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(f).toContain('option_keys TEXT[] NOT NULL CHECK (cardinality(option_keys) BETWEEN 1 AND 8)');
    expect(f).toContain('UNIQUE (question_id, user_id)');
  });

  it('gives every table its timestamps, and every foreign key says what a delete does', () => {
    const f = flat(sql);
    expect(f.match(/created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/g)).toHaveLength(2);
    const references = f.match(/REFERENCES [a-z_]+\([a-z_]+\)[^,)]*/g) ?? [];
    expect(references).toHaveLength(5);
    for (const ref of references) expect(ref).toMatch(/ON DELETE (CASCADE|SET NULL)/);
  });

  it('indexes a person\'s answers in an event, guarded', () => {
    expect(flat(sql)).toContain('CREATE INDEX IF NOT EXISTS idx_event_question_answers_person ON event_question_answers (session_id, user_id);');
  });

  it('guards every statement, so running it twice changes nothing', () => {
    const statements = code(sql).split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(3);
    for (const s of statements) expect(s).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS /);
  });
});
