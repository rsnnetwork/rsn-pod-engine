// ─── An event guest's socket may not use direct messages (Part 2, Task 3, 10 Nov 2026) ─────────────────────
//
// A guest (users.account_kind = 'event_guest') keeps a socket for the event they are at: its live room, its chat,
// its presence. Direct messages are for members, as /api/dm is (guest-scope.ts), so dm:send, dm:read, dm:react and
// dm:unreact from a guest's socket answer `error { code: 'GUEST_MEMBERSHIP_REQUIRED' }` and do nothing.

import { Server as SocketServer, Socket } from 'socket.io';
import { ErrorCodes } from '@rsn/shared';
import { readAccountGate } from '../../../middleware/auth';
import { ACCOUNT_KIND_UNAVAILABLE_MESSAGE, GUEST_MEMBERSHIP_MESSAGE } from '../../../middleware/guest-scope';

/**
 * Whether this socket belongs to an event guest; if so the refusal has been sent to it. The kind was read from the
 * database at the handshake (socket.data.accountKind). A socket not marked 'member' asks the account gate again
 * (cached for 60 s), so a guest promoted to member since, or a member whose handshake met a database error, is let
 * through without reconnecting. Anything but a member reading is refused: as a guest only when the database says
 * 'event_guest', otherwise (the kind could not be read) with SERVICE_UNAVAILABLE, to try again.
 */
export async function refuseGuestSocket(socket: Socket): Promise<boolean> {
  if (socket.data.accountKind === 'member') return false;
  const gate = await readAccountGate(socket.data.userId);
  if (gate.kind === 'member') {
    socket.data.accountKind = 'member';
    return false;
  }
  socket.emit('error', gate.kindUnknown
    ? { code: ErrorCodes.SERVICE_UNAVAILABLE, message: ACCOUNT_KIND_UNAVAILABLE_MESSAGE }
    : { code: ErrorCodes.GUEST_MEMBERSHIP_REQUIRED, message: GUEST_MEMBERSHIP_MESSAGE });
  return true;
}

/** Run a dm:* handler for a member's socket only (refuseGuestSocket). */
export async function runMemberDmEvent<T>(
  io: SocketServer,
  socket: Socket,
  data: T,
  handler: (io: SocketServer, socket: Socket, data: T) => Promise<void>,
): Promise<void> {
  if (await refuseGuestSocket(socket)) return;
  await handler(io, socket, data);
}
