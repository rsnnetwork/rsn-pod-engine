// ─── A time zone a clock can actually show ───────────────────────────────────
//
// Screen 7 of the onboarding brief shows "Time zone: Asia/Kathmandu [Change]",
// detected by the browser. What reaches the server must be a real IANA zone:
// meeting times are rendered in it (meeting-windows.service, email.service),
// and an invented one would throw there.
//
// 11 Nov 2026 (Part 3 Task 1): the check moved to shared/src/events/event-time.ts,
// so an event's zone, a member's zone and the client's forms share one rule. This
// name stays for the onboarding callers.

export { canonicalTimeZone } from '@rsn/shared';
