// ─── Host Control Center ───────────────────────────────────────────────────
//
// Phase 7C.1 (7 May spec, Stefan #3 + #11) — full-screen drawer that
// gives the host an authoritative view of EVERY person in the event,
// what state they're in, and per-row actions to fix anything off.
//
// Stefan #3: "When matching round 4 of 5, system did not match a few
//   participants without telling host or them. Host had no way to see
//   what was happening with each person."
// Stefan #11: "Need a single 'Control Center' that shows host every
//   person, their status, and per-person actions in one place."
//
// Data source: roundDashboard.participants — populated by every
// host:round_dashboard emit on the server (matching-flow.ts), so the
// list refreshes on the same cadence as room status changes. The
// server is canonical; this component renders, doesn't compute.
//
// Per-row actions wire to existing socket events (no new endpoints):
//   - host:assign_cohost   — promote a participant to co-host
//   - host:remove_cohost   — demote a co-host back to participant
//   - host:reassign        — pull someone out of their room and re-match
//   - host:move_to_room    — force into a specific active room
//   - host:remove_participant  — kick from event

import { useMemo, useState, useEffect, useRef, type ReactNode } from 'react';
import { Rnd } from 'react-rnd';
import { Button } from '@/components/ui/Button';
import { useSessionStore } from '@/stores/sessionStore';
import { getSocket } from '@/lib/socket';
import {
  X,
  Crown,
  Shield,
  User as UserIcon,
  Wifi,
  WifiOff,
  DoorOpen,
  Sofa,
  Users,
  ChevronRight,
  AlertTriangle,
  Filter,
  RefreshCw,
  Minus,
  Square,
  Copy,
} from 'lucide-react';
import { useActionLock } from '@/hooks/useActionLock';
import { useEscapeKey } from '@/hooks/useEscapeKey';

// 9 May iter (revised) — windowed Control Center on desktop with drag,
// resize, minimize, maximize. Default size is intentionally LARGE so
// the whole panel (counts row + participants list + rooms pane) is
// visible without the host needing to drag or resize first. Per Ali:
// "open it in the center of the screen where the host doesn't need to
// drag to see everything — but dragging, minimize, maximize must
// still be there as options." Mobile keeps the full-screen drawer.
const HCC_WINDOW_KEY = 'rsn:hcc-window';
// Default sizes pulled to fill ~92vw × 88vh (capped at 1280×900) the
// first time the panel opens. Once the user resizes, localStorage
// remembers it.
const HCC_DEFAULT_W = 1280;
const HCC_DEFAULT_H = 900;
const HCC_MIN_W = 480;
const HCC_MIN_H = 360;
const HCC_DESKTOP_BREAKPOINT_PX = 768;

interface PersistedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function readPersistedBounds(): PersistedBounds | null {
  try {
    const raw = localStorage.getItem(HCC_WINDOW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.x === 'number' &&
      typeof parsed?.y === 'number' &&
      typeof parsed?.width === 'number' &&
      typeof parsed?.height === 'number'
    ) return parsed;
  } catch { /* ignore */ }
  return null;
}

function writePersistedBounds(b: PersistedBounds): void {
  try { localStorage.setItem(HCC_WINDOW_KEY, JSON.stringify(b)); } catch { /* ignore */ }
}

interface Props {
  sessionId: string;
  open: boolean;
  onClose: () => void;
  // Phase 8C.1 (8 May spec) — Stefan #5: secondary actions live here now
  // instead of cluttering the main host bar. HostControls passes these
  // callbacks; HCC renders the "Actions" strip that triggers them.
  onOpenInvite?: () => void;
  onOpenRoomCreate?: () => void;
  onOpenBroadcast?: () => void;
  onBulkExtend?: () => void;
  onBulkEnd?: () => void;
  onBulkSetDuration?: () => void;
  bulkActionsAvailable?: boolean;
  inviteAvailable?: boolean;
}

type StateFilter =
  | 'all'
  | 'in_main_room'
  | 'in_room'
  | 'disconnected'
  | 'left';

