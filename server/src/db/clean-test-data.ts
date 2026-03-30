// ─── Clean Test Data ─────────────────────────────────────────────────────────
// Removes all pods, sessions, invites, and related data while keeping users intact.
// Usage: npx ts-node src/db/clean-test-data.ts

import { pool } from './index';
import logger from '../config/logger';

async function cleanTestData(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Delete in dependency order (children first)
    await client.query('DELETE FROM ratings');
    await client.query('DELETE FROM event_feedback');
    await client.query('DELETE FROM session_cohosts');
    await client.query('DELETE FROM encounter_history');
    await client.query('DELETE FROM matches');
    await client.query('DELETE FROM session_participants');
    await client.query('DELETE FROM notifications');
    await client.query('DELETE FROM invites');
    await client.query('DELETE FROM sessions');
    await client.query('DELETE FROM pod_members');
    await client.query('DELETE FROM pods');

    await client.query('COMMIT');

    console.log('Cleaned: ratings, event_feedback, session_cohosts, encounter_history, matches, session_participants, notifications, invites, sessions, pod_members, pods');
    console.log('Kept: users, subscriptions, entitlements, join_requests, auth tokens, refresh_tokens, matching_templates');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'Clean failed');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

cleanTestData()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Clean failed:', err);
    process.exit(1);
  });
