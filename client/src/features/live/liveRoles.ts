// ─── Who a viewer is in a live event (26 Oct 2026, VID-03) ─────────────────────
//
// The client had four definitions of "host". On 25 Oct Stefan (a super_admin
// attending someone else's event) saw End Event disabled with "Only the host can
// end the event" although the server lets a super_admin end it, and the reaction
// button sat under the host bar because ReactionBar did not count him as a host.
// The rules in one place:
//   - canEndEvent, ends the event for everyone: the director, or a super_admin as
//     the override. Exactly the server's rule (host-actions.ts handleHostEnd).
//   - canManage, runs it (the host controls, start, invite, co-hosts): the
//     director, a co-host or a super_admin. This is the live page's own host rule
//     (its isHost), the set getAllHostIds folds together. The server's verifyHost
//     also lets the pod's director or creator act as a host
//     (effective-role.service canActAsHost); the live page does not know the
//     viewer's pod role, so it shows them no host controls.
// Pure, no React: LiveSessionPage computes the roles once and passes them down, and
// a component outside that path (ReactionBar) reads the same rule here.

export interface LiveRoleFacts {
  isDirector: boolean;
  isCohost: boolean;
  isSuperAdmin: boolean;
}

export interface LiveRoles extends LiveRoleFacts {
  /** Runs the event: the director, a co-host or a super_admin. */
  canManage: boolean;
  /** May end it for everyone: the director, or a super_admin. */
  canEndEvent: boolean;
}

export function liveRolesOf(facts: LiveRoleFacts): LiveRoles {
  return {
    ...facts,
    canManage: facts.isDirector || facts.isCohost || facts.isSuperAdmin,
    canEndEvent: facts.isDirector || facts.isSuperAdmin,
  };
}

/** The facts for a signed-in viewer, from the event's director and co-hosts. */
export function liveRoleFactsFor(
  viewer: { id?: string | null; role?: string | null } | null | undefined,
  directorId: string | null | undefined,
  cohosts: ReadonlySet<string>,
): LiveRoleFacts {
  const id = viewer?.id ?? null;
  return {
    isDirector: !!id && id === directorId,
    isCohost: !!id && cohosts.has(id),
    isSuperAdmin: viewer?.role === 'super_admin',
  };
}
