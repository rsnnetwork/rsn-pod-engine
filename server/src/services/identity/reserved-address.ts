// ─── Addresses no person can have (21 Oct 2026) ──────────────────────────────
//
// example.com, example.net and example.org, and every domain under .test, .example, .invalid and
// .localhost, are reserved for documentation and testing (RFC 2606, RFC 6761), so no mailbox there
// can belong to a person. Production end-to-end runs sign members up on them
// (e2etest-…@example.com, …@rsn-e2e.invalid, loadtest_…@rsn-test.invalid) and delete them minutes
// later, so nothing should ever be announced to real members about such an account.
//
// 26 Oct 2026: nor is the mail provider asked to send to them (sendEmail), which spent the production quota on the
// same runs. A recipient may come with a display name ("Ana" <ana@x.invalid>), which the provider accepts, so the
// address is read out of it before it is judged.

const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];
const RESERVED_TOP_LEVEL = ['test', 'example', 'invalid', 'localhost'];

/** The address itself: `"Ana" <ana@x.invalid>` is `ana@x.invalid`, and an address without a display name is itself. */
function bareAddress(recipient: string): string {
  const text = recipient.trim();
  const open = text.lastIndexOf('<');
  if (!text.endsWith('>') || open < 0) return text;
  return text.slice(open + 1, -1).trim();
}

/** True when `email` (or the address inside a display name around it) is on a reserved domain or one of its subdomains. */
export function isReservedTestAddress(email: string | null | undefined): boolean {
  const address = bareAddress(email ?? '').toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 0) return false;
  const domain = address.slice(at + 1).replace(/\.$/, '');
  if (!domain) return false;
  if (RESERVED_DOMAINS.some((reserved) => domain === reserved || domain.endsWith(`.${reserved}`))) return true;
  return RESERVED_TOP_LEVEL.includes(domain.slice(domain.lastIndexOf('.') + 1));
}

/**
 * "a•••@x.invalid": the first letter of the address and its domain, which is all a log line says of it. Something that
 * is not an address shows nothing of itself. The same shape as the invite service's maskEmail, which this file cannot
 * import: that service imports the email service, and the email service imports this file.
 */
export function maskAddress(recipient: string): string {
  const address = bareAddress(recipient);
  const at = address.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${address.slice(0, 1)}•••${address.slice(at)}`;
}