const STATE_LABEL: Record<StateFilter, string> = {
  all: 'All',
  in_main_room: 'In main room',
  in_room: 'In a room',
  disconnected: 'Disconnected',
  left: 'Left',
};

export default function HostControlCenter({
  sessionId,
  open,
  onClose,
  onOpenInvite,
  onOpenRoomCreate,
  onOpenBroadcast,
  onBulkExtend,
  onBulkEnd,
  onBulkSetDuration,
  bulkActionsAvailable = false,
  inviteAvailable = false,
}: Props) {
  const roundDashboard = useSessionStore((s) => s.roundDashboard);
  const hostUserId = useSessionStore((s) => s.hostUserId);
  const socket = getSocket();
  const [filter, setFilter] = useState<StateFilter>('all');
  const [moveTargetUserId, setMoveTargetUserId] = useState<string | null>(null);
  const { runLocked } = useActionLock();

  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.innerWidth < HCC_DESKTOP_BREAKPOINT_PX
  );
  // Default-large bounds: fill ~92vw × 88vh capped at 1280×900, centred.
  // Persisted bounds win after the user resizes/moves once.
  const [bounds, setBounds] = useState<PersistedBounds>(() => {
    const persisted = readPersistedBounds();
    if (persisted) return persisted;
    if (typeof window === 'undefined') {
      return { x: 100, y: 100, width: HCC_DEFAULT_W, height: HCC_DEFAULT_H };
    }
    const w = Math.min(HCC_DEFAULT_W, Math.floor(window.innerWidth * 0.92));
    const h = Math.min(HCC_DEFAULT_H, Math.floor(window.innerHeight * 0.88));
    return {
      x: Math.max(8, Math.floor((window.innerWidth - w) / 2)),
      y: Math.max(8, Math.floor((window.innerHeight - h) / 2)),
      width: w,
      height: h,
    };
  });
  const [isMaximized, setIsMaximized] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const preMaxBoundsRef = useRef<PersistedBounds | null>(null);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < HCC_DESKTOP_BREAKPOINT_PX);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Reset filter when drawer opens — small UX nicety so the host doesn't
  // open a stale "Disconnected" filter from the last session.
  useEffect(() => {
    if (open) setFilter('all');
  }, [open]);

  // Phase 8B.2 — Esc closes the Move-to-room sub-modal AND the
  // Control Center itself when in window/drawer mode.
  useEscapeKey(() => setMoveTargetUserId(null), moveTargetUserId !== null);
  useEscapeKey(onClose, open && moveTargetUserId === null);

  // Phase 7-audit fix — when the server's helper throws, the dashboard
  // emit carries participants=[]. Showing an empty list misleads the
  // host into thinking nobody's here. Keep the last non-empty list as
  // a fallback so the drawer survives a single-emit hiccup.
  const lastParticipantsRef = useRef<NonNullable<typeof roundDashboard>['participants']>(undefined);
  const incomingParticipants = roundDashboard?.participants;
  if (incomingParticipants && incomingParticipants.length > 0) {
    lastParticipantsRef.current = incomingParticipants;
  }
  const participants = (incomingParticipants && incomingParticipants.length > 0)
    ? incomingParticipants
    : (lastParticipantsRef.current ?? []);
  const rooms = roundDashboard?.rooms ?? [];

  const counts = useMemo(() => {
    const c = {
      total: participants.length,
      host: 0,
      cohost: 0,
      in_main_room: 0,
      in_room: 0,
      disconnected: 0,
      left: 0,
    };
    for (const p of participants) {
      if (p.role === 'host') c.host += 1;
      else if (p.role === 'cohost') c.cohost += 1;
      if (p.state === 'in_main_room') c.in_main_room += 1;
      else if (p.state === 'in_room') c.in_room += 1;
      else if (p.state === 'disconnected') c.disconnected += 1;
      else if (p.state === 'left') c.left += 1;
    }
    return c;
  }, [participants]);

  const visibleParticipants = useMemo(() => {
    if (filter === 'all') return participants;
    return participants.filter((p) => p.state === filter);
  }, [participants, filter]);

  const moveTargetUser = participants.find((p) => p.userId === moveTargetUserId) || null;
  const activeRoomsForMove = rooms.filter((r) => r.status === 'active');

  if (!open) return null;

  // ── Action wiring ─────────────────────────────────────────────────────
  const makeCohost = (userId: string) =>
    runLocked(`make_cohost:${userId}`, () => {
      socket?.emit('host:assign_cohost', { sessionId, userId, role: 'co_host' });
    });
  const removeCohost = (userId: string) =>
    runLocked(`remove_cohost:${userId}`, () => {
      socket?.emit('host:remove_cohost', { sessionId, userId });
    });
  // Phase 7-audit fix — confirm() lives outside runLocked so a Cancel
  // doesn't burn the lock on a no-op. Lock acquisition only happens
  // when the user actually committed to the action.
  const reassign = (userId: string) => {
    if (!confirm('Pull this person out of their current spot and re-match them?')) return;
    runLocked(`reassign:${userId}`, () => {
      socket?.emit('host:reassign', { sessionId, participantId: userId });
    });
  };
  const kick = (userId: string, displayName: string) => {
    if (!confirm(`Remove ${displayName} from the event? They'll be disconnected immediately.`)) return;
    runLocked(`kick:${userId}`, () => {
      socket?.emit('host:remove_participant', { sessionId, userId, reason: 'host_removed' });
    });
  };
  const moveToRoom = (userId: string, targetMatchId: string) =>
    runLocked(`move_to_room:${userId}`, () => {
      socket?.emit('host:move_to_room', { sessionId, userId, targetMatchId });
      setMoveTargetUserId(null);
    });
  const extendRoom = (matchId: string) =>
    runLocked(`extend_room:${matchId}`, () => {
      socket?.emit('host:extend_breakout_room' as any, { sessionId, matchId, additionalSeconds: 120 });
    });

  // ── Window controls ───────────────────────────────────────────────────
  const toggleMaximize = () => {
    if (isMaximized) {
      const restored = preMaxBoundsRef.current ?? bounds;
      setBounds(restored);
      writePersistedBounds(restored);
      setIsMaximized(false);
    } else {
      preMaxBoundsRef.current = bounds;
      setBounds({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
      setIsMaximized(true);
    }
  };
  const minimize = () => setIsMinimized(true);
  const restoreFromMinimize = () => setIsMinimized(false);

  // ── Title bar — drag handle (hcc-drag-handle) + window controls ───────
  const titleBar: ReactNode = (
    <div className="hcc-drag-handle cursor-move bg-white border-b border-gray-200 px-4 py-2.5 flex items-center justify-between select-none">
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-rsn-red" />
        <h2 className="text-sm font-semibold text-gray-900">Host Control Center</h2>
      </div>
      <div className="flex items-center gap-0.5 hcc-window-controls">
        {!isMobile && (
          <>
            <button
              onClick={minimize}
              className="p-1.5 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
              aria-label="Minimize"
              title="Minimize"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={toggleMaximize}
              className="p-1.5 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
              aria-label={isMaximized ? 'Restore' : 'Maximize'}
              title={isMaximized ? 'Restore' : 'Maximize'}
            >
              {isMaximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
            </button>
          </>
        )}
        <button
          onClick={onClose}
          className="p-1.5 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
          aria-label="Close Control Center"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  const bodyContent: ReactNode = (
    <div className="flex flex-col h-full overflow-hidden">
        {/* Phase 8C.1 (8 May spec) — Actions strip. Stefan #5: secondary
            host actions live here now (not in the bottom bar) so the
            host has ONE operational surface for event management. */}
        <div data-section="actions" className="border-b border-gray-200 bg-white px-5 py-3 shrink-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-gray-400 mr-1">Actions</span>
            {inviteAvailable && onOpenInvite && (
              <button onClick={() => { onOpenInvite(); onClose(); }} className="text-xs px-2.5 py-1 rounded-md border border-gray-200 text-gray-700 hover:bg-gray-50">
                Invite
              </button>
            )}
            {onOpenRoomCreate && (
              <button onClick={() => { onOpenRoomCreate(); onClose(); }} className="text-xs px-2.5 py-1 rounded-md border border-gray-200 text-gray-700 hover:bg-gray-50">
                Create rooms
              </button>
            )}
            {onOpenBroadcast && (
              <button onClick={() => { onOpenBroadcast(); onClose(); }} className="text-xs px-2.5 py-1 rounded-md border border-gray-200 text-gray-700 hover:bg-gray-50">
                Broadcast
              </button>
            )}
            {bulkActionsAvailable && onBulkExtend && (
              <button onClick={onBulkExtend} className="text-xs px-2.5 py-1 rounded-md border border-gray-200 text-gray-700 hover:bg-gray-50">
                +2 min all rooms
              </button>
            )}
            {bulkActionsAvailable && onBulkSetDuration && (
              <button onClick={() => { onBulkSetDuration(); onClose(); }} className="text-xs px-2.5 py-1 rounded-md border border-gray-200 text-gray-700 hover:bg-gray-50">
                Set duration
              </button>
            )}
            {bulkActionsAvailable && onBulkEnd && (
              <button onClick={onBulkEnd} className="text-xs px-2.5 py-1 rounded-md border border-red-200 text-red-700 hover:bg-red-50">
                End all rooms
              </button>
            )}
          </div>
        </div>
        {/* Counts row */}
        <div className="border-b border-gray-200 bg-gray-50 px-5 py-3 shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <CountChip
              label="All"
              count={counts.total}
              active={filter === 'all'}
              onClick={() => setFilter('all')}
            />
            <CountChip
              label="In main room"
              count={counts.in_main_room}
              active={filter === 'in_main_room'}
              onClick={() => setFilter('in_main_room')}
              tone="blue"
            />
            <CountChip
              label="In a room"
              count={counts.in_room}
              active={filter === 'in_room'}
              onClick={() => setFilter('in_room')}
              tone="emerald"
            />
            <CountChip
              label="Disconnected"
              count={counts.disconnected}
              active={filter === 'disconnected'}
              onClick={() => setFilter('disconnected')}
              tone="red"
            />
            <CountChip
              label="Left"
              count={counts.left}
              active={filter === 'left'}
              onClick={() => setFilter('left')}
              tone="gray"
            />
            <span className="ml-auto text-[11px] text-gray-500 flex items-center gap-1">
              <Crown className="h-3 w-3 text-amber-500" />
              {counts.host} host · {counts.cohost} co-host{counts.cohost !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {/* Phase 7-audit fix — single column on tablet (md), 3-col only at lg+.
            Phase D2 (10 May spec) — added min-h-0 (critical for nested
            flexbox to shrink the grid below the parent's height) and pb-12
            on the participants <ul> so the last row isn't visually clipped
            by the bottom edge of the modal. Stefan #8: he couldn't see the
            last user in the control center on his standard window size. */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-0 lg:divide-x divide-gray-200 flex-1 min-h-0 overflow-y-auto">
          {/* Participants list */}
          <div className="lg:col-span-2 min-h-[300px]">
            <div className="px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 flex items-center gap-1.5">
              <Filter className="h-3 w-3" /> {STATE_LABEL[filter]}
              <span className="text-gray-400 normal-case font-normal">
                ({visibleParticipants.length})
              </span>
            </div>
            {visibleParticipants.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-gray-500">
                No participants in this view.
              </div>
            ) : (
              <ul className="divide-y divide-gray-100 pb-12">
                {visibleParticipants.map((p) => (
                  <li key={p.userId} className="px-5 py-3 hover:bg-gray-50">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        <RoleBadge role={p.role} />
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900 truncate">
                            {p.displayName}
                            {p.userId === hostUserId && (
                              <span className="ml-1.5 text-[10px] uppercase tracking-wide text-amber-600">
                                you
                              </span>
                            )}
                          </div>
                          {p.email && (
                            <div className="text-xs text-gray-500 truncate">{p.email}</div>
                          )}
                          <StateBadge state={p.state} matchId={p.currentMatchId} />
                        </div>
                      </div>
                      {p.userId !== hostUserId && (
                        <RowActions
                          isCohost={p.role === 'cohost'}
                          state={p.state}
                          onMakeCohost={() => makeCohost(p.userId)}
                          onRemoveCohost={() => removeCohost(p.userId)}
                          onReassign={() => reassign(p.userId)}
                          onMoveToRoom={() => setMoveTargetUserId(p.userId)}
                          onKick={() => kick(p.userId, p.displayName)}
                          activeRoomsAvailable={activeRoomsForMove.length > 0}
                        />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Rooms pane */}
          <div className="bg-gray-50 min-h-[300px]">
            <div className="px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 flex items-center gap-1.5">
              <DoorOpen className="h-3 w-3" /> Rooms ({activeRoomsForMove.length})
            </div>
            {activeRoomsForMove.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-gray-500">
                No active rooms.
              </div>
            ) : (
              <ul className="px-3 pb-4 space-y-2">
                {activeRoomsForMove.map((r) => (
                  <li
                    key={r.matchId}
                    className="bg-white rounded-lg border border-gray-200 p-3"
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="text-xs font-medium text-gray-700 flex items-center gap-1.5">
                        {r.isManual ? (
                          <span className="text-purple-600">Manual</span>
                        ) : (
                          <span className="text-emerald-600">Algorithm</span>
                        )}
                        <span className="text-gray-400">·</span>
                        <span>{r.participants.length} people</span>
                        {r.isTrio && (
                          <span className="text-[10px] bg-blue-100 text-blue-700 rounded px-1.5 py-0.5">
                            Trio
                          </span>
                        )}
                      </div>
                      {r.isManual && (
                        <button
                          onClick={() => extendRoom(r.matchId)}
                          className="text-[11px] text-gray-500 hover:text-emerald-700 flex items-center gap-1"
                          title="Add 2 minutes to this room"
                        >
                          <RefreshCw className="h-3 w-3" /> +2 min
                        </button>
                      )}
                    </div>
                    <div className="space-y-1">
                      {r.participants.map((rp) => (
                        <div
                          key={rp.userId}
                          className="flex items-center gap-2 text-xs text-gray-700"
                        >
                          {rp.isConnected ? (
                            <Wifi className="h-3 w-3 text-emerald-500 shrink-0" />
                          ) : (
                            <WifiOff className="h-3 w-3 text-red-500 shrink-0" />
                          )}
                          <span className="truncate">{rp.displayName}</span>
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

    </div>
  );

  // Move-to-room sub-modal — rendered alongside the window/drawer.
  const subModal: ReactNode = moveTargetUser && (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
      onClick={() => setMoveTargetUserId(null)}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-gray-900 mb-1">
          Move {moveTargetUser.displayName} to a room
        </h3>
        <p className="text-xs text-gray-500 mb-3">
          The current room they're in (if any) will end immediately for them.
        </p>
        {activeRoomsForMove.length === 0 ? (
          <p className="text-sm text-gray-500 py-4 text-center">
            No active rooms to move into.
          </p>
        ) : (
          <ul className="space-y-1.5 max-h-64 overflow-y-auto">
            {activeRoomsForMove
              .filter((r) => !r.participants.some((rp) => rp.userId === moveTargetUserId))
              .map((r) => (
                <li key={r.matchId}>
                  <button
                    onClick={() => moveToRoom(moveTargetUser.userId, r.matchId)}
                    className="w-full text-left px-3 py-2 rounded-lg border border-gray-200 hover:border-emerald-400 hover:bg-emerald-50 text-sm transition-colors flex items-center justify-between"
                  >
                    <span className="truncate text-gray-800">
                      {r.participants.map((rp) => rp.displayName).join(', ')}
                    </span>
                    <ChevronRight className="h-4 w-4 text-gray-400 shrink-0" />
                  </button>
                </li>
              ))}
          </ul>
        )}
        <div className="flex justify-end mt-4">
          <Button size="sm" variant="ghost" onClick={() => setMoveTargetUserId(null)}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );

  // ── Render ────────────────────────────────────────────────────────────

  // Minimized — small floating pill bottom-right; click to restore.
  if (isMinimized) {
    return (
      <button
        onClick={restoreFromMinimize}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 bg-rsn-red text-white rounded-full shadow-lg px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
        aria-label="Restore Host Control Center"
      >
        <Users className="h-4 w-4" /> Control Center
      </button>
    );
  }

  // Mobile — full-screen drawer with backdrop (window mode is desktop-only).
  if (isMobile) {
    return (
      <div className="fixed inset-0 z-40 flex">
        <div
          className="absolute inset-0 bg-black/40 backdrop-blur-sm"
          onClick={onClose}
          aria-hidden="true"
        />
        <div className="relative ml-auto w-full bg-white shadow-2xl h-full flex flex-col">
          {titleBar}
          {bodyContent}
        </div>
        {subModal}
      </div>
    );
  }

  // Desktop — drag/resize window with backdrop. Default size large
  // (~92vw × 88vh, centred) so the host sees the whole view without
  // having to drag or resize. Drag handle = the title bar.
  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <Rnd
        bounds="window"
        minWidth={HCC_MIN_W}
        minHeight={HCC_MIN_H}
        size={{ width: bounds.width, height: bounds.height }}
        position={{ x: bounds.x, y: bounds.y }}
        onDragStop={(_e, d) => {
          const next = { ...bounds, x: d.x, y: d.y };
          setBounds(next);
          if (!isMaximized) writePersistedBounds(next);
        }}
        onResizeStop={(_e, _dir, ref, _delta, position) => {
          const next = {
            x: position.x,
            y: position.y,
            width: ref.offsetWidth,
            height: ref.offsetHeight,
          };
          setBounds(next);
          if (!isMaximized) writePersistedBounds(next);
        }}
        dragHandleClassName="hcc-drag-handle"
        disableDragging={isMaximized}
        enableResizing={!isMaximized}
        className="z-40 bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden flex flex-col"
      >
        {titleBar}
        {bodyContent}
      </Rnd>
      {subModal}
    </>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function CountChip({
  label,
  count,
  active,
  onClick,
  tone = 'gray',
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone?: 'gray' | 'blue' | 'emerald' | 'red';
}) {
  const inactiveClass =
    tone === 'blue'
      ? 'border-blue-200 text-blue-700'
      : tone === 'emerald'
      ? 'border-emerald-200 text-emerald-700'
      : tone === 'red'
      ? 'border-red-200 text-red-700'
      : 'border-gray-200 text-gray-700';
  const activeClass =
    tone === 'blue'
      ? 'bg-blue-100 border-blue-400 text-blue-800'
      : tone === 'emerald'
      ? 'bg-emerald-100 border-emerald-400 text-emerald-800'
      : tone === 'red'
      ? 'bg-red-100 border-red-400 text-red-800'
      : 'bg-gray-200 border-gray-400 text-gray-900';
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition-colors ${
        active ? activeClass : inactiveClass + ' hover:bg-gray-50'
      }`}
    >
      {label}
      <span
        className={`px-1.5 py-px rounded-full text-[10px] font-semibold bg-white/70 ${
          active ? 'text-gray-900' : 'text-gray-700'
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function RoleBadge({ role }: { role: 'host' | 'cohost' | 'participant' }) {
  if (role === 'host') {
    return (
      <div
        className="h-8 w-8 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center shrink-0"
        title="Host — runs the event, generates rounds, ends the session"
      >
        <Crown className="h-4 w-4" />
      </div>
    );
  }
  if (role === 'cohost') {
    // Phase 7C.2 — permissions tooltip on hover (Stefan #7 UX half).
    // Cohosts can: see the Control Center, run breakout rooms, broadcast
    // announcements. They CANNOT: end the session, change session config.
    // Excluded from matching by default.
    return (
      <div
        className="h-8 w-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center shrink-0"
        title="Co-host — can run rounds, manage breakouts, broadcast. Excluded from matching."
      >
        <Shield className="h-4 w-4" />
      </div>
    );
  }
  return (
    <div className="h-8 w-8 rounded-full bg-gray-100 text-gray-500 flex items-center justify-center shrink-0">
      <UserIcon className="h-4 w-4" />
    </div>
  );
}

function StateBadge({
  state,
  matchId,
}: {
  state: 'in_main_room' | 'in_room' | 'disconnected' | 'left';
  matchId: string | null;
}) {
  const map: Record<typeof state, { label: string; cls: string; Icon: any }> = {
    in_main_room: {
      label: 'In main room',
      cls: 'bg-blue-50 text-blue-700 border-blue-200',
      Icon: Sofa,
    },
    in_room: {
      label: matchId ? `In a room` : 'In a room',
      cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      Icon: DoorOpen,
    },
    disconnected: {
      label: 'Disconnected',
      cls: 'bg-red-50 text-red-700 border-red-200',
      Icon: WifiOff,
    },
    left: {
      label: 'Left',
      cls: 'bg-gray-100 text-gray-600 border-gray-200',
      Icon: AlertTriangle,
    },
  };
  const { label, cls, Icon } = map[state];
  return (
    <span
      className={`mt-1 inline-flex items-center gap-1 text-[11px] border rounded-full px-2 py-0.5 ${cls}`}
    >
      <Icon className="h-3 w-3" /> {label}
    </span>
  );
}

function RowActions({
  isCohost,
  state,
  onMakeCohost,
  onRemoveCohost,
  onReassign,
  onMoveToRoom,
  onKick,
  activeRoomsAvailable,
}: {
  isCohost: boolean;
  state: 'in_main_room' | 'in_room' | 'disconnected' | 'left';
  onMakeCohost: () => void;
  onRemoveCohost: () => void;
  onReassign: () => void;
  onMoveToRoom: () => void;
  onKick: () => void;
  activeRoomsAvailable: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
      {/* Phase 7-audit fix — allow promoting/demoting a recently disconnected
          participant. The host might want to assign co-host preemptively
          before the user reconnects (e.g. a known co-host whose Wi-Fi
          dropped). Server-side state checks still gate the action. */}
      {state !== 'left' && (
        isCohost ? (
          <ActionButton onClick={onRemoveCohost} title="Remove co-host role">
            Remove co-host
          </ActionButton>
        ) : (
          <ActionButton onClick={onMakeCohost} title="Make this person a co-host">
            Make co-host
          </ActionButton>
        )
      )}
      {state === 'in_room' && (
        <ActionButton onClick={onReassign} title="Pull out of current room and re-match">
          Re-match
        </ActionButton>
      )}
      {state !== 'left' && activeRoomsAvailable && (
        <ActionButton onClick={onMoveToRoom} title="Force into a specific active room">
          Move to room…
        </ActionButton>
      )}
      {state !== 'left' && (
        <ActionButton onClick={onKick} title="Remove from the event" tone="danger">
          Kick
        </ActionButton>
      )}
    </div>
  );
}

function ActionButton({
  onClick,
  children,
  title,
  tone = 'normal',
}: {
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  tone?: 'normal' | 'danger';
}) {
  const cls =
    tone === 'danger'
      ? 'border-red-200 text-red-700 hover:bg-red-50'
      : 'border-gray-200 text-gray-700 hover:bg-gray-50';
  return (
    <button
      onClick={onClick}
      title={title}
      className={`text-[11px] px-2 py-1 rounded-md border transition-colors ${cls}`}
    >
      {children}
    </button>
  );
}
