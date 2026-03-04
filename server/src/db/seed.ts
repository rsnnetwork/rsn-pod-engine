// ─── Database Seed Script ────────────────────────────────────────────────────
import { pool, transaction } from './index';
import logger from '../config/logger';
import { v4 as uuid } from 'uuid';

async function seed(): Promise<void> {
  try {
    await transaction(async (client) => {
      // 1. Create admin user
      const adminId = uuid();
      await client.query(
        `INSERT INTO users (id, email, display_name, first_name, last_name, role, status, profile_complete, email_verified)
         VALUES ($1, $2, $3, $4, $5, 'admin', 'active', TRUE, TRUE)
         ON CONFLICT (email) DO NOTHING`,
        [adminId, 'admin@rsn.com', 'RSN Admin', 'RSN', 'Admin']
      );

      // 2. Create demo host user
      const hostId = uuid();
      await client.query(
        `INSERT INTO users (id, email, display_name, first_name, last_name, role, status, profile_complete, email_verified,
         company, job_title, industry, interests, reasons_to_connect)
         VALUES ($1, $2, $3, $4, $5, 'host', 'active', TRUE, TRUE,
                 $6, $7, $8, $9, $10)
         ON CONFLICT (email) DO NOTHING`,
        [
          hostId,
          'host@rsn.com',
          'Demo Host',
          'Demo',
          'Host',
          'RSN Platform',
          'Community Director',
          'Technology',
          ['networking', 'startups', 'technology'],
          ['find co-founders', 'share knowledge'],
        ]
      );

      // 3. Create demo member users
      const members = [
        { email: 'alice@example.com', first: 'Alice', last: 'Chen', company: 'TechCorp', job: 'Software Engineer', industry: 'Technology' },
        { email: 'bob@example.com', first: 'Bob', last: 'Martinez', company: 'StartupXYZ', job: 'Founder', industry: 'SaaS' },
        { email: 'carol@example.com', first: 'Carol', last: 'Williams', company: 'DesignCo', job: 'UX Designer', industry: 'Design' },
        { email: 'dave@example.com', first: 'Dave', last: 'Johnson', company: 'InvestFund', job: 'Investor', industry: 'Finance' },
        { email: 'eve@example.com', first: 'Eve', last: 'Brown', company: 'MarketPro', job: 'Marketing Lead', industry: 'Marketing' },
        { email: 'frank@example.com', first: 'Frank', last: 'Davis', company: 'DataInsights', job: 'Data Scientist', industry: 'AI/ML' },
      ];

      const memberIds: string[] = [];
      for (const m of members) {
        const id = uuid();
        memberIds.push(id);
        await client.query(
          `INSERT INTO users (id, email, display_name, first_name, last_name, role, status, profile_complete, email_verified,
           company, job_title, industry, interests, reasons_to_connect)
           VALUES ($1, $2, $3, $4, $5, 'member', 'active', TRUE, TRUE, $6, $7, $8, $9, $10)
           ON CONFLICT (email) DO NOTHING`,
          [
            id,
            m.email,
            `${m.first} ${m.last}`,
            m.first,
            m.last,
            m.company,
            m.job,
            m.industry,
            ['networking', 'growth', 'innovation'],
            ['find partners', 'learn new skills'],
          ]
        );
      }

      // 4. Create a demo pod
      const podId = uuid();
      await client.query(
        `INSERT INTO pods (id, name, description, pod_type, orchestration_mode, communication_mode, visibility, status, max_members, created_by)
         VALUES ($1, $2, $3, 'speed_networking', 'timed_rounds', 'video', 'invite_only', 'active', 500, $4)
         ON CONFLICT DO NOTHING`,
        [
          podId,
          'RSN Launch Event Pod',
          'The inaugural RSN Speed Networking Pod — connect with founders, investors, and innovators.',
          hostId,
        ]
      );

      // 5. Add host as pod director
      await client.query(
        `INSERT INTO pod_members (pod_id, user_id, role, status)
         VALUES ($1, $2, 'director', 'active')
         ON CONFLICT (pod_id, user_id) DO NOTHING`,
        [podId, hostId]
      );

      // 6. Add members to pod
      for (const memberId of memberIds) {
        await client.query(
          `INSERT INTO pod_members (pod_id, user_id, role, status)
           VALUES ($1, $2, 'member', 'active')
           ON CONFLICT (pod_id, user_id) DO NOTHING`,
          [podId, memberId]
        );
      }

      // 7. Create default entitlements for all users
      const allUserIds = [adminId, hostId, ...memberIds];
      for (const userId of allUserIds) {
        await client.query(
          `INSERT INTO user_entitlements (user_id, max_pods_owned, max_sessions_per_month, max_invites_per_day, can_host_sessions, can_create_pods, access_level)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id) DO NOTHING`,
          [
            userId,
            userId === adminId ? 100 : userId === hostId ? 10 : 1,
            userId === adminId ? 100 : userId === hostId ? 20 : 5,
            userId === adminId ? 1000 : userId === hostId ? 50 : 10,
            userId === adminId || userId === hostId,
            userId === adminId || userId === hostId,
            userId === adminId ? 'admin' : userId === hostId ? 'host' : 'basic',
          ]
        );
      }

      // 8. Create default subscriptions
      for (const userId of allUserIds) {
        await client.query(
          `INSERT INTO user_subscriptions (user_id, plan, status)
           VALUES ($1, 'free', 'active')
           ON CONFLICT (user_id) DO NOTHING`,
          [userId]
        );
      }

      logger.info({
        admin: adminId,
        host: hostId,
        members: memberIds.length,
        pod: podId,
      }, 'Seed data inserted');
    });
  } finally {
    await pool.end();
  }
}

seed()
  .then(() => {
    logger.info('Seeding complete');
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, 'Seeding failed');
    process.exit(1);
  });
