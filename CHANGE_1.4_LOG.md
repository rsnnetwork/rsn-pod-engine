# RSN Change 1.4 — Full Testing Checklist

Hi! We've shipped a major update. Please test on app.rsn.network — log out and log back in first to get a fresh session.

For each item: **Pass / Fail / Partial** + screenshot if something is off.

---

## 1. Brand Colors
- [ ] Primary buttons (Create Pod, Send Invite Email) are RSN red
- [ ] Sidebar: active page has red left border + light red background
- [ ] Mobile bottom nav: active tab icon/text is red
- [ ] Spinners/loading indicators are red
- [ ] Settings page: toggles glow red when ON
- [ ] Admin filter tabs (Sessions, Pods, Join Requests) are red when active
- [ ] No blue/purple/indigo anywhere on the platform

## 2. Logout Confirmation
- [ ] Click "Log out" → modal asks "Are you sure you want to log out?"
- [ ] Cancel → stays logged in
- [ ] Log Out → logs out, redirects to login
- [ ] Works from mobile menu too

## 3. LinkedIn Field
- [ ] Profile page: type just `stefan-avison` → saves as full URL
- [ ] Paste full URL → still works
- [ ] Placeholder says "username or full LinkedIn URL"
- [ ] Request to Join page: same behavior

## 4. Invite Error Messages
- [ ] Invite existing pod member → "This person is already a member of this pod"
- [ ] Invite existing event participant → "This person is already a participant of this event"
- [ ] Invite someone with pending invite → "This person already has a pending invite"
- [ ] Invite yourself → "You cannot send an invite to yourself"
- [ ] Works from Pod page, Session page, and Invites page

## 5. Invite Landing Page
- [ ] Open invite link in incognito → shows inviter name
- [ ] Shows event/pod name and description
- [ ] Shows date/time for event invites
- [ ] Invalid/expired link shows clear error with icon

## 6. Lobby Gate
- [ ] Participant joins before host starts → "Waiting for host..." screen with clock icon
- [ ] No video tiles in waiting state
- [ ] Participant list visible while waiting
- [ ] Host starts event → transitions to full lobby with video

## 7. Host Presence
- [ ] Participant joins, host not there → "Host is offline" immediately (no false online)
- [ ] Host joins → immediately shows "Host is online"
- [ ] Host briefly refreshes → no "offline" flicker (5s grace period)
- [ ] Host gone 5+ seconds → "Host is offline" appears
- [ ] Participant count stays correct during all transitions

## 8. Chat System
- [ ] Red chat bubble button visible bottom-right (both host + participant)
- [ ] Opens side panel with "Chat | Everyone"
- [ ] Typed text is clearly visible (black) in input
- [ ] Messages appear for all participants in real-time
- [ ] Host messages show amber border + "HOST" label
- [ ] Unread badge on chat button when panel is closed
- [ ] In breakout room, scope changes to "Room"

## 9. Announcement (Host Only)
- [ ] Host clicks speech bubble icon in bottom bar
- [ ] Opens amber input with label "visible as a banner to all participants"
- [ ] Typed text is clearly visible
- [ ] Sent announcement appears as red banner at top for everyone
- [ ] Separate from chat — this is a banner, not a chat message

## 10. Host Match Review
- [ ] Host clicks "Match People" → sees pairing preview (NOT instant round start)
- [ ] Preview shows pairs: "Person A ↔ Person B"
- [ ] "Start Round" to approve and begin
- [ ] "Re-match" to regenerate new pairings
- [ ] "Cancel" to abort
- [ ] Participants don't see preview — only host

## 11. Post-Round Flow
- [ ] After rating → "Rating submitted!" confirmation with checkmark
- [ ] If "meet again" toggled → "We'll let you know if it's mutual"
- [ ] Last round → "Last round complete! Event wrapping up..."
- [ ] Smooth auto-transition back to lobby

## 12. Recap Enhancement
- [ ] Mutual match → heart icon + "Mutual Match!" red badge
- [ ] You said meet again, they didn't → "You expressed interest" (amber)
- [ ] They said meet again, you didn't → "They expressed interest" (blue)
- [ ] "You attended X rounds out of Y total"
- [ ] Works on Event Complete screen AND /recap page
- [ ] Participant also sees recap (not just host)

## 13. Participant Status Tracking
- [ ] Event detail page (host/admin view) → status count tabs above participant list
- [ ] Click a tab to filter participants by status
- [ ] Pending invites count shown

## 14. Session Stability
- [ ] No random logouts — users stay logged in indefinitely
- [ ] Only manual "Log Out" button logs you out
- [ ] Event detail page: host button says "Go Live" (not "Start Event")
- [ ] Host tile first in video grid with amber "Host" badge
- [ ] Mute/Unmute controls on host's own video tile

## 15. Email Branding
- [ ] Magic link email → red heading, red button, "Connect with Reason"
- [ ] Invite email → same red branding
- [ ] Recap email → same red branding (if you complete a full event)
- [ ] No purple gradients anywhere in emails

## 16. Ratings (Trio Fix)
- [ ] Event with 3 or 5 participants → trio room created
- [ ] All 3 people see rating screen after round
- [ ] Each rates 2 partners independently
- [ ] Ratings save without errors

---

## Phase 3 — Pod System Overhaul (2026-03-16)

### 17. Pod Types — Purpose-Based
- [ ] Create pod → Pod Type dropdown shows: Speed Networking, Reason Pod, Conversational, Webinar, Physical Event, Chat Pod, Two-Sided Networking, One-Sided Networking
- [ ] Old pod types (duo, trio, etc.) no longer appear
- [ ] Existing pods show their mapped type (conversational / speed_networking)

### 18. Full Pod Editing
- [ ] Edit Pod modal has: Name, Description, Pod Type, Visibility, Orchestration, Communication, Max Members, Rules
- [ ] Saving type/visibility change is reflected immediately on pod detail

### 19. Duplicate Pod
- [ ] "Duplicate Pod" button opens a pre-filled Create Pod form (not a silent copy)
- [ ] Can edit all fields before creating the duplicate
- [ ] New pod appears in My Pods after create

### 20. Member States
- [ ] Director view shows "Declined" and "No Response" buckets when applicable
- [ ] Pending requests still show with Approve/Reject buttons

### 21. Pod Browse UX
- [ ] Default tab on Pods page is "Active" (not "All")
- [ ] Tab order: Browse All | Active | Archived | All
- [ ] Browse All shows a callout "You're browsing community pods"
- [ ] Visibility badge always shown on all pod cards

### 22. Pod Access Models
- [ ] Creating pod: visibility options include "Public + Approval" and "Request to Join"
- [ ] Pod with "Public + Approval" shows "Request to Join" button (not direct Join)
- [ ] Pod with "Request to Join" shows "Request to Join" button

---

**16 original + 6 Phase 3 items.**

**How to test Phase 3:** Create a new pod → verify new type options → edit it → change type/visibility → try Duplicate Pod → browse as another user → request to join an approval-required pod.

Questions? Reply with screenshots and we'll fix anything immediately.
