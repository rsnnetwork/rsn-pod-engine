// ─── L4 (26 Oct 2026, production's own client): a group-chat link lands on Messages, not a dead page ──
//
// The server now sends group-chat bells whose link is /messages/g/<groupId> (the group screen is on the preview).
// Production's client has no group screen, and no route for that address: the bell would open its "not found" page.
// Until the preview goes live, the address redirects to /messages, where the member's conversations are. It sits
// inside the signed-in layout, so someone who is signed out signs in first and then lands on Messages; and it
// replaces the entry in the history, so Back does not return to the address that redirected.

import { readClientSource } from './load-client-module';

const app = () => readClientSource('App.tsx');

describe('L4 - /messages/g/:groupId redirects to /messages on production', () => {
  it('there is a route for a group-chat address, and it navigates to /messages', () => {
    expect(app()).toMatch(/<Route path="\/messages\/g\/:groupId" element=\{<Navigate to="\/messages" replace \/>\} \/>/);
  });

  it('replaces the history entry, so Back does not return to the address that redirected', () => {
    const route = app().match(/<Route path="\/messages\/g\/:groupId"[^\n]*/)![0];
    expect(route).toContain('replace');
  });

  it('is inside the signed-in layout, with the other Messages routes, so a signed-out member signs in first', () => {
    const src = app();
    const layoutStart = src.indexOf('<Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>');
    const layoutEnd = src.indexOf('</Route>', layoutStart);
    expect(layoutStart).toBeGreaterThan(0);
    const group = src.indexOf('<Route path="/messages/g/:groupId"');
    expect(group).toBeGreaterThan(layoutStart);
    expect(group).toBeLessThan(layoutEnd);
  });

  it('the other Messages routes are as they were: the list, composing a new one, and a conversation by id', () => {
    const src = app();
    expect(src).toMatch(/<Route path="\/messages" element=\{<MessagesPage \/>\} \/>/);
    expect(src).toMatch(/<Route path="\/messages\/new\/:userId" element=\{<MessagesPage \/>\} \/>/);
    expect(src).toMatch(/<Route path="\/messages\/:conversationId" element=\{<MessagesPage \/>\} \/>/);
  });
});
