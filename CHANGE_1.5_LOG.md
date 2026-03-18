Hi! We've shipped Change 1.5 — a major live event UX overhaul. Please test on app.rsn.network — log out and log back in first to get a fresh session.

  For each item: Pass / Fail / Partial + screenshot if something is off.

  ---

  1. Event State Banner
  - Join any live event → persistent banner at top always shows current state
  - Before host starts: "Waiting for participants"
  - Host starts event: "Host introduction in progress"
  - Host clicks Match: "Matching participants"
  - Round begins: "Round 1 Live" (updates for Round 2, 3, etc.)
  - Between rounds: "Back in lobby"
  - Event ends: "Event completed"
  - Banner never disappears — always visible throughout the event

  2. Chat Open by Default
  - Join any event → chat panel is already open on the right side
  - No need to click the chat button to open it
  - Close it manually → stays closed (toggle still works)

  3. Clickable Links in Chat
  - Send a message containing a URL (e.g. https://rsn.network) → appears as a clickable blue link
  - Click the link → opens in new tab
  - Host sends announcement with a URL → link is clickable in the banner too
  - Plain text messages still render normally

  4. Recap — Round-by-Round Grouping
  - Complete an event with 2+ rounds → go to recap
  - Connections grouped under clear section headers: "Round 1", "Round 2", "Round 3"
  - Each section shows who you met in that specific round
  - Not a flat list anymore — visually separated sections

  5. Recap — Clickable Profiles
  - On the recap page → click any participant's name or avatar
  - Opens their profile page
  - Works on both the Event Complete screen and the /recap page

  6. Rating — No More Dead Time
  - After a round ends, submit your rating
  - If all participants in the round have rated → immediately moves to lobby (no waiting)
  - You should NOT be stuck on "Waiting for next round..." if everyone already rated
  - If some people haven't rated yet → normal countdown continues

  7. Leave Round / Leave Event
  - During a breakout round → two separate buttons visible:
    a) "Leave Round" → returns you to the lobby, stays in event, can be rematched next round
    b) "Leave Event" → exits the event entirely
  - Your partner sees a notification that you left the conversation
  - After round ends → participants return to lobby instantly (no transition delay)

  8. Auto-Return if Alone
  - Your partner leaves the breakout room (via "Back to Lobby" or disconnect)
  - After a few seconds → you automatically return to the lobby
  - Message shown: "Your partner left — returning to lobby"
  - You're added to the rematch pool for the next round

  9. Matching Anticipation Screen
  - Host clicks "Start Round" → participants see a full-screen overlay
  - Animated graphic with "Matching people..." → "X breakout rooms created!"
  - Host does NOT see this overlay — they stay on the dashboard
  - Then participants transition into breakout rooms

  10. Emoji Reactions
  - During event (lobby or breakout room) → reaction buttons visible
  - Raise Hand: click → hand icon appears on your video tile, stays until dismissed
  - Heart: click → brief heart animation on your tile
  - Clap: click → brief clap animation on your tile
  - Host can see raised hands in participant panel
  - Reactions visible to everyone in the same room/lobby

  11. Participant List Sidebar
  - During any phase of the event → toggle a "Participants" sidebar
  - Shows all participants with: name, avatar, status (in lobby / in room / disconnected)
  - Available to all users (not just host)
  - Updates in real-time as people join, leave, or move between rooms

  12. Co-Host / Moderator Delegation
  - Host → participant panel → click the shield icon next to a user to promote to Co-Host
  - Co-host gets the full host controls bar: Match People, Start Round, Pause, End, Broadcast, Invite
  - Co-hosts are excluded from matching (they're hosts, not participants)
  - Co-host status updates in real-time (no refresh needed)
  - Only the original host can promote/demote co-hosts
  - Works even after the event has started

  13. Add People During Live Event
  - Host → "Invite" button available during lobby or between rounds
  - Opens the session invite page in a popup window (host stays in the live event)
  - Can send email invites, search platform users, or generate shareable links
  - New participants join into lobby (not into an active round)
  - Does NOT require ending or restarting the event

  14. Select All in Invites (Events + Pods)
  - Invite platform users to an event OR a pod → platform user search
  - "Select All" checkbox at the top of search results (both event and pod invites)
  - Multi-select still works (checkboxes per user)
  - Bulk invite button shows count: "Send X Invite(s)"
  - Already-registered/members show as disabled with badge

  15. Unified Host Dashboard
  - Host → during event → always-visible status summary:
    "X in lobby | X in rooms | X disconnected | X left"
  - Updates in real-time
  - Available in all event phases (not just during rounds)

  16. Post-Event Feedback Prompt
  - After event completes → below the recap, text input appears
  - Prompt: "Is there anything you want to add?"
  - This is for overall event feedback (not per-round)
  - Submit → feedback saved
  - Host can view all participant feedback in their recap

  17. Host Event-Wide Recap
  - Host → recap page → host-specific view showing:
    - Full round breakdown: who matched with whom in every room
    - Participation stats per user
    - All collected feedback
    - Formatted export (not raw JSON)

  18. Virtual Background (Blur)
  - In a breakout room → sparkles icon button in the video controls bar
  - Click it → your background blurs
  - Click again → blur turns off
  - Note: requires a package install on deploy — button may not work yet on production

  19. Notifications Center
  - Bell icon in the left sidebar (desktop) and top bar (mobile)
  - Red badge shows how many unread notifications you have
  - New notifications appear instantly (real-time push, no refresh needed)
  - Invite notifications (pod + event) show inline Accept / Decline buttons
  - Accept → joins the pod/event and navigates there. Decline → removes invite
  - Already accepted shows "Accepted" label, declined shows "Declined"
  - Clicking an accepted notification → goes to that pod/event page
  - Clicking a declined/expired notification → shows a toast, no navigation
  - "Mark all read" button at the top of the dropdown
  - All actions update the Invites page and Dashboard pending count immediately

  20. Pin / Highlight Speaker
  - In a breakout room → click any participant's video tile to pin them
  - Pinned tile expands larger (takes up most of the screen)
  - Other participants show as small tiles at the bottom
  - Click the pinned tile again to unpin and return to normal grid
  - Only one person can be pinned at a time

  21. Layout Density Toggle
  - In the lobby → small toggle appears with 3 options: Compact / Normal / Spacious
  - Compact: smaller video tiles, fits more people per row (good for 15+ people)
  - Normal: the default layout (what you see today)
  - Spacious: bigger video tiles, fewer per row (good for small groups under 10)
  - Preference resets when you leave the event

  22. Dark Theme — Live Event Pages
  - All live event screens now use a dark Google Meet-style theme
  - Lobby, video room, rating, recap, host dashboard — all dark
  - Chat panel and participant list sidebars — dark with readable text
  - Feedback textarea and chat input use white background so typed text is always visible

  23. Invite Email Mismatch Fix
  - Accept an invite link while logged in with a different email → clear error message shown
  - Shows which email you're signed in as
  - "Log Out & Sign In with Correct Email" button — logs you out and redirects back to the invite

  24. Host Dashboard — Round Monitoring
  - During an active round, host sees a live dashboard with all breakout rooms
  - Each room card shows: participant names, connection status (green/red), room status (Live/Disconnected)
  - Dashboard persists through page refresh (host can reload without losing the view)
  - Host stays in lobby view when no dashboard data is available yet

  ---

Questions? Reply with screenshots and we'll fix anything immediately.
