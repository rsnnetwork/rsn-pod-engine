// Phase X — 13 May live-test bug fixes.
//
// Two bugs surfaced during the live test with Ali, Raja Ali King and
// Haseem Javed:
//
//   Bug 5 — mutual matches count counted per-round-pair (COUNT(*)) instead
//           of per-distinct-partner. Three rounds of the same pair both
//           saying "meet again" rendered as 3 mutual matches; spec says 1.
//
//   Bug 10 — once the host ends the event, the participant-side top-bar
//            controls (participants toggle + leave button), chat panel,
//            and participant list panel all stayed visible alongside the
//            recap. Spec: when phase=complete, only the recap renders.
//
// Both fixes are pinned here so they cannot silently revert.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServerSource(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClientSource(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src/', rel), 'utf8');
}

describe('Phase X — 13 May live-test bug fixes', () => {
  describe('Feature 17 — DM button on recap pages', () => {
    const sessionComplete = readClientSource('features/live/SessionComplete.tsx');
    const recapPage = readClientSource('features/sessions/RecapPage.tsx');

    it('SessionComplete imports MessageSquare icon and useToastStore', () => {
      expect(sessionComplete).toMatch(/MessageSquare/);
      expect(sessionComplete).toMatch(/import\s*\{\s*useToastStore\s*\}/);
    });

    it('SessionComplete defines MessagePartnerButton helper', () => {
      expect(sessionComplete).toMatch(/function\s+MessagePartnerButton/);
      // Click flow: GET /dm/conversations → find existing → navigate, or
      // POST /dm/messages with content → navigate. Both paths pinned.
      expect(sessionComplete).toMatch(/api\.get\(['"]\/dm\/conversations['"]\)/);
      expect(sessionComplete).toMatch(/api\.post\(['"]\/dm\/messages['"]/);
      expect(sessionComplete).toMatch(/navigate\(`\/messages\/\$\{[\s\S]{0,40}conversationId/);
    });

    it('SessionComplete renders MessagePartnerButton in mutualConnections + per-round rows', () => {
      // Two render sites: mutual matches list and the round-by-round list.
      const renders = sessionComplete.match(/<MessagePartnerButton\b/g) || [];
      expect(renders.length).toBeGreaterThanOrEqual(2);
    });

    it('RecapPage defines MessagePartnerButton helper too', () => {
      expect(recapPage).toMatch(/function\s+MessagePartnerButton/);
      expect(recapPage).toMatch(/api\.get\(['"]\/dm\/conversations['"]\)/);
      expect(recapPage).toMatch(/api\.post\(['"]\/dm\/messages['"]/);
    });

    it('RecapPage renders MessagePartnerButton in mutualConnections + per-round rows', () => {
      const renders = recapPage.match(/<MessagePartnerButton\b/g) || [];
      expect(renders.length).toBeGreaterThanOrEqual(2);
    });

    it('Buttons carry data-testid for e2e selection', () => {
      expect(sessionComplete).toMatch(/data-testid=\{\s*`recap-dm-button-\$\{userId\}`\s*\}/);
      expect(recapPage).toMatch(/data-testid=\{\s*`recap-dm-button-\$\{userId\}`\s*\}/);
    });
  });

  describe('Bug 12 — Co-Host badge on lobby tiles for Phase M opt-ins', () => {
    const src = readClientSource('features/live/Lobby.tsx');

    it('renders (Co-Host) label when isActingHost and not the director', () => {
      // The tile name overlay must branch: director → (Host), other acting
      // hosts → (Co-Host), regular participants → no badge. Pin both labels.
      expect(src).toMatch(/\(Co-Host\)/);
      expect(src).toMatch(/isActingHost\s*\?\s*\(\s*<span[^>]*>\(Co-Host\)/);
    });
  });

  describe('Bug 13 — ParticipantList toggle hidden for Phase M opt-ins', () => {
    const src = readClientSource('features/live/ParticipantList.tsx');

    it('button visibility check excludes users acting via Phase M opt-in', () => {
      expect(src).toMatch(/isViaPhaseM\s*=\s*!isFormalCohost\s*&&\s*actingAsHostOverrides\[p\.userId\]\s*===\s*true/);
      expect(src).toMatch(/if\s*\(!isOriginalHost\s*\|\|\s*isPHost\s*\|\|\s*isSelf\s*\|\|\s*isViaPhaseM\)\s*return\s+null/);
    });
  });

  describe('Bug 14 — Match People eligibility excludes Phase M opt-ins', () => {
    const src = readClientSource('features/live/HostControls.tsx');

    it('eligibleCount filters by hostsSet, not just cohosts + hostUserId', () => {
      expect(src).toMatch(/eligibleCount\s*=\s*participants\.filter\(\s*p\s*=>\s*!hostsSet\.has\(p\.userId\)\s*\)\.length/);
    });

    it('hostsSet derivation includes acting_as_host opt-ins and excludes opt-outs', () => {
      expect(src).toMatch(/actingAsHostOverrides/);
      expect(src).toMatch(/v\s*===\s*true\)\s*s\.add\(uid\)/);
      expect(src).toMatch(/v\s*===\s*false\)\s*s\.delete\(uid\)/);
    });
  });

  describe('Bug 16 — Join-as + revert banners hidden on phase=complete', () => {
    const src = readClientSource('features/live/LiveSessionPage.tsx');

    it('join-as banner gated by phase !== complete', () => {
      expect(src).toMatch(/showJoinAsBanner\s*&&\s*phase\s*!==\s*['"]complete['"]/);
    });

    it('acting-as-host revert banner gated by phase !== complete', () => {
      expect(src).toMatch(/baseIsHost\s*&&\s*myActingAsHost\s*===\s*false\s*&&\s*phase\s*!==\s*['"]complete['"]/);
    });
  });


  describe('Bug 1 — mute-all keeps camera alive', () => {
    const src = readServerSource('services/video/livekit.provider.ts');

    it('imports TrackSource from livekit-server-sdk', () => {
      expect(src).toMatch(/import\s*\{[\s\S]{0,200}TrackSource[\s\S]{0,200}\}\s*from\s*['"]livekit-server-sdk['"]/);
    });

    it('setParticipantCanPublishAudio uses canPublishSources whitelist, not canPublish flip', () => {
      const fnIdx = src.indexOf('async setParticipantCanPublishAudio');
      expect(fnIdx).toBeGreaterThan(-1);
      const block = src.slice(fnIdx, fnIdx + 3000);
      // The permission shape must include canPublishSources and keep
      // canPublish:true (so we don't kill video alongside audio).
      expect(block).toMatch(/canPublish:\s*true/);
      expect(block).toMatch(/canPublishSources:\s*allowedSources/);
      // No regression to the old "canPublish: canPublishAudio" form.
      expect(block).not.toMatch(/canPublish:\s*canPublishAudio/);
    });

    it('whitelist is gated by canPublishAudio with two explicit branches', () => {
      const fnIdx = src.indexOf('async setParticipantCanPublishAudio');
      const block = src.slice(fnIdx, fnIdx + 3000);
      // Locate the actual ternary expression (skip the comment that also
      // mentions canPublishAudio). The ternary form is
      //   const allowedSources = canPublishAudio? [...]: [...];
      const ternaryMatch = block.match(/canPublishAudio\s*\?\s*(\[[^\]]*\])\s*:\s*(\[[^\]]*\])/);
      expect(ternaryMatch).not.toBeNull();
      const [, truthyBranch, falsyBranch] = ternaryMatch!;

      // Mute (falsy) branch — no MICROPHONE, but camera + screen share remain.
      expect(falsyBranch).toMatch(/TrackSource\.CAMERA/);
      expect(falsyBranch).toMatch(/TrackSource\.SCREEN_SHARE/);
      expect(falsyBranch).not.toMatch(/TrackSource\.MICROPHONE/);

      // Unmute (truthy) branch — MICROPHONE restored alongside camera.
      expect(truthyBranch).toMatch(/TrackSource\.MICROPHONE/);
      expect(truthyBranch).toMatch(/TrackSource\.CAMERA/);
    });
  });

  describe('Bug 3 — participant-list demote walks both promotion paths', () => {
    const src = readClientSource('features/live/ParticipantList.tsx');

    it('imports api so the acting-as-host-for REST endpoint can be hit', () => {
      expect(src).toMatch(/import\s+api\s+from\s+['"]@\/lib\/api['"]/);
    });

    it('toggleCohost is async and checks the opted-in path before demoting via REST', () => {
      expect(src).toMatch(/const\s+toggleCohost\s*=\s*async/);
      // Demote branch must conditionally hit /host/acting-as-host-for when the
      // user is currently a Phase M opt-in (acting_as_host = true), not just
      // the session_cohosts table.
      expect(src).toMatch(/optedIn\s*=\s*actingAsHostOverrides\[userId\]\s*===\s*true/);
      expect(src).toMatch(/api\.post\(\s*[`'"][\s\S]{0,80}\/host\/acting-as-host-for\//);
    });
  });

  describe('Bug 4 — switch-back banner button disabled while in breakout', () => {
    const src = readClientSource('features/live/LiveSessionPage.tsx');

    it('derives inBreakout from phase ∈ {matched, rating}', () => {
      expect(src).toMatch(/inBreakout\s*=\s*phase\s*===\s*['"]matched['"]\s*\|\|\s*phase\s*===\s*['"]rating['"]/);
    });

    it('the revert button carries `disabled={inBreakout}` so it stays visible but inert', () => {
      expect(src).toMatch(/disabled=\{\s*inBreakout\s*\}/);
    });
  });

  describe('Bug 6 — encounter_history.times_met increments per match, not per session', () => {
    const src = readServerSource('services/rating/rating.service.ts');

    it('upsertEncounterHistory accepts matchId as a parameter', () => {
      expect(src).toMatch(/async\s+function\s+upsertEncounterHistory\(\s*[\s\S]{0,200}matchId:\s*string/);
    });

    it('isFirstRatingForThisMatch derived from ratings count on the same matchId', () => {
      // The new guard counts other ratings on the same match_id. Zero
      // means we're the first rater — increment. ≥1 means partner rated
      // already — suppress. This kills the old "same session = no
      // increment" bug.
      expect(src).toMatch(/isFirstRatingForThisMatch/);
      expect(src).toMatch(/FROM\s+ratings\s+WHERE\s+match_id\s*=\s*\$1\s+AND\s+from_user_id\s*<>\s*\$2/i);
    });

    it('UPDATE encounter_history uses isFirstRatingForThisMatch in the times_met expression', () => {
      const fnStart = src.indexOf('async function upsertEncounterHistory');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/times_met\s*=\s*\$\{isFirstRatingForThisMatch\s*\?\s*['"]times_met\s*\+\s*1['"]/);
    });
  });

  describe('Bug 7 — lobby header counts only present hosts', () => {
    const src = readClientSource('features/live/Lobby.tsx');

    it('totalHosts intersects hostsSet with the current participants list', () => {
      // Pre-fix used hostsSet.size which counted registered cohosts whether
      // they were in the room or not. After fix the count is a filter over
      // the participants array.
      expect(src).toMatch(/totalHosts\s*=\s*participants\.filter\(\s*p\s*=>\s*hostsSet\.has\(p\.userId\)\s*\)\.length/);
    });
  });

  describe('Bug 8 — host tile elevation works at mobile widths', () => {
    const src = readClientSource('features/live/Lobby.tsx');

    it('isActingHost branch uses col-span-2 row-span-2 (no sm: prefix)', () => {
      expect(src).toMatch(/isActingHost\s*\?\s*['"`]aspect-video\s+col-span-2\s+row-span-2/);
      // Negative guard: forbid the regression to sm:col-span-2.
      expect(src).not.toMatch(/isActingHost\s*\?\s*['"`]aspect-video\s+sm:col-span-2/);
    });
  });

  describe('Bug 9 — axios timeout long enough to ride out Render cold starts', () => {
    const src = readClientSource('lib/api.ts');

    it('axios.create timeout is at least 60000ms', () => {
      // Pin the floor — 30000 was failing on cold starts, 60000 is the
      // working value. A future regression that drops below 60000 will
      // start surfacing AxiosError timeouts to Sentry again.
      const m = src.match(/timeout:\s*(\d+)/);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThanOrEqual(60000);
    });
  });

  describe('Bug 5 — mutual matches dedup by partner_id', () => {
    const src = readServerSource('services/meeting-records/meeting-records.service.ts');

    it('getMutualMatches uses COUNT(DISTINCT partner_id), not COUNT(*)', () => {
      const fnStart = src.indexOf('export async function getMutualMatches');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);
      expect(fn).toMatch(/COUNT\(DISTINCT\s+partner_id\)/i);
      // Forbid the previous buggy form — a regression would put COUNT(*)
      // back which counts every meeting_records row including repeats.
      expect(fn).not.toMatch(/COUNT\(\*\)/);
    });

    it('getMeetingCounts.mutual uses COUNT(DISTINCT partner_id) FILTER', () => {
      const fnStart = src.indexOf('export async function getMeetingCounts');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);
      // The "mutual" column inside the SELECT must dedupe by partner_id.
      // The other two columns (unique_people, total) keep their existing
      // forms — only the mutual column had the bug.
      expect(fn).toMatch(/COUNT\(DISTINCT\s+partner_id\)\s+FILTER\s*\(\s*WHERE\s+is_mutual\s*=\s*TRUE\s*\)/i);
    });
  });

  describe('Bug 10 — event-controls hidden when phase = complete', () => {
    const src = readClientSource('features/live/LiveSessionPage.tsx');

    it('top-bar participant toggle + leave buttons wrapped in phase !== complete gate', () => {
      // The two buttons (Users icon toggle + Leave) live in the same
      // flex container. After the fix that container must be conditional
      // on phase !== 'complete'.
      const gate = src.match(/\{phase !== 'complete' && \(\s*<div className="flex items-center gap-1">/);
      expect(gate).not.toBeNull();
    });

    it('participant list panel render-gated by phase !== complete', () => {
      expect(src).toMatch(/participantListOpen && !chatOpen && phase !== 'complete'/);
    });

    it('chat panel render-gated by phase !== complete', () => {
      expect(src).toMatch(/chatOpen && phase !== 'complete'/);
    });

    it('reaction bar already gated by phase !== complete (pre-existing invariant)', () => {
      expect(src).toMatch(/phase !== 'complete' && phase !== 'rating' && sessionId/);
    });

    it('chat toggle button already gated by phase !== complete (pre-existing)', () => {
      expect(src).toMatch(/!chatOpen && phase !== 'complete'/);
    });

    it('host controls already gated by phase !== complete (pre-existing)', () => {
      expect(src).toMatch(/isHost && phase !== 'complete' && <HostControls/);
    });
  });
});
