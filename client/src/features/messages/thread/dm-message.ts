// One message in a 1:1 conversation, as GET /dm/conversations/:id/messages answers it (newest first).
// Shared by the Messages thread and the chat panel in the call room (1 Nov 2026, T7).

import type { DmMessageKind, DmSystemMeta } from '../SystemMessageCard';

export interface DmMessage {
  id: string;
  conversationId: string;
  fromUserId: string;
  content: string;
  readAt: string | null;
  createdAt: string;
  /** A line the product wrote, not a person: drawn as one neutral card both
   *  people see the same way. Absent on rows written before 21 Sep 2026, which
   *  fall back to an ordinary bubble — their text still reads correctly. */
  kind?: DmMessageKind;
  systemMeta?: DmSystemMeta | null;
  // Phase E — server returns aggregated reactions per emoji type
  reactions?: Record<string, string[]>;
  // Feature 19 + 20 (13 May spec) — Cloudinary image / audio attachment.
  attachmentUrl?: string | null;
  attachmentType?: 'image' | 'audio' | string | null;
  attachmentMeta?: {
    width?: number; height?: number; bytes?: number; format?: string;
    durationSec?: number;
  } | null;
}
