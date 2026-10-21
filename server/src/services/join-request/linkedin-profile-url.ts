// ─── The LinkedIn address on a join request (21 Oct 2026) ────────────────────
//
// LinkedIn is optional on the request form ("Recommend LinkedIn, but let people add it later"). When an
// address IS given it must be a LinkedIn profile, linkedin.com/in/<name>, and it is stored in one shape,
// https://www.linkedin.com/in/<name>, however it was typed: with or without www., http or https, a trailing
// slash, a query string, another country's subdomain (uk.linkedin.com), a page under the profile.
//
// It is checked strictly, and rebuilt from the name alone, because admins see it as a link in the queue and
// in the approval email: a stored address can never take them to another site, and nothing but the name
// the person gave is ever kept from what they typed. (The check used to be "is it a URL at all", which
// also let "javascript:" addresses through.)
//
// Since the final review of 21 Oct the rule is the one helper in @rsn/shared (linkedin/profile-url.ts),
// which onboarding v2 uses too, so the two can never store one profile two ways. It also reads past the
// LinkedIn address the live form puts where the name should be (https://linkedin.com/in/linkedin.com/in/
// jane-doe), which used to be stored as https://www.linkedin.com/in/linkedin.com.
//
// enrichment.service.ts has a normaliser of its own, normalizeLinkedinUrl. It is deliberately lenient (it
// hands back what it was given when it cannot read it) because it prepares an address for a lookup. This
// one is the opposite: it answers null for anything that is not a LinkedIn profile.
//
// The request form runs the same rules in the browser (client/src/features/auth/linkedin-link.ts) so a
// mistake is shown next to the box. One test (server/src/__tests__/client/join-form-linkedin.test.ts)
// runs both over the same addresses so they cannot drift apart.

import { LINKEDIN_PROFILE_HELP as HELP, linkedinProfileUrl } from '@rsn/shared';

/** What the person is told when what they gave is not a LinkedIn profile address. */
export const LINKEDIN_PROFILE_HELP = HELP;

/** The profile address `input` stands for, as https://www.linkedin.com/in/<name>, or null when it is not one. */
export const canonicalLinkedinProfileUrl = linkedinProfileUrl;
