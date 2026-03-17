Hi! We've shipped a major update. Please test on app.rsn.network — log out and log back in first to get a fresh session.

  For each item: Pass / Fail / Partial + screenshot if something is off.

  ---
  1. Brand Colors
  - Primary buttons (Create Pod, Send Invite Email) are RSN red
  - Sidebar: active page has red left border + light red background
  - Mobile bottom nav: active tab icon/text is red
  - Spinners/loading indicators are red
  - Settings page: toggles glow red when ON
  - Admin filter tabs (Sessions, Pods, Join Requests) are red when active
  - No blue/purple/indigo anywhere on the platform

  2. Logout Confirmation
  - Click "Log out" → modal asks "Are you sure you want to log out?"
  - Cancel → stays logged in
  - Log Out → logs out, redirects to login
  - Works from mobile menu too

  3. LinkedIn Field
  - Profile page: type just stefan-avison → saves as full URL
  - Paste full URL → still works
  - Placeholder says "username or full LinkedIn URL"
  - Request to Join page: same behavior

  4. Invite Error Messages
  - Invite existing pod member → "This person is already a member of this pod"
  - Invite existing event participant → "This person is already a participant of this event"
  - Invite someone with pending invite → "This person already has a pending invite"
  - Invite yourself → "You cannot send an invite to yourself"
  - Works from Pod page, Session page, and Invites page

  5. Invite Landing Page
  - Open invite link in incognito → shows inviter name
  - Shows event/pod name and description
  - Shows date/time for event invites
  - Invalid/expired link shows clear error with icon

  6. Lobby Gate
  - Participant joins before host starts → "Waiting for host..." screen with clock icon
  - No video tiles in waiting state
  - Participant list visible while waiting
  - Host starts event → transitions to full lobby with video

  7. Host Presence
  - Participant joins, host not there → "Host is offline" immediately (no false online)
  - Host joins → immediately shows "Host is online"
  - Host briefly refreshes → no "offline" flicker (5s grace period)
  - Host gone 5+ seconds → "Host is offline" appears
  - Participant count stays correct during all transitions

  8. Chat System
  - Red chat bubble button visible bottom-right (both host + participant)
  - Opens side panel with "Chat | Everyone"
  - Typed text is clearly visible (black) in input
  - Messages appear for all participants in real-time
  - Host messages show amber border + "HOST" label
  - Unread badge on chat button when panel is closed
  - In breakout room, scope changes to "Room"

  9. Announcement (Host Only)
  - Host clicks speech bubble icon in bottom bar
  - Opens amber input with label "visible as a banner to all participants"
  - Typed text is clearly visible
  - Sent announcement appears as red banner at top for everyone
  - Separate from chat — this is a banner, not a chat message

  10. Host Match Review
  - Host clicks "Match People" → sees pairing preview (NOT instant round start)
  - Preview shows pairs: "Person A ↔ Person B"
  - "Start Round" to approve and begin
  - "Re-match" to regenerate new pairings
  - "Cancel" to abort
  - Participants don't see preview — only host

  11. Post-Round Flow
  - After rating → "Rating submitted!" confirmation with checkmark
  - If "meet again" toggled → "We'll let you know if it's mutual"
  - Last round → "Last round complete! Event wrapping up..."
  - Smooth auto-transition back to lobby

  12. Recap Enhancement
  - Mutual match → heart icon + "Mutual Match!" red badge
  - You said meet again, they didn't → "You expressed interest" (amber)
  - They said meet again, you didn't → "They expressed interest" (blue)
  - "You attended X rounds out of Y total"
  - Works on Event Complete screen AND /recap page
  - Participant also sees recap (not just host)

  13. Participant Status Tracking
  - Event detail page (host/admin view) → status count tabs above participant list
  - Click a tab to filter participants by status
  - Pending invites count shown

  14. Session Stability
  - No random logouts — users stay logged in indefinitely
  - Only manual "Log Out" button logs you out
  - Event detail page: host button says "Go Live" (not "Start Event")
  - Host tile first in video grid with amber "Host" badge
  - Mute/Unmute controls on host's own video tile

  15. Email Branding
  - Magic link email → red heading, red button, "Connect with Reason"
  - Invite email → same red branding
  - Recap email → same red branding (if you complete a full event)
  - No purple gradients anywhere in emails

  16. Ratings (Trio Fix)
  - Event with 3 or 5 participants → trio room created
  - All 3 people see rating screen after round
  - Each rates 2 partners independently
  - Ratings save without errors

