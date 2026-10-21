// ─── A time zone a clock can actually show ───────────────────────────────────
//
// Screen 7 of the onboarding brief shows "Time zone: Asia/Kathmandu [Change]",
// detected by the browser. What reaches the server must be a real IANA zone:
// meeting times are rendered in it (meeting-windows.service, email.service),
// and an invented one would throw there. The check is the runtime's own: a zone
// is real when Intl.DateTimeFormat accepts it. Offsets ("+05:45") are refused
// even where the runtime accepts them, because they are not zones and do not
// follow summer time.

const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const MAX_LEN = 50;

let listed: readonly string[] | null = null;
function listedZones(): readonly string[] {
  if (!listed) {
    try {
      listed = Intl.supportedValuesOf('timeZone');
    } catch {
      // A runtime without the list still validates through DateTimeFormat below.
      listed = [];
    }
  }
  return listed;
}

/**
 * The zone, spelled as the runtime's zone list spells it when it is on that
 * list (case aside), else as given; null when it is not a real zone. Both
 * spellings of a renamed zone ("Asia/Kathmandu", "Asia/Katmandu") are real.
 */
export function canonicalTimeZone(input: string | null | undefined): string | null {
  const tz = (input ?? '').trim();
  if (!tz || tz.length > MAX_LEN || !IANA_SHAPE.test(tz)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return null;
  }
  const lower = tz.toLowerCase();
  return listedZones().find(z => z.toLowerCase() === lower) ?? tz;
}
