// ─── A database that lets two invite requests really race (26 Oct 2026) ──────────────────────────
//
// Postgres is not part of the unit suite, so the "two requests for the same person make one invite" rule is
// proved against this stand-in. It keeps the `invites` table in memory and models the one thing that rule rests
// on: pg_advisory_xact_lock. A transaction that asks for a key waits until the transaction holding it commits or
// rolls back, exactly as Postgres does. Every statement yields to the event loop first, so two transactions that
// are NOT serialised interleave (both pass the duplicate check before either inserts). `honourLocks: false` turns
// the lock into a no-op: the test that uses it shows the harness does see the race, so a green run means the lock
// did the work and not luck.
//
// Statements it does not know are answered by `answers` (a test's own lookups: the pod, the member, the user).

export interface WorldInvite {
  id: string;
  code: string;
  type: string;
  inviterId: string;
  email: string | null;
  podId: string | null;
  sessionId: string | null;
  circleId: string | null;
  status: string;
  maxUses: number;
  expiresAt: Date | null;
  declinedAt: Date | null;
  createdAt: Date;
}

export type Answer = { rows: unknown[]; rowCount?: number } | undefined;
export type Answers = (sql: string, params: unknown[]) => Answer;

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A member of the in-memory platform, for the question "may this address be invited by this sender?". */
export interface WorldPerson {
  id: string;
  email: string;
  status: 'active' | 'suspended' | 'banned' | 'deactivated';
}

export function inviteWorld(options: {
  honourLocks?: boolean;
  answers?: Answers;
  /** The members and the blocks (blocker, blocked) that unreachableAddresses reads. */
  people?: WorldPerson[];
  blocks?: Array<[string, string]>;
} = {}) {
  const honourLocks = options.honourLocks ?? true;
  const invites: WorldInvite[] = [];
  /** What the world was asked, in order: `lock:<key>`, `duplicate-check`, `insert`, and `email-check` (before a batch email). */
  const log: string[] = [];
  /** For each lock key, the end of the line of transactions waiting for it. */
  const lockLine = new Map<string, Promise<void>>();
  let serial = 0;

  const toInvite = (r: WorldInvite) => ({
    id: r.id, code: r.code, type: r.type, inviterId: r.inviterId, inviteeEmail: r.email, podId: r.podId,
    sessionId: r.sessionId, circleId: r.circleId, status: r.status, maxUses: r.maxUses, useCount: 0, expiresAt: r.expiresAt,
    acceptedByUserId: null, acceptedAt: null, createdAt: r.createdAt, updatedAt: r.createdAt,
  });

  function run(sql: string, params: unknown[], takeLock?: (key: string) => Promise<void>): Promise<Answer> | Answer {
    const text = flat(sql);

    if (/pg_advisory_xact_lock/.test(text)) {
      const key = String(params[0]);
      log.push(`lock:${key}`);
      if (!honourLocks || !takeLock) return { rows: [], rowCount: 0 };
      return takeLock(key).then(() => ({ rows: [], rowCount: 0 }));
    }

    if (/^SELECT id FROM invites WHERE invitee_email = \$1 AND type = \$2 AND status = 'pending'/.test(text)) {
      log.push('duplicate-check');
      const [email, type, podId, sessionId, circleId] = params as [string, string, string | null, string | null, string | null];
      const now = Date.now();
      const rows = invites
        .filter((i) => i.email === email && i.type === type && i.status === 'pending'
          && (i.expiresAt === null || i.expiresAt.getTime() > now)
          && (podId === null || i.podId === podId)
          && (sessionId === null || i.sessionId === sessionId)
          && (circleId === null || i.circleId === circleId))
        .map((i) => ({ id: i.id }));
      return { rows, rowCount: rows.length };
    }

    // "Which of these addresses must not be invited by this sender": a member who is not active, or who is blocked
    // either way with the sender. Written out here the way the question is asked, not copied from the SQL's shape.
    if (/^SELECT u\.email FROM users u WHERE u\.email = ANY\(\$2::text\[\]\)/.test(text)) {
      const [senderId, emails] = params as [string, string[]];
      const blocks = options.blocks ?? [];
      const rows = (options.people ?? [])
        .filter((person) => emails.includes(person.email))
        .filter((person) => person.status !== 'active'
          || blocks.some(([blocker, blocked]) => (blocker === senderId && blocked === person.id) || (blocker === person.id && blocked === senderId)))
        .map((person) => ({ email: person.email }));
      return { rows, rowCount: rows.length };
    }

    // "Is this invite still waiting for an answer?": asked just before one of a batch's emails goes out (fix round 2). A
    // test changes `invites[n].status` or `.expiresAt` after the batch has answered to play a withdrawal, a decline or
    // an invite that ran out.
    if (/^SELECT invitee_email FROM invites WHERE id = \$1 AND status = 'pending'/.test(text)) {
      log.push('email-check');
      const [id] = params as [string];
      const now = Date.now();
      const found = invites.find((i) => i.id === id && i.status === 'pending' && (i.expiresAt === null || i.expiresAt.getTime() > now));
      return found ? { rows: [{ invitee_email: found.email }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (/^INSERT INTO invites/.test(text)) {
      log.push('insert');
      const [code, type, inviterId, email, podId, sessionId, maxUses, expiresAt, circleId] = params as [
        string, string, string, string | null, string | null, string | null, number, Date | null, string | null,
      ];
      serial += 1;
      const row: WorldInvite = {
        id: `invite-${serial}`, code, type, inviterId, email, podId, sessionId, circleId, status: 'pending',
        maxUses, expiresAt, declinedAt: null, createdAt: new Date(),
      };
      invites.push(row);
      return { rows: [toInvite(row)], rowCount: 1 };
    }

    return options.answers?.(text, params) ?? { rows: [], rowCount: 0 };
  }

  /** A statement outside any transaction (the pool). */
  const query = async (sql: string, params: unknown[] = []) => {
    await yieldToLoop();
    return run(sql, params) as Answer;
  };

  /** BEGIN, the callback, then COMMIT (or ROLLBACK when it throws): the locks it took are released either way. */
  const transaction = async <T>(callback: (client: { query: typeof query }) => Promise<T>): Promise<T> => {
    const held: Array<() => void> = [];
    const takeLock = async (key: string) => {
      const previous = lockLine.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => { release = resolve; });
      lockLine.set(key, previous.then(() => mine));
      held.push(release);
      await previous;
    };
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        await yieldToLoop();
        return run(sql, params, takeLock) as Answer;
      },
    };
    try {
      return await callback(client);
    } finally {
      for (const release of held) release();
    }
  };

  return { invites, log, query, transaction };
}
