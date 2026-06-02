# RSN Test Script — Screens → Clicks (QA)

**Living document. For testers.** Walk the app top to bottom, screen by screen. For each screen, check what loads, then click each control and confirm what happens. Log anything that looks off in the [Issue Register](./issue-register.md) against the screen it happened on.

- **Last updated:** 2026-05-30
- **How to read it:** each screen lists `[ ]` checks. The left side is what you do, "Expect:" is what should happen. Coarse first (does the screen load), then fine (each button).
- **No code here on purpose.** This is the tester's view. The engineering side (which code owns each screen) lives in the separate Component & Dependency Map.
- Tick a box if it behaves; if not, log it in the register with the screen name and what you saw.

---

## PART 1 — Getting in

### Screen: Login
Should load: email field, "continue with Google" button, and a "request to join" link.
- [ ] Enter your email and submit. Expect: a confirmation that a magic link was sent (no password step exists).
- [ ] Click "Continue with Google". Expect: Google sign-in, then you land back logged in. (If Google isn't configured it should fail cleanly, not hang.)
- [ ] Click "Request to join". Expect: the request-to-join form opens.
- [ ] Open a fresh invite link while logged out. Expect: you're sent to login first, then back to the invite after signing in.

### Screen: Verify (magic link)
Should load: a short "verifying" state after clicking the emailed link.
- [ ] Click the magic link from your email. Expect: you're signed in and taken into the app.
- [ ] Click an old/used magic link. Expect: a clear "link expired or already used" message, not a blank page.

### Screen: Request to join
Should load: name, email, LinkedIn, and reason fields.
- [ ] Submit with everything filled. Expect: a "request received" confirmation.
- [ ] Submit with a field blank. Expect: it stops you and points at the missing field.

### Screen: Onboarding wizard (3 steps)
Should load: Step 1 "About You", then Goals, then reasons to connect.
- [ ] Try to go Next with a required field empty. Expect: it blocks you and shows what's missing.
- [ ] Complete all 3 steps. Expect: you land on the home dashboard and onboarding doesn't show again.

---

## PART 2 — Your account

### Screen: Home / dashboard
Should load: stat cards (pods, invites, upcoming events), quick actions, and a getting-started checklist.
- [ ] Watch the page load. Expect: the cards fill with your real numbers, no permanent "loading".
- [ ] If you have pending invites, look for the banner. Expect: a banner that takes you to Invites.
- [ ] Click each stat card. Expect: My Pods → pods, Invites → invites, Upcoming Events → events.
- [ ] Click each quick action (Create Pod, Send Invite, View Events). Expect: each opens the right screen.

### Screen: Profile (your own)
Should load: your editable details, tags, and avatar.
- [ ] Change a field. Expect: the Save button enables only after you edit something.
- [ ] Save. Expect: a success confirmation and the change sticks after refresh.
- [ ] Add and remove a tag (interests / languages). Expect: chips add and remove, and save with the profile.
- [ ] Upload an avatar (JPG/PNG/WebP). Expect: it previews and saves. Try a too-large or wrong-type file. Expect: a clear validation message.
- [ ] Check the email field. Expect: it's read-only and can't be changed.

### Screen: Public profile (someone else)
Should load: their details in read-only form.
- [ ] Open another member's profile. Expect: their info loads, nothing editable.
- [ ] Look for the Message button. Expect: it's only enabled if you've shared an event with them before.

### Screen: Settings
Should load: notification toggles, privacy toggles, messaging-notification toggles, and read-only account info.
- [ ] Toggle a notification or privacy switch and click Save. Expect: a confirmation and the setting holds after refresh.
- [ ] Toggle a per-channel messaging switch (these save instantly, no Save button). Expect: it holds after refresh.

### Screen: Billing
Should load: Starter and Pro plan cards plus a "billing not active yet" notice.
- [ ] Click Upgrade. Expect: nothing happens yet (this is intentionally not built). Confirm the "coming soon" notice is shown and nothing looks broken.

---

## PART 3 — Connecting

### Screen: Invites
Should load: a way to create a link, send to email, bulk-invite, and a list of sent + received invites.
- [ ] Create a shareable link. Expect: a copyable link is produced.
- [ ] Send an invite to an email. Expect: it appears in your sent list as pending.
- [ ] Bulk-invite (search people you've met, select, send). Expect: search returns only people you've shared an event with; sends go out.
- [ ] Revoke a sent invite. Expect: it moves to revoked and the link stops working.
- [ ] Filter the sent list (all / pending / accepted / declined). Expect: the list filters correctly.
- [ ] Open a received invite and Accept. Expect: you're registered and taken to the event/landing.
- [ ] Open a received invite and Decline. Expect: it's marked declined.
- [ ] Open an expired / already-used / invalid invite link. Expect: a clear matching error, not a blank page.

### Screen: Join-request review (admin)
Should load: a list of requests with filters.
- [ ] Approve and decline a single request (with a note). Expect: status updates and the applicant is notified.
- [ ] Bulk approve / decline. Expect: all selected update.
- [ ] Poke an applicant. Expect: a reminder sends, and a second poke within 24h is blocked.
- [ ] Use the email approve/reject link. Expect: it shows the request, and only the confirm step actually approves/rejects.

### Screen: Notifications (bell)
Should load: a bell with an unread count.
- [ ] Trigger a notification (e.g. receive an invite). Expect: it appears without a manual refresh.
- [ ] Open the bell. Expect: the list and unread count show.
- [ ] Mark one read, then mark all read. Expect: counts drop correctly.
- [ ] Click a notification. Expect: it takes you to the right place (event / pod / invite).
- [ ] Accept/Decline a pending-invite notification inline. Expect: it actions without leaving the bell.

### Screen: Messages (DM)
Should load: a conversation list with unread counts.
- [ ] Open a conversation. Expect: the thread and history load.
- [ ] Send a message. Expect: it appears instantly for both sides.
- [ ] Start a DM from a profile. Expect: only allowed if you've shared an event; otherwise the button is disabled.
- [ ] React / unreact to a message. Expect: the reaction shows and clears.
- [ ] Open a thread you've read. Expect: read receipts ("seen") show correctly.

---

## PART 4 — The live event (as a participant)

> This is the highest-risk area. Test it with several people at once, not just one browser.

### Screen: Joining / Lobby (main networking room)
Should load: your camera tile, mic/camera controls, and the other people who are present.
- [ ] Join the event. Expect: you appear in the lobby and others see you join.
- [ ] Check the participant count against who's actually there. Expect: the number matches the real people in the room.
- [ ] Toggle your mic and camera. Expect: they turn on/off and stay where you set them.
- [ ] Change your background / blur. Expect: it applies and you stay in the event (you should not get kicked out).
- [ ] Switch layout (compact / normal / spacious). Expect: tiles rearrange and you can still scroll to see everyone, even with many people.
- [ ] Pin a participant. Expect: they spotlight, and nobody gets muted as a side effect.
- [ ] Open the participant list. Expect: it matches who's actually in the room.
- [ ] Click "Leave event". Expect: you leave cleanly.

### Screen: Matching / "you've been matched" (round flow)
Should load: a matching state, then your assigned partner(s).
- [ ] When the host starts matching, watch the overlay. Expect: a clear "matching" then "you've been matched" state.
- [ ] Check who you're matched with. Expect: a person who is actually present, never someone absent.

### Screen: Breakout / conversation room
Should load: your partner's video and your own, plus a round timer.
- [ ] Enter the room. Expect: you see your partner; if they haven't joined yet, a clear "waiting for partner" that clears once they arrive.
- [ ] Watch the timer. Expect: it counts down and shows the same value for both people.
- [ ] Watch the round end. Expect: a visible warning/countdown before it ends, not a sudden cut-off.
- [ ] If your partner leaves. Expect: a clear notice and an auto-return to the main room.
- [ ] Click "Return to main room". Expect: you go back to the lobby but stay in the event.
- [ ] Click "Leave event" (the other leave action). Expect: it's clearly different from "return to main room" and ideally confirms before fully exiting.

### Screen: Rating
Should load: a prompt to rate the person/people you just met.
- [ ] Rate a partner (stars) and submit. Expect: it accepts and moves on.
- [ ] In a group room (3 people), check you can rate each other person. Expect: one rating per other participant, not just one total.
- [ ] Skip a rating. Expect: it's allowed and doesn't re-prompt you for the same person.

### Screen: Session complete
Should load: a wrap-up state when the event ends.
- [ ] Reach the end of the event. Expect: a clear "complete" screen, not a frozen room.

---

## PART 5 — The live event (as a host)

### Screen: Host control bar
Should load: host buttons along the bottom during the event.
- [ ] Start the event. Expect: the event opens for participants.
- [ ] Run the match flow (Match People → preview → Confirm → Start Round). Expect: you can preview, swap or exclude people, then start.
- [ ] Pause and resume the timer. Expect: it pauses for everyone and resumes.
- [ ] Extend the round (+2 min) and end the round early. Expect: both take effect for everyone.
- [ ] Create breakout rooms. Expect: rooms are created with your chosen duration.
- [ ] Send a broadcast/announcement. Expect: all participants see it.
- [ ] End the event. Expect: everyone is moved to the wrap-up.

### Screen: Host Control Center
Should load: the participant list with per-person actions.
- [ ] Re-match, move to a room, or remove a participant. Expect: each takes effect and the person sees the change.
- [ ] Make someone a co-host, then remove co-host. Expect: their role changes and is reflected.
- [ ] Try to set up a co-host before starting the event. Expect: you can (watch for this being blocked — it's a known weak spot).
- [ ] Filter the list (in main room / in a room / disconnected / left). Expect: the filters group people correctly.

---

## PART 6 — Admin

### Screen: Admin → Users
Should load: a searchable, filterable user list.
- [ ] Search and filter (active / removed / banned, by role). Expect: the list responds.
- [ ] Change a user's role. Expect: it updates; admin/super-admin roles can only be granted by a super-admin.
- [ ] Suspend / ban / reactivate a user. Expect: status changes.
- [ ] (Super-admin) Permanently delete a user. Expect: only available to super-admin.

### Screen: Admin → Events
Should load: the events list with filters.
- [ ] Cancel an event. Expect: it cancels; a non-host non-admin should not be able to.
- [ ] (Super-admin) Permanently delete an event. Expect: only available to super-admin.

### Screen: Admin → Moderation (reports)
Should load: the reports/violations queue.
- [ ] Resolve a report (dismiss / warn / suspend / ban with notes). Expect: the action applies to the reported user.

### Screen: Admin → Join requests
Should load: the pending-requests dashboard.
- [ ] Approve / decline (single and bulk). Expect: statuses update and applicants are notified.

---

## After a test session
1. Make sure every odd thing you saw is in the [Issue Register](./issue-register.md), tagged to the screen.
2. If the same thing was already logged, add to its tally instead of a new row.
3. Hand the register to engineering — they use the Component & Dependency Map to find the cause and any knock-on effects.
