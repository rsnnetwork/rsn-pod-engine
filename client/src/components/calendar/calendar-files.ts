// Where "Add to calendar" gets a 1:1 meeting's .ics (1 Nov 2026, T7). The file carries the identity and SEQUENCE of
// the emailed invite, so adding it updates the entry the email made instead of adding a second one.

import api from '@/lib/api';

/** One meeting's own file: a card for an earlier meeting adds that meeting, not the conversation's current one. */
export function meetingFile(meetingId: string): () => Promise<Blob> {
  return () => api.get(`/meetings/${encodeURIComponent(meetingId)}/calendar.ics`, { responseType: 'blob' }).then((r) => r.data as Blob);
}

/** The conversation's current meeting: for a "Meeting confirmed" card written before meetings had ids (26 Oct 2026). */
export function conversationMeetingFile(conversationId: string): () => Promise<Blob> {
  return () => api.get(`/dm/conversations/${encodeURIComponent(conversationId)}/meeting.ics`, { responseType: 'blob' }).then((r) => r.data as Blob);
}
