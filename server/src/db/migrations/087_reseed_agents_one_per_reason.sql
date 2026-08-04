-- Migration 087: re-seed matching agents, ONE PER REASON (3 Aug 2026)
--
-- 086 seeded one agent per member from a blob of
-- who_i_want_to_meet + my_intent + why_i_want_to_meet + goals. Auditing the
-- result in production showed why that was wrong:
--
--   * One agent held six unrelated reasons: "founders, investors, family
--     offices, innovation leaders, government ... NGOs". An agent is supposed
--     to BE one reason; that is the entire point of the feature.
--   * The blob mixed who the member IS with who they WANT. "First time or
--     early stage founders its me" is a self-description, and it made the
--     member's agent hunt for founders.
--   * my_intent and goals contributed generic tags ("Expand Network", "Share
--     Knowledge") that overlap with nearly everyone, so 64 pairs scored a
--     perfect 1.0 and ranking became meaningless.
--
-- This re-seeds from who_i_want_to_meet ALONE — the one field that answers
-- "who do you want to meet" — and splits it into a separate agent per
-- designation the member actually named. want_text is the designation itself so
-- each agent searches for exactly one kind of person; the member's original
-- sentence is kept in intent.source so nothing they wrote is lost, and they can
-- edit any agent to add nuance.
--
-- Only untouched auto-seeded agents are replaced: anything the member has
-- edited (updated_at > created_at) or already used for an introduction is left
-- exactly as it is.

BEGIN;

CREATE TEMP TABLE reseed_targets ON COMMIT DROP AS
SELECT a.id
  FROM matching_agents a
 WHERE a.updated_at = a.created_at
   AND NOT EXISTS (SELECT 1 FROM user_pokes p WHERE p.agent_id = a.id);

DELETE FROM agent_matches WHERE agent_id IN (SELECT id FROM reseed_targets);
DELETE FROM matching_agents WHERE id IN (SELECT id FROM reseed_targets);

-- One row per (member, designation they named). want_text is the designation,
-- so a Developers agent can never be pulled toward investors by a stray word.
INSERT INTO matching_agents (user_id, label, want_text, intent, status)
SELECT u.id, d.label, d.want,
       jsonb_build_object('source', LEFT(u.who_i_want_to_meet, 1000), 'seeded', true),
       'active'
  FROM users u
  CROSS JOIN LATERAL (VALUES
    ('\m(co-?founder|founders?)\M',                'Founders',        'founders and co-founders'),
    ('\m(investors?|angels?|vcs?|venture capital)\M', 'Investors',    'investors, angels and VCs'),
    ('\m(developers?|engineers?|ctos?|programmers?)\M', 'Developers',  'software developers and engineers'),
    ('\m(advisors?|advisers?|mentors?)\M',         'Advisors',        'advisors and mentors'),
    ('\m(customers?|clients?|buyers?)\M',          'Customers',       'customers and clients'),
    ('\m(partners?|collaborators?)\M',             'Partners',        'partners and collaborators'),
    ('\m(marketers?|marketing)\M',                 'Marketing people','marketing leaders'),
    ('\m(sales)\M',                                'Sales leaders',   'sales leaders'),
    ('\m(hr|people leads?|recruiters?)\M',         'HR and people leads', 'HR directors and people leads'),
    ('\m(manufacturers?|suppliers?)\M',            'Manufacturers',   'manufacturers and suppliers'),
    ('\m(product managers?|project managers?|pms?)\M', 'Product and project managers', 'product and project managers'),
    ('\m(ceos?|executives?|c-?suite)\M',           'Executives',      'CEOs and executives')
  ) AS d(pattern, label, want)
 WHERE u.status = 'active'
   -- Both sources genuinely answer "who do you want to meet": the sentence they
   -- wrote, and the goals they ticked ("Find Investors", "Find Co-founder").
   -- Blending them was only harmful when it produced ONE agent holding every
   -- reason at once; splitting per designation makes reading both safe, and the
   -- want_text below is the designation alone, never the combined text.
   AND trim(concat_ws(' ', u.who_i_want_to_meet, array_to_string(u.goals, ' '))) ~* d.pattern
   AND NOT EXISTS (SELECT 1 FROM matching_agents e WHERE e.user_id = u.id AND e.label = d.label);

-- Members who described who they want in their own words without naming a
-- known designation keep a single agent carrying that sentence verbatim.
INSERT INTO matching_agents (user_id, label, want_text, intent, status)
SELECT u.id, 'People I want to meet', LEFT(u.who_i_want_to_meet, 2000),
       jsonb_build_object('source', LEFT(u.who_i_want_to_meet, 1000), 'seeded', true),
       'active'
  FROM users u
 WHERE u.status = 'active'
   AND COALESCE(u.who_i_want_to_meet, '') <> ''
   AND NOT EXISTS (SELECT 1 FROM matching_agents e WHERE e.user_id = u.id);

-- Members who never filled in who they want to meet, but did say why they are
-- here, get one agent from that. Deliberately NOT from `goals`: that column is
-- a picked-tag list ("Expand Network", "Find Investors", "Share Knowledge") and
-- feeding it in is what made 086's agents chase every founder and investor on
-- the platform regardless of what the member actually wanted.
INSERT INTO matching_agents (user_id, label, want_text, intent, status)
SELECT u.id, 'People I want to meet',
       LEFT(trim(concat_ws(' ', NULLIF(u.my_intent, ''), NULLIF(u.why_i_want_to_meet, ''))), 2000),
       jsonb_build_object('seeded', true, 'from', 'intent'),
       'active'
  FROM users u
 WHERE u.status = 'active'
   AND COALESCE(u.who_i_want_to_meet, '') = ''
   AND trim(concat_ws(' ', NULLIF(u.my_intent, ''), NULLIF(u.why_i_want_to_meet, ''))) <> ''
   AND NOT EXISTS (SELECT 1 FROM matching_agents e WHERE e.user_id = u.id);

COMMIT;
