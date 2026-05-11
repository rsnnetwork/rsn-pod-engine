// Phase G — host visibility modes (10 May review item 11).
//
// Verifies the new feature foundation: data model + REST endpoint +
// socket broadcast + snapshot propagation + client store wiring.
//
// Modes: big_speaker | normal | producer | hidden.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}

describe('Phase G — host visibility modes (item 11)', () => {
  describe('data model — migration 059', () => {
    const sql = readServer('db/migrations/059_host_visibility_modes.sql');

    it('creates host_visibility_mode enum with the four modes', () => {
      expect(sql).toMatch(/CREATE\s+TYPE\s+host_visibility_mode\s+AS\s+ENUM\s*\(\s*'big_speaker'\s*,\s*'normal'\s*,\s*'producer'\s*,\s*'hidden'\s*\)/i);
    });

    it('adds visibility_mode column to session_cohosts (NOT NULL DEFAULT normal)', () => {
      expect(sql).toMatch(/ALTER\s+TABLE\s+session_cohosts\s+ADD\s+COLUMN\s+visibility_mode\s+host_visibility_mode\s+NOT\s+NULL\s+DEFAULT\s+'normal'/i);
    });

    it('adds host_visibility_mode column to sessions (NOT NULL DEFAULT normal)', () => {
      expect(sql).toMatch(/ALTER\s+TABLE\s+sessions\s+ADD\s+COLUMN\s+host_visibility_mode\s+host_visibility_mode\s+NOT\s+NULL\s+DEFAULT\s+'normal'/i);
    });
  });

  describe('server — setHostVisibility service', () => {
    const src = readServer('services/orchestration/handlers/host-actions.ts');

    it('exports setHostVisibility + re-exports HostVisibilityMode type from shared', () => {
      expect(src).toMatch(/export async function setHostVisibility\(/);
      // Phase H — HostVisibilityMode now lives in @rsn/shared and is re-
      // exported here for backward compat. Accept either the original local
      // definition or the re-export form.
      expect(src).toMatch(/export type \{?\s*HostVisibilityMode|export type HostVisibilityMode/);
      // The shared definition exists.
      const sharedSrc = readServer('../../shared/src/types/session.ts');
      expect(sharedSrc).toMatch(/export type HostVisibilityMode\s*=\s*['"]big_speaker['"][\s\S]*?['"]hidden['"]/);
    });

    it('uses canActAsHost for authorisation (not original-host-only)', () => {
      const fnStart = src.indexOf('export async function setHostVisibility');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/canActAsHost/);
    });

    it('updates the right column based on whether target is host or co-host', () => {
      const fnStart = src.indexOf('export async function setHostVisibility');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/UPDATE sessions SET host_visibility_mode/);
      expect(fn).toMatch(/UPDATE session_cohosts SET visibility_mode/);
    });

    it('emits host:visibility_changed to the session room', () => {
      const fnStart = src.indexOf('export async function setHostVisibility');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/_io\.to\(sessionRoom\(sessionId\)\)\.emit\(['"]host:visibility_changed['"]/);
    });
  });

  describe('server — REST route POST /sessions/:id/host/visibility', () => {
    const src = readServer('routes/host.ts');

    it('declares the route with zod validation for { userId, mode }', () => {
      expect(src).toMatch(/['"]\/:id\/host\/visibility['"]/);
      expect(src).toMatch(/visibilitySchema\s*=\s*z\.object/);
      expect(src).toMatch(/mode:\s*z\.enum\(\['big_speaker',\s*'normal',\s*'producer',\s*'hidden'\]\)/);
    });

    it('delegates to orchestrationService.setHostVisibility', () => {
      expect(src).toMatch(/orchestrationService\.setHostVisibility\(/);
    });
  });

  describe('snapshot — hostVisibilityModes propagated to clients', () => {
    const src = readServer('services/session/session-state-snapshot.service.ts');

    it('SessionStateSnapshot interface declares hostVisibilityModes', () => {
      expect(src).toMatch(/hostVisibilityModes:\s*Record<string,\s*string>/);
    });

    it('snapshot pulls cohost visibility_mode + reuses host visibility from session row', () => {
      // Co-host visibility comes from the session_cohosts query (extended).
      expect(src).toMatch(/SELECT\s+user_id,\s+visibility_mode\s+FROM\s+session_cohosts/);
      // Original host's visibility piggybacks on the session row that's already
      // fetched at the top of buildSessionStateSnapshot — no extra query.
      expect(src).toMatch(/session as any\)\.hostVisibilityMode/);
    });

    it('SESSION_COLUMNS includes host_visibility_mode so the existing session-row fetch carries it', () => {
      const ssvc = readServer('services/session/session.service.ts');
      const cols = ssvc.match(/const\s+SESSION_COLUMNS\s*=\s*`[\s\S]+?`/);
      expect(cols).toBeTruthy();
      expect(cols![0]).toMatch(/host_visibility_mode\s+AS\s+"hostVisibilityMode"/);
    });
  });

  describe('client — store + socket wiring', () => {
    const storeSrc = readClient('stores/sessionStore.ts');
    const sockSrc = readClient('hooks/useSessionSocket.ts');

    it('sessionStore declares hostVisibilityModes record + setters', () => {
      expect(storeSrc).toMatch(/hostVisibilityModes:\s*Record<string,/);
      expect(storeSrc).toMatch(/setHostVisibility:\s*\(userId/);
      expect(storeSrc).toMatch(/setHostVisibilityModes:\s*\(modes/);
    });

    it('useSessionSocket listens for host:visibility_changed and applies snapshot field', () => {
      expect(sockSrc).toMatch(/socket\.on\(['"]host:visibility_changed['"]/);
      expect(sockSrc).toMatch(/store\.setHostVisibility\(data\.userId,\s*data\.mode\)/);
      expect(sockSrc).toMatch(/store\.setHostVisibilityModes\(data\.hostVisibilityModes\)/);
    });
  });
});