--------------------------------------------------------------------------------------------

  17. Pod Types
  - Click "Create Pod" → Pod Type dropdown shows: Speed Networking, Reason Pod, Conversational, Webinar, Physical Event, Chat Pod, Two-Sided Networking, One-Sided Networking
  - Old types (duo, trio, kvartet, band, orchestra, concert) are gone
  - Any pod you created before will now show "Conversational" or "Speed Networking" depending on what it was

  18. Full Pod Editing
  - Open any pod you own → click "Edit Pod"
  - Modal now has all fields: Name, Description, Pod Type, Visibility, Orchestration Mode, Communication Mode, Max Members, Rules
  - Change the type or visibility → save → detail page updates immediately

  19. Duplicate Pod
  - Open any pod you own → click "Duplicate Pod"
  - A pre-filled Create Pod form opens (all fields copied from the original)
  - Edit anything you want → confirm → new pod appears in My Pods

  20. Member States (deferred)
  - Database supports "Declined" and "No Response" member statuses
  - UI display is ready but requires decline invite flow + no-response detection to be built first
  - Will be completed in a future phase

  21. Pod Browse
  - Go to the Pods page → default tab is "Active" (your own active pods)
  - Tab order: Browse All | Active | Archived | All
  - Click "Browse All" → banner appears: "You're browsing community pods"
  - Every pod card shows a visibility badge (Public, Invite Only, etc.)

  22. Pod Access Models
  - Create a pod → Visibility dropdown now includes "Public + Approval" and "Request to Join"
  - Set a pod to "Public + Approval" → other users see "Request to Join" (not instant Join)
  - Set a pod to "Request to Join" → same button appears for others
  - Public pod → others still see the plain "Join Pod" button

-----------------------------------------------------------------

  23. Profile Matching Fields
  - Go to Profile → scroll down to "Matching Profile" section
  - Six new text fields: What I care about, What I can help with, Who I want to meet, Why I want to meet them, My intent, Expertise (detailed)
  - Fill them in → save → reload → values persist
  - These fields will feed future AI-based matching

  24. Profile Card
  - Open any pod → Members section now shows richer cards (photo, name, job title, company, interest tags)
  - Lobby → host participant panel shows the same compact cards
  - Profile photos now appear everywhere (not just initials) — pods, sessions, recap, encounters, admin

  25. Premium Pre-Selection (foundation)
  - Database and API are ready for "pick up to 12 preferred people" per event
  - No UI selection screen yet — coming when matching engine wires it in

  26. Invite Limits
  - Standard users are limited to 10 invites per day (from entitlements table)
  - Admins bypass this limit
  - If you hit the limit → clear error message: "You can send up to 10 invites per day"

  27. Invite Permissions
  - Standard users can only invite people they've met before (encounter history) or share a pod with
  - Admins can invite anyone
  - If you try to invite a stranger → "You can only invite people you've met or share a pod with"

  28. Invite Opt-Out
  - Go to Settings → Privacy section
  - New toggle: "Opt out of public event invites"
  - When ON, you won't receive invites to public recurring events

  29. Request to Join — Rules
  - If a pod director sets rules text in joinConfig, users see a rules modal before requesting
  - Must check the agreement checkbox before the request goes through
  - If no rules are set, request goes through immediately (same as before)

-----------------------------------------------------------------
  Phase 6 — Admin Power-Up (2026-03-17)
-----------------------------------------------------------------

  30. Event Type Selector
  - Go to Events → Schedule an Event
  - New dropdown: Event Type — Speed Networking, Video Meeting, Voice Meeting, Webinar, Physical Event
  - Date and time now default to the current time (rounded to next 15 minutes)

  31. Admin Dashboard — Real Stats
  - Go to Admin → dashboard now shows real numbers
  - Total Users, Active Users (last 7 days), Pods, Events, Matches, Avg Rating
  - 30-day user growth bar chart (hover bars to see daily counts)

  32. Bulk Actions
  - Admin → Users: checkboxes on each user row, "Select All" at the top
  - Select multiple → floating bar appears with Bulk Suspend / Bulk Ban / Bulk Reactivate
  - Admin → Join Requests: same pattern with Bulk Approve / Bulk Decline

  33. User Entitlements
  - Admin → Users → click "Limits" button on any user
  - Modal shows: Max Pods Owned, Max Sessions/Month, Max Invites/Day, Can Host Events, Can Create Pods
  - Edit and save — limits are enforced immediately

  34. Moderation Queue
  - Admin → Moderation Queue (new page)
  - Shows all user reports with Open / Actioned / Dismissed filters
  - Click "Review" → choose action: Dismiss, Warn, Suspend, or Ban
  - Suspend/Ban automatically updates the user's status

  35. Matching Templates
  - Admin → Matching Templates (new page)
  - Create templates with scoring weight sliders: Industry, Interests, Intent, Experience, Location
  - Configure: rematch cooldown, exploration level, same-company matches, fallback strategy
  - Default template is pre-seeded — can't be deleted
  - Templates can be assigned to pods (foundation for matching engine)

  36. Email Controls
  - Admin → Email Controls (new page)
  - Toggle each email type on/off: Magic Link, Pod Invite, Event Invite, Platform Invite, Recap, Join Request Approved/Declined
  - Shows description and subject line for each email type
  - Warning: disabling Magic Link blocks login for all users

-----------------------------------------------------------------

  37. Database Integrity Fixes
  - Deleting a user who invited others no longer throws an error (FK violation fixed)
  - Added performance indexes for rating history, match orchestration, and encounter recap queries
  - Migration 022 runs automatically on next server startup — no manual action needed

-----------------------------------------------------------------

Questions? Reply with screenshots and we'll fix anything immediately.