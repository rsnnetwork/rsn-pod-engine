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
  describe('Bug 11 — Cam/Mic labels read from reactive hook values', () => {
    const src = readClientSource('features/live/Lobby.tsx');

    it('useLocalParticipant destructures isMicrophoneEnabled + isCameraEnabled', () => {
      // The hook is the single source of truth for the local participant's
      // track state. Pre-fix the component only pulled localParticipant out
      // and tried to subscribe to events manually, which silently failed
      // on LocalParticipant in livekit-client v2.
      expect(src).toMatch(/isMicrophoneEnabled:\s*hookMicEnabled/);
      expect(src).toMatch(/isCameraEnabled:\s*hookCamEnabled/);
    });

    it('does not register manual trackPublished listeners on LocalParticipant', () => {
      // Forbid the regression to `.on('trackPublished' as any, sync)` style.
      // The cast-to-any was the giveaway. Scope to call sites, not comments.
      expect(src).not.toMatch(/localParticipant\.on\(['"]trackPublished['"]\s*as\s+any/);
      expect(src).not.toMatch(/localParticipant\.on\(['"]trackUnpublished['"]\s*as\s+any/);
    });

    it('local state mirrors hook values via single-source useEffects', () => {
      expect(src).toMatch(/setMicEnabled\(hookMicEnabled\)/);
      expect(src).toMatch(/setCamEnabled\(hookCamEnabled\)/);
    });
  });

  describe('Bug 15 — breakout chat persists across panel close/reopen', () => {
    const panelSrc = readClientSource('features/live/ChatPanel.tsx');
    const socketSrc = readClientSource('hooks/useSessionSocket.ts');

    it('ChatPanel only fetches history when there are no scope-matching messages', () => {
      expect(panelSrc).toMatch(/haveScopeMessages/);
      expect(panelSrc).toMatch(/if\s*\(haveScopeMessages\)\s*return/);
    });

    it('chat:history handler ignores empty server replies', () => {
      expect(socketSrc).toMatch(/data\.messages\.length\s*===\s*0\)\s*return/);
    });
  });

  describe('Feature 20 — voice messages in DM via MediaRecorder + Cloudinary', () => {
    const dmService = readServerSource('services/dm/dm.service.ts');
    const dmRoute = readServerSource('routes/dm.ts');
    const cloudinaryLib = readClientSource('lib/cloudinary.ts');
    const messagesPage = readClientSource('features/messages/MessagesPage.tsx');

    it('attachment type union accepts audio on server + route', () => {
      expect(dmService).toMatch(/type:\s*['"]image['"]\s*\|\s*['"]audio['"]/);
      expect(dmRoute).toMatch(/z\.enum\(\['image',\s*'audio'\]\)/);
    });

    it('audio caption fallback in inbox preview', () => {
      expect(dmService).toMatch(/'🎤 Voice message'/);
    });

    it('client cloudinary lib exposes audio upload + validation', () => {
      expect(cloudinaryLib).toMatch(/export function validateAudioBlob/);
      expect(cloudinaryLib).toMatch(/export async function uploadAudioToCloudinary/);
      // Audio caps pinned so a future bump is intentional.
      expect(cloudinaryLib).toMatch(/MAX_AUDIO_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024/);
      expect(cloudinaryLib).toMatch(/MAX_AUDIO_DURATION_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
      // Audio uploads use /auto/upload so the same preset works for both
      // images and audio. Pin the endpoint.
      expect(cloudinaryLib).toMatch(/\/auto\/upload/);
    });

    it('MessagesPage exposes the mic button + recording state machine', () => {
      expect(messagesPage).toMatch(/data-testid=['"]dm-mic-button['"]/);
      // Three states: idle | recording | preview.
      expect(messagesPage).toMatch(/'idle'\s*\|\s*'recording'\s*\|\s*'preview'/);
      // MediaRecorder lifecycle.
      expect(messagesPage).toMatch(/new MediaRecorder/);
      expect(messagesPage).toMatch(/recorder\.start\(100\)/);
    });

    it('MessagesPage renders a recording bar with cancel + stop while recording', () => {
      expect(messagesPage).toMatch(/data-testid=['"]dm-recording-bar['"]/);
      expect(messagesPage).toMatch(/data-testid=['"]dm-recording-stop['"]/);
    });

    it('MessagesPage send mutation accepts audio and posts attachment.type=audio', () => {
      expect(messagesPage).toMatch(/uploadAudioToCloudinary\(args\.audio\.blob/);
      expect(messagesPage).toMatch(/type:\s*['"]audio['"]/);
    });

    it('MessagesPage renders <audio controls> in the bubble when attachmentType=audio', () => {
      expect(messagesPage).toMatch(/m\.attachmentType\s*===\s*['"]audio['"]/);
      expect(messagesPage).toMatch(/<audio\b[\s\S]{0,80}controls/);
    });
  });

  describe('Feature 19 — Cloudinary image attachments on DM messages', () => {
    const migration = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../db/migrations/062_direct_messages_attachments.sql'),
      'utf8',
    );
    const dmService = readServerSource('services/dm/dm.service.ts');
    const dmRoute = readServerSource('routes/dm.ts');
    const cloudinaryLib = readClientSource('lib/cloudinary.ts');
    const messagesPage = readClientSource('features/messages/MessagesPage.tsx');

    it('migration 062 adds attachment columns + content/attachment xor check', () => {
      expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS attachment_url\s+TEXT/);
      expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS attachment_type\s+TEXT/);
      expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS attachment_meta\s+JSONB/);
      expect(migration).toMatch(/CHECK[\s\S]{0,300}content[\s\S]{0,200}attachment_url/);
    });

    it('dm.service.sendMessage accepts optional attachment and enforces Cloudinary host', () => {
      expect(dmService).toMatch(/SendMessageAttachment/);
      expect(dmService).toMatch(/attachment\?:\s*SendMessageAttachment\s*\|\s*null/);
      // Defence-in-depth on the URL host.
      expect(dmService).toMatch(/res\\\.cloudinary\\\.com/);
      // INSERT writes the new columns.
      expect(dmService).toMatch(/INSERT INTO direct_messages[\s\S]{0,300}attachment_url,\s*attachment_type,\s*attachment_meta/);
    });

    it('dm.service.listConversations falls back to "📷 Photo" preview for image-only sends', () => {
      expect(dmService).toMatch(/last_attachment_type/);
      expect(dmService).toMatch(/'📷 Photo'/);
    });

    it('dm route schema makes content optional but refines content-or-attachment', () => {
      expect(dmRoute).toMatch(/content:\s*z\.string\(\)\.max\(4000\)\.optional\(\)\.default\(/);
      expect(dmRoute).toMatch(/attachment:\s*z\.object/);
      expect(dmRoute).toMatch(/\.refine\(/);
    });

    it('client cloudinary lib exposes isConfigured + validate + upload helpers', () => {
      expect(cloudinaryLib).toMatch(/export function isCloudinaryConfigured/);
      expect(cloudinaryLib).toMatch(/export function validateImageFile/);
      expect(cloudinaryLib).toMatch(/export async function uploadImageToCloudinary/);
      // 10 MB cap pinned so a future bump is intentional.
      expect(cloudinaryLib).toMatch(/MAX_IMAGE_BYTES\s*=\s*10\s*\*\s*1024\s*\*\s*1024/);
    });

    it('MessagesPage shows the image button only when Cloudinary is configured', () => {
      expect(messagesPage).toMatch(/cloudinaryReady\s*=\s*isCloudinaryConfigured\(\)/);
      expect(messagesPage).toMatch(/cloudinaryReady\s*&&\s*\(/);
      expect(messagesPage).toMatch(/data-testid=['"]dm-image-button['"]/);
    });

    it('MessagesPage send mutation uploads then POSTs with attachment payload', () => {
      expect(messagesPage).toMatch(/uploadImageToCloudinary\(args\.image\.file/);
      expect(messagesPage).toMatch(/attachment\s*=\s*\{[\s\S]{0,80}type:\s*['"]image['"]/);
    });

    it('MessagesPage renders <img> in the bubble when attachmentType is image', () => {
      expect(messagesPage).toMatch(/m\.attachmentType\s*===\s*['"]image['"]/);
      expect(messagesPage).toMatch(/<img\s+src=\{m\.attachmentUrl\}/);
    });
  });

  describe('Feature 17 + 18 — DM button navigates straight to /messages/new/:userId', () => {
    const sessionComplete = readClientSource('features/live/SessionComplete.tsx');
    const recapPage = readClientSource('features/sessions/RecapPage.tsx');
    const profile = readClientSource('features/profile/PublicProfilePage.tsx');
    const app = readClientSource('App.tsx');
    const messagesPage = readClientSource('features/messages/MessagesPage.tsx');

    it('App.tsx declares the /messages/new/:userId route', () => {
      expect(app).toMatch(/\/messages\/new\/:userId/);
    });

    it('SessionComplete + RecapPage open /messages/new/:userId directly — no prompt() flow', () => {
      // UX3 (June-10) — the helpers now open the conversation in a NEW TAB
      // (window.open) instead of navigating away from the recap, but still go
      // straight to /messages/new/:userId. The earlier prompt-then-create flow
      // is forbidden because it surfaces a jarring native dialog first.
      expect(sessionComplete).toMatch(/window\.open\(`\/messages\/new\/\$\{userId\}`/);
      expect(recapPage).toMatch(/window\.open\(`\/messages\/new\/\$\{userId\}`/);
      // Forbid the regression to the prompt() flow.
      expect(sessionComplete).not.toMatch(/prompt\(`Send your first message/);
      expect(recapPage).not.toMatch(/prompt\(`Send your first message/);
    });

    it('PublicProfilePage Message button also uses the new route + drops the prompt', () => {
      expect(profile).toMatch(/navigate\(`\/messages\/new\/\$\{userId\}`\)/);
      expect(profile).not.toMatch(/prompt\(`Send your first message/);
    });

    it('MessagesPage reads both conversationId and userId params (dual-mode)', () => {
      expect(messagesPage).toMatch(/conversationId:\s*activeId,\s*userId:\s*composeToUserId/);
    });

    it('MessagesPage compose-mode redirects to existing thread when one already exists', () => {
      // Pin the redirect side-effect — when composeToUserId is set AND
      // inboxData has a conversation with that partner, the page navigates
      // to /messages/<existing.conversationId> with replace:true so the
      // back button doesn't get stuck on /messages/new/:userId.
      expect(messagesPage).toMatch(/if\s*\(!composeToUserId\s*\|\|\s*!inboxData\)\s*return/);
      expect(messagesPage).toMatch(/inboxData\.find\(\s*c\s*=>\s*c\.otherUserId\s*===\s*composeToUserId\s*\)/);
      expect(messagesPage).toMatch(/navigate\(`\/messages\/\$\{existing\.conversationId\}`,\s*\{\s*replace:\s*true\s*\}\)/);
    });

    it('MessagesPage sendMutation POSTs to /dm/messages and replaces URL with new conv id after first send', () => {
      expect(messagesPage).toMatch(/api\.post\(['"]\/dm\/messages['"]/);
      expect(messagesPage).toMatch(/isComposeMode[\s\S]{0,200}navigate\(`\/messages\/\$\{data\.conversationId\}`/);
    });

    it('Recap row buttons keep data-testid for e2e selection', () => {
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

  describe('Bug 13 → superseded by Bug 43 (19 May Ali) — ParticipantList toggle now visible on Phase M opt-ins', () => {
    const src = readClientSource('features/live/ParticipantList.tsx');

    it('button visibility no longer gates on isViaPhaseM (director can demote any cohost)', () => {
      // Bug 43 (19 May Ali) — director's supreme-host authority
      // overrides the original Bug 13 carve-out. The Shield button is
      // now shown for every cohost row when viewer is the director,
      // including admins/super_admins who joined via Phase M opt-in.
      // toggleCohost already handles both code paths (formal removeCohost
      // socket emit + acting-as-host REST clear), so removing the
      // visibility gate is safe.
      // S12 (C1, 27 May audit) — the gate widened from director-only to
      // any acting host (isOriginalHost || isHost); the Bug 43 contract
      // (director sees it for every cohost, no isViaPhaseM gate) holds.
      expect(src).toMatch(/if\s*\(!\(isOriginalHost\s*\|\|\s*isHost\)\s*\|\|\s*isPHost\s*\|\|\s*isSelf\)\s*return\s+null/);
      // Anti-regression: the old isViaPhaseM check must NOT come back
      // as a gating condition on the visibility check.
      expect(src).not.toMatch(/\|\|\s*isViaPhaseM\)\s*return\s+null/);
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
      // Bug D (15 May Ali) — revert banner widened to also cover toggle-
      // eligible admins/super_admins (canToggleActingAsHost) so the path
      // back to host is visible even for users whose baseIsHost is false
      // but who opted in then back out. Pin the new conjunction order.
      expect(src).toMatch(
        /phase\s*!==\s*['"]complete['"]\s*&&\s*\(canToggleActingAsHost\s*\|\|\s*baseIsHost\)\s*&&\s*myActingAsHost\s*===\s*false/,
      );
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

    it('isActingHost branch references the big-tile className constant (Issue 12)', () => {
      // Issue 12 (21 May Stefan re-test) — the actual `col-span-2
      // row-span-2 aspect-video ring-2 ring-rsn-red/30` literal now
      // lives in a module-scoped constant `soloOrCompactHostTileClass`
      // so the className expression in renderTile references the
      // constant instead of the inline literal. The constant is what
      // gets pinned by phase-q-host-tile-elevation.test.ts; this test
      // confirms the renderTile branch routes through it.
      expect(src).toMatch(/useBigHostTiles\s*\?\s*soloOrCompactHostTileClass/);
      expect(src).toMatch(/soloOrCompactHostTileClass\s*=\s*['"`]aspect-video\s+col-span-2\s+row-span-2/);
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
      // 2026-06-08: HostControls is now wrapped in a SectionErrorBoundary, so
      // <HostControls no longer sits immediately after the gate — assert the
      // gate condition + that HostControls renders within it.
      expect(src).toMatch(/isHost && phase !== 'complete' &&[\s\S]{0,800}<HostControls/);
    });
  });
});
