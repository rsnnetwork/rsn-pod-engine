// Realtime architecture migration — Phase 1 scaffolding.
//
// Pins the new layer's shape without changing behaviour. Phase 1 is
// additive — no existing fanout or invalidation is removed yet.
//
// See: docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md
// for the full plan.

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
function readShared(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../shared/src', rel),
    'utf8',
  );
}
function readRepo(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../', rel), 'utf8');
}

describe('Realtime migration Phase 1 — scaffolding', () => {
  describe('Shared event contract', () => {
    const eventsSrc = readShared('types/events.ts');
    it("declares the generic 'entity:changed' server-to-client event", () => {
      expect(eventsSrc).toMatch(
        /'entity:changed':\s*\(\s*data:\s*\{\s*entities:\s*string\[\]\s*\}\s*\)\s*=>\s*void/,
      );
    });
  });

  describe('Server — emitEntities helper', () => {
    const emitSrc = readServer('realtime/emit.ts');
    const entitiesSrc = readServer('realtime/entities.ts');

    it('exports async emitEntities(io, userIds, entities)', () => {
      expect(emitSrc).toMatch(
        /export\s+async\s+function\s+emitEntities\(\s*io:[\s\S]{0,80}userIds:[\s\S]{0,80}entities:\s*string\[\]/,
      );
    });

    it('fans out to each userId via userRoom', () => {
      expect(emitSrc).toMatch(/userRoom\(userId\)/);
      expect(emitSrc).toMatch(/emit\(\s*['"]entity:changed['"]\s*,\s*\{\s*entities\s*\}/);
    });

    it('returns early on missing io / empty entities / empty recipients (no-op safety)', () => {
      expect(emitSrc).toMatch(/if\s*\(!io\)\s*return/);
      expect(emitSrc).toMatch(/entities\.length\s*===\s*0\s*\)\s*return/);
      expect(emitSrc).toMatch(/recipients\.size\s*===\s*0/);
    });

    it('entities module exports builders for every domain in ENTITIES.md', () => {
      expect(entitiesSrc).toMatch(/pod:\s*\(podId:\s*string\)\s*=>\s*`pod:\$\{podId\}`/);
      expect(entitiesSrc).toMatch(/podMembers:\s*\(podId:\s*string\)\s*=>\s*`pod:\$\{podId\}:members`/);
      expect(entitiesSrc).toMatch(/podInvites:\s*\(podId:\s*string\)\s*=>\s*`pod:\$\{podId\}:invites`/);
      expect(entitiesSrc).toMatch(/podSessions:\s*\(podId:\s*string\)\s*=>\s*`pod:\$\{podId\}:sessions`/);
      expect(entitiesSrc).toMatch(/user:\s*\(userId:\s*string\)\s*=>\s*`user:\$\{userId\}`/);
      expect(entitiesSrc).toMatch(/userInvites:\s*\(userId:\s*string\)\s*=>\s*`user:\$\{userId\}:invites`/);
      expect(entitiesSrc).toMatch(/session:\s*\(sessionId:\s*string\)\s*=>\s*`session:\$\{sessionId\}`/);
      expect(entitiesSrc).toMatch(/sessionParticipants:\s*\(sessionId:\s*string\)\s*=>/);
      expect(entitiesSrc).toMatch(/dmConversation:\s*\(convId:\s*string\)\s*=>/);
      expect(entitiesSrc).toMatch(/adminPods:\s*['"]admin:pods['"]/);
    });
  });

  describe('Client — useEntityChangedHandler', () => {
    const handlerSrc = readClient('realtime/useEntityChangedHandler.ts');
    const entitiesSrc = readClient('realtime/entities.ts');
    const appSrc = readClient('App.tsx');

    it('exports the hook and subscribes to entity:changed', () => {
      expect(handlerSrc).toMatch(/export\s+function\s+useEntityChangedHandler/);
      expect(handlerSrc).toMatch(/socket\.on\(\s*['"]entity:changed['"]/);
      expect(handlerSrc).toMatch(/socket\.off\(\s*['"]entity:changed['"]/);
    });

    it('invalidates queries via predicate matching on meta.entities', () => {
      expect(handlerSrc).toMatch(/invalidateQueries\(\{\s*predicate:/);
      expect(handlerSrc).toMatch(/query\.meta[\s\S]{0,80}entities/);
      // Predicate uses Set membership for O(1) lookup against incoming entities.
      expect(handlerSrc).toMatch(/new\s+Set\(incoming\)/);
    });

    it('is mounted at the App root', () => {
      expect(appSrc).toMatch(/import\s*\{\s*useEntityChangedHandler\s*\}\s*from\s*['"]@\/realtime\/useEntityChangedHandler['"]/);
      expect(appSrc).toMatch(/useEntityChangedHandler\(\);/);
    });

    it('client entities mirror server entities (same string shapes)', () => {
      expect(entitiesSrc).toMatch(/pod:\s*\(podId:\s*string\)\s*=>\s*`pod:\$\{podId\}`/);
      expect(entitiesSrc).toMatch(/sessionParticipants:\s*\(sessionId:\s*string\)\s*=>\s*`session:\$\{sessionId\}:participants`/);
      expect(entitiesSrc).toMatch(/adminPods:\s*['"]admin:pods['"]/);
    });
  });

  describe('ENTITIES.md exists at repo root and documents the contract', () => {
    const md = readRepo('ENTITIES.md');
    it('lists every entity from the plan', () => {
      expect(md).toMatch(/pod:<podId>:members/);
      expect(md).toMatch(/pod:<podId>:invites/);
      expect(md).toMatch(/user:<userId>:invites/);
      expect(md).toMatch(/session:<sessionId>:participants/);
      expect(md).toMatch(/dm-conversation:<convId>/);
      expect(md).toMatch(/admin:violations/);
    });
    it('documents the rules', () => {
      expect(md).toMatch(/Every realtime-relevant `useQuery` declares `meta\.entities`/);
      expect(md).toMatch(/Every mutation route ends with `emitEntities/);
    });
  });
});
